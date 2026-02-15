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
  job_id?: string;
  job_url?: string;
  status:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'running'
    | 'queued'
    | 'pending'
    | 'skipped'
    | 'timed_out';
  duration_seconds?: number;
  started_at?: string;
  completed_at?: string;
}

interface PipelineMetrics {
  provider: 'github';
  repository: string;
  pipeline_id?: string;
  pipeline_name: string;
  run_id: number;
  run_attempt: number;
  run_name?: string;
  run_url?: string;
  status:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'running'
    | 'queued'
    | 'pending'
    | 'skipped'
    | 'timed_out';
  mode: 'inline' | 'external';
  compute_seconds?: number;
  duration_seconds?: number;
  started_at: string;
  completed_at?: string;
  triggered_by: string;
  actor: string;
  branch?: string;
  jobs: Job[];
}

// Valid pipeline conclusions (only for completed pipelines)
const VALID_PIPELINE_CONCLUSIONS = [
  'success',
  'failure',
  'cancelled',
  'skipped',
  'timed_out',
] as const;
// Valid job conclusions
const VALID_JOB_CONCLUSIONS = ['success', 'failure', 'cancelled', 'skipped', 'timed_out'] as const;

// Type guard to check if a string is a valid pipeline conclusion
function isValidPipelineConclusion(
  conclusion: string | null
): conclusion is (typeof VALID_PIPELINE_CONCLUSIONS)[number] {
  return (
    conclusion !== null &&
    VALID_PIPELINE_CONCLUSIONS.includes(conclusion as (typeof VALID_PIPELINE_CONCLUSIONS)[number])
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

function mapPipelineStatus(
  status: string | null,
  conclusion: string | null
): PipelineMetrics['status'] {
  // Only completed pipelines have conclusions
  // Valid conclusions: success, failure, cancelled, skipped
  if (status === 'completed' && isValidPipelineConclusion(conclusion)) {
    return conclusion;
  }
  // Map GitHub status to pipeline status
  if (status === 'queued') return 'queued';
  if (status === 'in_progress') return 'running';
  if (status === 'waiting') return 'pending';
  return 'running'; // Default to running for active pipelines
}

function mapJobStatus(status: string, conclusion: string | null): Job['status'] {
  if (status === 'completed' && isValidJobConclusion(conclusion)) {
    return conclusion;
  }
  // Map GitHub job status to pipeline job status
  if (status === 'queued') return 'queued';
  if (status === 'in_progress') return 'running';
  if (status === 'waiting') return 'pending';
  return 'running'; // Default to running for active jobs
}

function inferPipelineStatusFromJobs(
  jobs: Job[],
  pipelineStatus: string | null,
  pipelineConclusion: string | null
): PipelineMetrics['status'] {
  // If pipeline is already completed, use the actual status
  if (pipelineStatus === 'completed' && pipelineConclusion) {
    return mapPipelineStatus(pipelineStatus, pipelineConclusion);
  }

  // If no jobs, can't infer anything
  if (jobs.length === 0) {
    return pipelineStatus === 'queued'
      ? 'queued'
      : pipelineStatus === 'in_progress'
        ? 'running'
        : pipelineStatus === 'waiting'
          ? 'pending'
          : 'running';
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

  // Check if there are any jobs still running or pending
  const hasActiveJobs = jobs.some(
    (job) => job.status === 'running' || job.status === 'pending' || job.status === 'queued'
  );
  if (hasActiveJobs) {
    // Check if any are specifically pending
    const hasPending = jobs.some((job) => job.status === 'pending');
    if (hasPending) return 'pending';
    // Check if any are queued
    const hasQueued = jobs.some((job) => job.status === 'queued');
    if (hasQueued) return 'queued';
    return 'running';
  }

  // Check if all jobs are completed and successful/skipped
  const allCompleted = jobs.every((job) => job.status === 'success' || job.status === 'skipped');
  if (allCompleted) {
    return 'success';
  }

  // If pipeline is queued, return queued
  if (pipelineStatus === 'queued') {
    return 'queued';
  }

  // If pipeline is waiting, return pending
  if (pipelineStatus === 'waiting') {
    return 'pending';
  }

  // Default to running if we have jobs but can't determine
  return 'running';
}

const JOBS_PAGE_SIZE = 100;

async function listAllJobsForWorkflowRun(
  octokit: OctokitRest,
  owner: string,
  repo: string,
  runId: number
): Promise<GitHubJob[]> {
  const allJobs: GitHubJob[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { data } = await octokit.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
      per_page: JOBS_PAGE_SIZE,
      page,
    });
    allJobs.push(...(data.jobs as GitHubJob[]));
    hasMore = data.jobs.length === JOBS_PAGE_SIZE;
    page += 1;
  }

  return allJobs;
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
    const jobs = await listAllJobsForWorkflowRun(octokit, owner, repo, runId);

    // Find all jobs matching the current job name
    const matchingJobs = jobs.filter((job: GitHubJob) => {
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

async function fetchPipelineRun(
  octokit: OctokitRest,
  owner: string,
  repo: string,
  runId: number,
  isInlineMode: boolean,
  branch: string,
  excludeJobId?: number,
  debug?: boolean
): Promise<PipelineMetrics> {
  let run: Awaited<ReturnType<OctokitRest['actions']['getWorkflowRun']>>['data'];
  try {
    const result = await octokit.actions.getWorkflowRun({
      owner,
      repo,
      run_id: runId,
    });
    run = result.data;
  } catch (error) {
    const status =
      error && typeof error === 'object' && 'status' in error
        ? (error as { status: number }).status
        : undefined;
    if (status === 404) {
      throw new Error(
        `Workflow run ${runId} not found in ${owner}/${repo}. Check run ID and repository access (GITHUB_TOKEN permissions).`
      );
    }
    throw error;
  }

  if (debug) {
    core.debug(`pipeline run:\n${JSON.stringify(run, null, 2)}`);
  }

  const jobsList = await listAllJobsForWorkflowRun(octokit, owner, repo, runId);

  if (debug) {
    core.debug(`pipeline jobs:\n${JSON.stringify({ jobs: jobsList }, null, 2)}`);
  }

  // Use the run's head_branch when reporting on another run (external mode) for correct branch
  const branchToUse = !isInlineMode && run.head_branch ? run.head_branch : branch;

  // Filter out the current job if excludeJobId is provided (inline mode)
  // Only filter by numeric job ID to avoid false positives
  const filteredJobs = excludeJobId
    ? jobsList.filter((job: GitHubJob) => job.id !== excludeJobId)
    : jobsList;

  let computeSeconds = 0;

  const jobMetrics: Job[] = filteredJobs.map((job: GitHubJob) => {
    const startedAt = job.started_at ? new Date(job.started_at) : undefined;
    const completedAt = job.completed_at ? new Date(job.completed_at) : undefined;
    const durationSeconds =
      startedAt && completedAt
        ? Math.floor((completedAt.getTime() - startedAt.getTime()) / 1000)
        : undefined;

    if (durationSeconds !== undefined) {
      computeSeconds += durationSeconds;
    }

    return {
      name: job.name,
      job_id: job.id.toString(),
      job_url: job.html_url || undefined,
      status: mapJobStatus(job.status, job.conclusion),
      duration_seconds: durationSeconds,
      started_at: job.started_at || undefined,
      completed_at: job.completed_at || undefined,
    };
  });

  const pipelineStatus = inferPipelineStatusFromJobs(jobMetrics, run.status, run.conclusion);
  const startedAt = run.created_at ? new Date(run.created_at) : undefined;

  // Determine completed_at:
  // - If pipeline is marked as completed, use run.updated_at
  // - If in inline mode (we're the last step), treat pipeline as completed now
  // - Otherwise, leave undefined for running pipelines
  let completedAt: Date | undefined;
  let completedAtString: string | undefined;

  if (run.status === 'completed' && run.updated_at) {
    // Pipeline is actually completed
    completedAt = new Date(run.updated_at);
    completedAtString = run.updated_at;
  } else if (isInlineMode) {
    // In inline mode, we're the last step, so treat pipeline as completed
    // Prefer run.updated_at if available (more accurate), otherwise use current time
    completedAt = run.updated_at ? new Date(run.updated_at) : new Date();
    completedAtString = run.updated_at || new Date().toISOString();
  }

  const durationSeconds =
    startedAt && completedAt
      ? Math.floor((completedAt.getTime() - startedAt.getTime()) / 1000)
      : startedAt
        ? Math.floor((Date.now() - startedAt.getTime()) / 1000)
        : undefined;

  return {
    provider: 'github',
    repository: `${owner}/${repo}`,
    pipeline_id: run.workflow_id.toString(),
    pipeline_name: run.name || run.workflow_id.toString(),
    run_id: run.id,
    run_attempt: run.run_attempt || 1,
    run_name: run.display_title || undefined,
    run_url: run.html_url || undefined,
    status: pipelineStatus,
    mode: isInlineMode ? 'inline' : 'external',
    compute_seconds: computeSeconds > 0 ? computeSeconds : undefined,
    duration_seconds: durationSeconds,
    started_at: run.created_at,
    completed_at: completedAtString,
    triggered_by: run.event || 'unknown',
    actor: run.actor?.login || 'unknown',
    branch: branchToUse || undefined,
    jobs: jobMetrics,
  };
}

async function sendMetrics(
  apiUrl: string,
  apiKey: string,
  metrics: PipelineMetrics,
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

  const FETCH_TIMEOUT_MS = 60_000;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: jsonPayload,
      signal: controller.signal,
    });
  } catch (fetchError) {
    clearTimeout(timeoutId);
    const err = fetchError instanceof Error ? fetchError : new Error(String(fetchError));
    const causeProp = 'cause' in err ? (err as Error & { cause?: unknown }).cause : undefined;
    const cause =
      causeProp instanceof Error ? causeProp.message : causeProp ? String(causeProp) : '';
    const detail = cause ? ` (cause: ${cause})` : '';
    const timeoutHint =
      err.name === 'AbortError' ? ` Request timed out after ${FETCH_TIMEOUT_MS / 1000}s.` : '';
    throw new Error(
      `Failed to send metrics to ${apiUrl}: ${err.message}${detail}.${timeoutHint} Check network, DNS, TLS, and API availability.`
    );
  }

  clearTimeout(timeoutId);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to send metrics: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  core.info(`Successfully sent metrics for pipeline run ${metrics.run_id}`);
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
    // Inline = we're a step inside the same run we're reporting on (runId === context.runId).
    // External = we're reporting on another run (e.g. workflow_run trigger or a different run_id passed in).
    const isInlineMode = runId === context.runId;

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

    const metrics = await fetchPipelineRun(
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

    core.setOutput('pipeline_run_id', metrics.run_id.toString());
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
