import * as core from '@actions/core';
import * as github from '@actions/github';

// Type aliases for better readability
type OctokitRest = Awaited<ReturnType<typeof github.getOctokit>>['rest'];

interface GitHubJob {
  name: string;
  id: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  runner_name?: string | null;
}

interface Job {
  name: string;
  job_id: string;
  job_url: string;
  status: 'success' | 'failure' | 'cancelled' | 'skipped' | 'unknown';
  duration_seconds: number;
  started_at?: string;
  completed_at?: string;
  log_url?: string;
}

interface WorkflowMetrics {
  provider: 'github';
  repository: string;
  workflow_id: string;
  workflow_name: string;
  run_id: number;
  run_attempt: number;
  run_name: string;
  run_url: string;
  status: 'success' | 'failure' | 'cancelled' | 'skipped' | 'running' | 'queued' | 'unknown';
  mode: 'inline' | 'external';
  compute_seconds: number;
  duration_seconds: number;
  started_at: string;
  completed_at?: string;
  triggered_by: string;
  actor: string;
  branch: string;
  jobs: Job[];
}

// Valid workflow conclusions (only for completed workflows)
const VALID_WORKFLOW_CONCLUSIONS = ['success', 'failure', 'cancelled', 'skipped'] as const;
// Valid job conclusions
const VALID_JOB_CONCLUSIONS = ['success', 'failure', 'cancelled', 'skipped'] as const;

// Type guard to check if a string is a valid workflow conclusion
function isValidWorkflowConclusion(
  conclusion: string | null
): conclusion is (typeof VALID_WORKFLOW_CONCLUSIONS)[number] {
  return (
    conclusion !== null &&
    VALID_WORKFLOW_CONCLUSIONS.includes(conclusion as (typeof VALID_WORKFLOW_CONCLUSIONS)[number])
  );
}

// Type guard to check if a string is a valid job conclusion
function isValidJobConclusion(
  conclusion: string | null
): conclusion is (typeof VALID_JOB_CONCLUSIONS)[number] {
  return (
    conclusion !== null &&
    VALID_JOB_CONCLUSIONS.includes(conclusion as (typeof VALID_JOB_CONCLUSIONS)[number])
  );
}

function extractBranchName(ref: string, headRef: string): string {
  // For pull requests, use the head_ref (source branch)
  if (headRef) {
    return headRef;
  }

  // For push events and other triggers, extract from ref
  // ref format: refs/heads/branch-name or refs/tags/tag-name or refs/pull/123/merge
  if (ref.startsWith('refs/heads/')) {
    return ref.replace('refs/heads/', '');
  }

  if (ref.startsWith('refs/tags/')) {
    return ref.replace('refs/tags/', '');
  }

  if (ref.startsWith('refs/pull/')) {
    // For PR merge refs, return the ref as-is for tracking
    return ref;
  }

  // If we can't parse it, return the raw ref
  return ref;
}

function mapWorkflowStatus(
  status: string | null,
  conclusion: string | null
): WorkflowMetrics['status'] {
  // Only completed workflows have conclusions
  // Valid conclusions: success, failure, cancelled, skipped
  if (status === 'completed' && isValidWorkflowConclusion(conclusion)) {
    return conclusion;
  }
  return 'unknown';
}

function mapJobStatus(status: string, conclusion: string | null): Job['status'] {
  if (status === 'completed' && isValidJobConclusion(conclusion)) {
    return conclusion;
  }
  return 'unknown';
}

function inferWorkflowStatusFromJobs(
  jobs: Job[],
  workflowStatus: string | null,
  workflowConclusion: string | null
): WorkflowMetrics['status'] {
  // If workflow is already completed, use the actual status
  if (workflowStatus === 'completed' && workflowConclusion) {
    return mapWorkflowStatus(workflowStatus, workflowConclusion);
  }

  // If no jobs, can't infer anything
  if (jobs.length === 0) {
    return workflowStatus === 'queued'
      ? 'queued'
      : workflowStatus === 'in_progress'
        ? 'running'
        : 'unknown';
  }

  // Check for failures first (highest priority)
  const hasFailure = jobs.some((job) => job.status === 'failure');
  if (hasFailure) {
    return 'failure';
  }

  // Check for cancellations
  const hasCancelled = jobs.some((job) => job.status === 'cancelled');
  if (hasCancelled) {
    return 'cancelled';
  }

  // Check if there are any jobs still running (unknown status)
  const hasRunningJobs = jobs.some((job) => job.status === 'unknown');
  if (hasRunningJobs) {
    return 'running';
  }

  // Check if all jobs are completed and successful/skipped
  const allCompleted = jobs.every((job) => job.status === 'success' || job.status === 'skipped');
  if (allCompleted) {
    return 'success';
  }

  // If workflow is queued, return queued
  if (workflowStatus === 'queued') {
    return 'queued';
  }

  // Default to running if we have jobs but can't determine
  return 'running';
}

async function getCurrentJobId(
  octokit: OctokitRest,
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
    const matchingJobs = jobs.jobs.filter((job: GitHubJob) => {
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
      const runnerMatch = matchingJobs.find((job: GitHubJob) => {
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
    core.warning(
      `Could not identify current job ID: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return undefined;
  }
}

async function fetchWorkflowRun(
  octokit: OctokitRest,
  owner: string,
  repo: string,
  runId: number,
  isInlineMode: boolean,
  branch: string,
  excludeJobId?: number,
  debug?: boolean
): Promise<WorkflowMetrics> {
  const { data: run } = await octokit.actions.getWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });

  if (debug) {
    core.debug(`workflow run:\n${JSON.stringify(run, null, 2)}`);
  }

  const { data: jobs } = await octokit.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });

  if (debug) {
    core.debug(`workflow jobs:\n${JSON.stringify(jobs, null, 2)}`);
  }

  // Filter out the current job if excludeJobId is provided (inline mode)
  // Only filter by numeric job ID to avoid false positives
  const filteredJobs = excludeJobId
    ? jobs.jobs.filter((job: GitHubJob) => job.id !== excludeJobId)
    : jobs.jobs;

  let computeSeconds = 0;

  const jobMetrics: Job[] = filteredJobs.map((job: GitHubJob) => {
    const startedAt = job.started_at ? new Date(job.started_at) : undefined;
    const completedAt = job.completed_at ? new Date(job.completed_at) : undefined;
    const durationSeconds =
      startedAt && completedAt
        ? Math.floor((completedAt.getTime() - startedAt.getTime()) / 1000)
        : 0;

    computeSeconds += durationSeconds;

    return {
      name: job.name,
      job_id: job.id.toString(),
      job_url: job.html_url || '',
      status: mapJobStatus(job.status, job.conclusion),
      duration_seconds: durationSeconds,
      started_at: job.started_at || undefined,
      completed_at: job.completed_at || undefined,
    };
  });

  const workflowStatus = inferWorkflowStatusFromJobs(jobMetrics, run.status, run.conclusion);
  const startedAt = run.created_at ? new Date(run.created_at) : undefined;

  // Determine completed_at:
  // - If workflow is marked as completed, use run.updated_at
  // - If in inline mode (we're the last step), treat workflow as completed now
  // - Otherwise, leave undefined for running workflows
  let completedAt: Date | undefined;
  let completedAtString: string | undefined;

  if (run.status === 'completed' && run.updated_at) {
    // Workflow is actually completed
    completedAt = new Date(run.updated_at);
    completedAtString = run.updated_at;
  } else if (isInlineMode) {
    // In inline mode, we're the last step, so treat workflow as completed
    // Prefer run.updated_at if available (more accurate), otherwise use current time
    completedAt = run.updated_at ? new Date(run.updated_at) : new Date();
    completedAtString = run.updated_at || new Date().toISOString();
  }

  const durationSeconds =
    startedAt && completedAt
      ? Math.floor((completedAt.getTime() - startedAt.getTime()) / 1000)
      : startedAt
        ? Math.floor((Date.now() - startedAt.getTime()) / 1000)
        : 0;

  return {
    provider: 'github',
    repository: `${owner}/${repo}`,
    workflow_id: run.workflow_id.toString(),
    workflow_name: run.name || run.workflow_id.toString(),
    run_id: run.id,
    run_attempt: run.run_attempt || 1,
    run_name: run.display_title,
    run_url: run.html_url,
    status: workflowStatus,
    mode: isInlineMode ? 'inline' : 'external',
    compute_seconds: computeSeconds,
    duration_seconds: durationSeconds,
    started_at: run.created_at,
    completed_at: completedAtString,
    triggered_by: run.event || 'unknown',
    actor: run.actor?.login || 'unknown',
    branch,
    jobs: jobMetrics,
  };
}

async function sendMetrics(
  apiUrl: string,
  apiKey: string,
  metrics: WorkflowMetrics,
  dryRun: boolean,
  debug?: boolean
): Promise<void> {
  const jsonPayload = JSON.stringify(metrics, null, 2);

  if (debug || dryRun) {
    core.info(`JSON Payload:\n${jsonPayload}`);
    if (dryRun) {
      core.info('Dry run mode: Skipping actual API call');
      return;
    }
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
    throw new Error(
      `Failed to send metrics: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  core.info(`Successfully sent metrics for workflow run ${metrics.run_id}`);
}

async function run(): Promise<void> {
  try {
    const runwatchApiUrl = core.getInput('runwatch_api_url', { required: true });
    const runwatchApiKey = core.getInput('runwatch_api_key', { required: true });
    const workflowRunIdInput = core.getInput('workflow_run_id');
    const dryRunInput = core.getInput('dry_run');
    const dryRun = dryRunInput?.toLowerCase() === 'true';
    const debugInput = core.getInput('debug');
    const debug = debugInput?.toLowerCase() === 'true';

    // GITHUB_TOKEN must be explicitly passed as an environment variable when using local actions (uses: ./)
    const token = process.env.GITHUB_TOKEN || '';
    if (!token) {
      throw new Error('GITHUB_TOKEN is not set');
    }
    const octokit = github.getOctokit(token).rest;
    const context = github.context;

    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const runId = workflowRunIdInput ? parseInt(workflowRunIdInput, 10) : context.runId;

    if (isNaN(runId) || runId <= 0) {
      throw new Error(`Invalid workflow_run_id: ${workflowRunIdInput || 'not provided'}`);
    }
    const isInlineMode = context.eventName !== 'workflow_run';

    // Extract branch name from GitHub context
    const branch = extractBranchName(context.ref, context.payload.pull_request?.head?.ref || '');

    core.info(
      `Fetching metrics for:\nworkflow_run_id: ${runId}\nrepository: ${owner}/${repo}\nbranch: ${branch}\nrunwatch_api_url: ${runwatchApiUrl}\nmode: ${isInlineMode ? 'inline' : 'external'}\ndry_run: ${dryRun}\ndebug: ${debug}`
    );

    // In inline mode, exclude the current job from the report to avoid self-reporting
    let currentJobId: number | undefined;

    if (isInlineMode) {
      // Identify the current job by matching job name (and runner name if available)
      // Only filters if we can uniquely identify the job to avoid false positives
      const currentJobName = context.job;
      const runnerName = process.env.RUNNER_NAME || undefined;

      if (currentJobName) {
        currentJobId = await getCurrentJobId(
          octokit,
          owner,
          repo,
          runId,
          currentJobName,
          runnerName
        );
        if (currentJobId) {
          core.info(
            `Excluding current job (ID: ${currentJobId}, Name: ${currentJobName}) from metrics report`
          );
        }
      } else {
        core.warning('Could not determine current job ID: missing job name');
      }
    }

    const metrics = await fetchWorkflowRun(
      octokit,
      owner,
      repo,
      runId,
      isInlineMode,
      branch,
      currentJobId,
      debug
    );
    await sendMetrics(runwatchApiUrl, runwatchApiKey, metrics, dryRun, debug);

    core.setOutput('workflow_run_id', metrics.run_id.toString());
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
