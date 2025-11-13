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

async function fetchWorkflowRun(
  octokit: Awaited<ReturnType<typeof github.getOctokit>>['rest'],
  owner: string,
  repo: string,
  runId: number
): Promise<WorkflowMetrics> {
  const { data: run } = await octokit.actions.getWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });

  const { data: jobs } = await octokit.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });

  const jobMetrics: Job[] = jobs.jobs.map((job: { name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null; html_url: string | null }) => {
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

    const metrics = await fetchWorkflowRun(octokit, owner, repo, runId);
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

