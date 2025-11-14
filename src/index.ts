import * as core from '@actions/core';
import * as github from '@actions/github';

interface Job {
  name: string;
  status: 'success' | 'failure' | 'cancelled' | 'skipped' | 'unknown';
  duration_seconds: number;
  started_at?: string;
  completed_at?: string;
  log_url?: string;
}

interface WorkflowMetrics {
  provider: 'github';
  workflow_run_id: number;
  workflow_name: string;
  repository: string;
  status: 'success' | 'failure' | 'cancelled' | 'running' | 'queued' | 'unknown';
  mode: 'inline' | 'external';
  started_at: string;
  completed_at?: string;
  triggered_by: string;
  actor: string;
  jobs: Job[];
}

function mapWorkflowStatus(status: string | null, conclusion: string | null): WorkflowMetrics['status'] {
  if (status === 'completed' && conclusion && ['success', 'failure', 'running', 'queued'].includes(conclusion)) {
    return conclusion as WorkflowMetrics['status'];
  }
  return 'unknown';
}

function mapJobStatus(status: string, conclusion: string | null): Job['status'] {
  if (status === 'completed' && conclusion && ['success', 'failure', 'cancelled', 'skipped'].includes(conclusion)) {
    return conclusion as Job['status'];
  }
  return 'unknown';
}

async function getCurrentJobId(
  octokit: Awaited<ReturnType<typeof github.getOctokit>>['rest'],
  owner: string,
  repo: string,
  runId: number,
  currentJobName: string,
  runnerName?: string
): Promise<number | undefined> {
  try {
    const { data: jobs } = await octokit.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
    });

    // Find all jobs matching the current job name
    const matchingJobs = jobs.jobs.filter((job: { name: string; runner_name?: string | null }) => {
      return job.name === currentJobName;
    });

    if (matchingJobs.length === 0) {
      core.warning(`No jobs found matching current job name: ${currentJobName}`);
      return undefined;
    }

    // If there's exactly one match, use it (safe to filter)
    if (matchingJobs.length === 1) {
      return matchingJobs[0].id;
    }

    // If there are multiple jobs with the same name, try to match by runner name
    if (runnerName) {
      const runnerMatch = matchingJobs.find((job: { runner_name?: string | null }) => {
        return job.runner_name === runnerName;
      });

      if (runnerMatch) {
        return runnerMatch.id;
      }

      core.warning(
        `Multiple jobs found with name "${currentJobName}" but none match runner "${runnerName}". ` +
        `Not filtering to avoid false positives.`
      );
      return undefined;
    }

    // Multiple matches but no runner name - don't filter to avoid false positives
    core.warning(
      `Multiple jobs found with name "${currentJobName}" (${matchingJobs.length} matches). ` +
      `Not filtering to avoid false positives.`
    );
    return undefined;
  } catch (error) {
    // If we can't identify the current job, return undefined (won't filter)
    core.warning(`Could not identify current job ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return undefined;
  }
}

async function fetchWorkflowRun(
  octokit: Awaited<ReturnType<typeof github.getOctokit>>['rest'],
  owner: string,
  repo: string,
  runId: number,
  excludeJobId?: number
): Promise<WorkflowMetrics> {
  const { data: run } = await octokit.actions.getWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });

  console.log('WORKFLOW RUN:', run);

  const { data: jobs } = await octokit.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });

  console.log('WORKFLOW RUN JOBS:', jobs);

  // Filter out the current job if excludeJobId is provided (inline mode)
  // Only filter by numeric job ID to avoid false positives
  const filteredJobs = excludeJobId
    ? jobs.jobs.filter((job: { id: number }) => job.id !== excludeJobId)
    : jobs.jobs;

  const jobMetrics: Job[] = filteredJobs.map((job: { name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null; html_url: string | null }) => {
    const startedAt = job.started_at ? new Date(job.started_at) : undefined;
    const completedAt = job.completed_at ? new Date(job.completed_at) : undefined;
    const durationSeconds = startedAt && completedAt
      ? Math.floor((completedAt.getTime() - startedAt.getTime()) / 1000)
      : 0;

    return {
      name: job.name,
      status: mapJobStatus(job.status, job.conclusion),
      duration_seconds: durationSeconds,
      started_at: job.started_at || undefined,
      completed_at: job.completed_at || undefined,
      log_url: job.html_url || undefined,
    };
  });

  const workflowStatus = mapWorkflowStatus(run.status, run.conclusion);

  return {
    provider: 'github',
    workflow_run_id: run.id,
    workflow_name: run.name || run.workflow_id.toString(),
    repository: `${owner}/${repo}`,
    status: workflowStatus,
    mode: github.context.eventName === 'workflow_run' ? 'external' : 'inline',
    started_at: run.created_at,
    completed_at: run.updated_at || undefined,
    triggered_by: run.event || 'unknown',
    actor: run.actor?.login || 'unknown',
    jobs: jobMetrics,
  };
}

async function sendMetrics(apiUrl: string, apiKey: string, metrics: WorkflowMetrics, dryRun: boolean): Promise<void> {
  const jsonPayload = JSON.stringify(metrics, null, 2);

  if (dryRun) {
    core.info('=== DRY RUN MODE: JSON Payload ===');
    core.info(jsonPayload);
    core.info('=== END JSON Payload ===');
    return;
  }

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: jsonPayload,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to send metrics: ${response.status} ${response.statusText} - ${errorText}`);
  }

  core.info(`Successfully sent metrics for workflow run ${metrics.workflow_run_id}`);
}

async function run(): Promise<void> {
  try {
    const apiUrl = core.getInput('api_url', { required: true });
    const apiKey = core.getInput('api_key', { required: true });
    const workflowRunIdInput = core.getInput('workflow_run_id');
    const dryRunInput = core.getInput('dry_run');
    const dryRun = dryRunInput === 'true' || dryRunInput === 'True' || dryRunInput === 'TRUE';

    console.log('ENVIRONMENT VARIABLES:', process.env);

    // GITHUB_TOKEN must be explicitly passed as an environment variable when using local actions (uses: ./)
    // In the workflow, add: env: GITHUB_TOKEN: ${{ github.token }}
    // For published actions, GITHUB_TOKEN is automatically available
    const token = process.env.GITHUB_TOKEN || '';

    if (!token) {
      throw new Error(
        'GITHUB_TOKEN is not set. When using a local action (uses: ./), you must explicitly pass it:\n' +
        '  - uses: ./\n' +
        '    env:\n' +
        '      GITHUB_TOKEN: ${{ github.token }}\n' +
        '    with:\n' +
        '      ...\n\n' +
        'Also ensure your workflow has the required permissions:\n' +
        '  permissions:\n' +
        '    actions: read\n' +
        '    contents: read'
      );
    }

    // Use getOctokit which is the recommended way, then access .rest for the Octokit instance
    const octokit = github.getOctokit(token).rest;
    const context = github.context;

    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const runId = workflowRunIdInput
      ? parseInt(workflowRunIdInput, 10)
      : context.runId;

    if (isNaN(runId)) {
      throw new Error(`Invalid workflow_run_id: ${workflowRunIdInput}`);
    }

    core.info(`Fetching metrics for workflow run ${runId} in ${owner}/${repo}`);
    if (dryRun) {
      core.info('DRY RUN MODE: Will log JSON payload instead of posting');
    }

    // In inline mode, exclude the current job from the report to avoid self-reporting
    const isInlineMode = context.eventName !== 'workflow_run';
    let currentJobId: number | undefined;

    if (isInlineMode) {
      // Identify the current job by matching job name (and runner name if available)
      // Only filters if we can uniquely identify the job to avoid false positives
      const currentJobName = context.job;
      const runnerName = process.env.RUNNER_NAME || undefined;

      if (currentJobName) {
        currentJobId = await getCurrentJobId(octokit, owner, repo, runId, currentJobName, runnerName);
        if (currentJobId) {
          core.info(`Excluding current job (ID: ${currentJobId}, Name: ${currentJobName}) from metrics report`);
        }
      } else {
        core.warning('Could not determine current job ID: missing job name');
      }
    }

    const metrics = await fetchWorkflowRun(octokit, owner, repo, runId, currentJobId);
    await sendMetrics(apiUrl, apiKey, metrics, dryRun);

    core.setOutput('workflow_run_id', metrics.workflow_run_id.toString());
    core.setOutput('status', metrics.status);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('Unknown error occurred');
    }
  }
}

run();

