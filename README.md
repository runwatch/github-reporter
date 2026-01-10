# RunWatch GitHub Reporter

A GitHub Action that automatically collects and reports CI/CD workflow metrics to the [RunWatch Pipeline Pulse Portal](https://runwatch.io/). Designed for developers who need visibility into their pipeline performance, this action captures comprehensive workflow and job-level metrics including execution times, status, compute usage, and more.

## Overview

The RunWatch GitHub Reporter integrates seamlessly into your GitHub Actions workflows to provide real-time insights into your CI/CD pipeline performance. It automatically:

- **Collects workflow metrics**: Run duration, status, trigger events, and compute time
- **Captures job-level data**: Individual job execution times, status, and URLs
- **Reports to RunWatch**: Sends structured JSON metrics to the RunWatch ingestion endpoint
- **Supports multiple modes**: Works both inline (as a workflow step) and externally (via workflow triggers)

This action is particularly useful for teams looking to:
- Track CI/CD pipeline performance over time
- Identify slow or failing jobs
- Monitor compute resource usage
- Build dashboards and alerts around CI metrics
- Analyze workflow patterns and trends
- Identify and lower costs in your pipeline

## Two Modes of Operation

The action supports two distinct modes, each with different use cases and trade-offs:

### Inline Mode

**How it works**: The action runs as the final step within your workflow, collecting metrics about the current run.

**Best for**: 
- Workflows where you want immediate metrics reporting
- Simple setups that don't require separate workflow files
- Teams that want metrics as part of the workflow execution

**Pros:**
- ✅ Simple setup - just add as a final step
- ✅ No additional workflow files needed
- ✅ Uses built-in `GITHUB_TOKEN` (no extra authentication)
- ✅ Minimal API usage (1-2 calls per run)
- ✅ Automatically excludes itself from job metrics to avoid self-reporting
- ✅ Reports completion time accurately (treats itself as the final step)

**Cons:**
- ⚠️ Cannot report on cancelled workflows (action never runs if workflow is aborted)
- ⚠️ Must manually list all dependent jobs in `needs` clause
- ⚠️ Workflow marked complete only after reporter finishes
- ⚠️ Adds a small overhead to workflow execution time
- ⚠️ Final workflow conclustion and time must be inferred

**Example:**

```yaml
name: CI Pipeline

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make build

  test:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v4
      - run: make test

  report:
    runs-on: ubuntu-latest
    needs: [build, test]
    if: always()  # Run even if previous jobs failed
    steps:
      - uses: runwatch/github-reporter@v1
        with:
          runwatch_api_key: ${{ secrets.RUNWATCH_API_KEY }}
```

### External Mode

**How it works**: The action runs in a separate workflow that triggers when your main workflow completes, collecting metrics about the completed run.

**Best for**:
- Workflows where you need to report on cancelled runs
- Organizations that want centralized metrics collection
- Teams that prefer separation of concerns
- Monitoring multiple workflows from a single reporting workflow

**Pros:**
- ✅ Can report on cancelled workflows (runs after target workflow completes)
- ✅ Centralized reporting for multiple workflows
- ✅ Doesn't add overhead to main workflow execution
- ✅ Clean separation between CI logic and metrics collection
- ✅ Can monitor workflows you don't control (via `workflow_run` trigger)

**Cons:**
- ⚠️ Requires a separate workflow file
- ⚠️ Slightly more complex setup
- ⚠️ Report workflows show in your Actions UI history

**Example:**

Create `.github/workflows/report-metrics.yml`:

```yaml
name: Report Metrics

on:
  workflow_run:
    workflows: ["Build Pipeline", "Deploy Pipeline"]  # List workflows to monitor
    types: [completed]  # Triggers on completion (success, failure, or cancelled)

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: runwatch/github-reporter@v1
        with:
          runwatch_api_key: ${{ secrets.RUNWATCH_API_KEY }}
          workflow_run_id: ${{ github.event.workflow_run.id }}
```

## Input Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `runwatch_api_key` | ✅ Yes | — | API key or token for authentication with the RunWatch API. Store in GitHub Secrets. |
| `runwatch_api_url` | ❌ No | `https://api.runwatch.io/v1/ingest` | URL of the RunWatch ingestion API endpoint. Override if using a custom endpoint. |
| `workflow_run_id` | ❌ No | `${{ github.run_id }}` | The GitHub Actions workflow run ID to report metrics for. Only needed in external mode or when reporting on a different run. |
| `dry_run` | ❌ No | `false` | If `true`, logs the JSON payload without posting to the API. Useful for testing and debugging. |
| `debug` | ❌ No | `false` | If `true`, logs additional debug information including raw API responses. Useful for troubleshooting. |

## Metrics Collected

The action collects and reports the following metrics:

### Workflow-Level Metrics
- **Repository**: Full repository name (e.g., `owner/repo`)
- **Workflow ID & Name**: GitHub workflow identifier and display name
- **Run ID & Name**: Specific run identifier and title
- **Status**: `success`, `failure`, `cancelled`, `skipped`, `running`, `queued`, or `unknown`
- **Mode**: `inline` or `external` (how the action was invoked)
- **Duration**: Total elapsed workflow execution time in seconds
- **Compute Time**: Total of all job execution times in seconds (factors in parallel jobs for cost analysis)
- **Started At**: ISO 8601 timestamp of workflow start
- **Completed At**: ISO 8601 timestamp of workflow completion
- **Triggered By**: Event that triggered the workflow (e.g., `push`, `pull_request`, `workflow_dispatch`)
- **Actor**: GitHub user or system that triggered the workflow

### Job-Level Metrics
- **Job Name**: Display name of the job
- **Job ID**: GitHub job identifier
- **Job URL**: Direct link to the job in GitHub UI
- **Status**: `success`, `failure`, `cancelled`, `skipped`, or `unknown`
- **Duration**: Job execution time in seconds
- **Started At**: ISO 8601 timestamp of job start
- **Completed At**: ISO 8601 timestamp of job completion

## Example JSON Payload

```json
{
  "provider": "github",
  "repository": "acme/cool-project",
  "workflow_id": "123456",
  "workflow_name": "CI Pipeline",
  "run_id": 789012345,
  "run_name": "Fix login bug",
  "run_url": "https://github.com/acme/cool-project/actions/runs/789012345",
  "status": "success",
  "mode": "inline",
  "compute_seconds": 245,
  "duration_seconds": 312,
  "started_at": "2024-01-15T10:30:00Z",
  "completed_at": "2024-01-15T10:35:12Z",
  "triggered_by": "push",
  "actor": "octocat",
  "jobs": [
    {
      "name": "build",
      "job_id": "456789",
      "job_url": "https://github.com/acme/cool-project/actions/runs/789012345/job/456789",
      "status": "success",
      "duration_seconds": 120,
      "started_at": "2024-01-15T10:30:05Z",
      "completed_at": "2024-01-15T10:32:05Z"
    },
    {
      "name": "test",
      "job_id": "456790",
      "job_url": "https://github.com/acme/cool-project/actions/runs/789012345/job/456790",
      "status": "success",
      "duration_seconds": 125,
      "started_at": "2024-01-15T10:32:10Z",
      "completed_at": "2024-01-15T10:34:15Z"
    }
  ]
}
```

## Setup Instructions

### 1. Get Your RunWatch API Key

Obtain your API key from the [RunWatch Pipeline Pulse Portal](https://runwatch.io/dashboard/access-keys). This will be used to authenticate requests to the ingestion API.

### 2. Add GitHub Secret

1. Go to your repository → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Name: `RUNWATCH_API_KEY`
4. Value: Your RunWatch API key
5. Click "Add secret"

### 3. Add the Action to Your Workflow

Choose either inline or external mode based on your needs (see [Two Modes of Operation](#two-modes-of-operation) above).

### 4. Test with Dry Run

Before going live, test your setup with `dry_run: true`:

```yaml
- uses: runwatch/github-reporter@v1
  with:
    runwatch_api_key: ${{ secrets.RUNWATCH_API_KEY }}
    dry_run: true  # Logs payload without sending
```

Check the workflow logs to verify the JSON payload looks correct, then remove `dry_run: true` or set it to `false`.

## Troubleshooting

### Action Fails with "GITHUB_TOKEN is not set"

**Solution**: The action requires a GitHub token to fetch workflow data. In GitHub Actions, this is automatically provided. If testing locally with `act`, set it as an environment variable:

```bash
export GITHUB_TOKEN=your_token_here
act -W .github/workflows/your-workflow.yml
```

### Metrics Not Appearing in RunWatch

1. **Check API key**: Verify your `RUNWATCH_API_KEY` secret is correctly set
2. **Check API URL**: Ensure `runwatch_api_url` points to the correct endpoint
3. **Enable debug mode**: Set `debug: true` to see detailed logs
4. **Check workflow logs**: Look for error messages in the action's output
5. **Verify network access**: Ensure GitHub Actions runners can reach your API endpoint

### Inline Mode Reports Current Job

**Solution**: The action automatically excludes itself from job metrics in inline mode by matching job names. If you have multiple jobs with the same name, it may not filter correctly. Consider:
- Using unique job names
- Using external mode instead
- The action will warn if it can't uniquely identify the current job

### Workflow Status Shows as "unknown"

**Solution**: This can happen if:
- The workflow is still running when metrics are collected
- Job statuses haven't been determined yet
- The action is running too early in the workflow lifecycle

In inline mode, the action infers status from job results. In external mode, it uses the workflow's actual status.

## Advanced Usage

### Reporting on Multiple Workflows

Use external mode with a single reporting workflow to monitor multiple workflows:

```yaml
on:
  workflow_run:
    workflows: ["CI", "Lint", "Test", "Deploy"]
    types: [completed]
```

### Custom API Endpoints

If you're using a self-hosted or custom RunWatch instance:

```yaml
- uses: runwatch/github-reporter@v1
  with:
    runwatch_api_url: https://your-custom-endpoint.com/v1/ingest
    runwatch_api_key: ${{ secrets.RUNWATCH_API_KEY }}
```

### Conditional Reporting

Only report on specific branches or events:

```yaml
report:
  runs-on: ubuntu-latest
  needs: [build, test]
  if: github.ref == 'refs/heads/main'  # Only report on main branch
  steps:
    - uses: runwatch/github-reporter@v1
      with:
        runwatch_api_key: ${{ secrets.RUNWATCH_API_KEY }}
```

## Development

For contributors and maintainers:

```bash
# Install dependencies
pnpm install

# Build the action (required before committing)
pnpm run build

# Run tests
pnpm test

# Lint
pnpm run lint

# Format
pnpm run format
```

### Testing with `act`

This repo includes test workflows that can be run locally with [act](https://github.com/nektos/act):

```bash
# Build the action first (required)
pnpm run build

# Run the test workflow with a GitHub token
# Note: GITHUB_TOKEN is an environment variable, not a secret, so use --env
act -W .github/workflows/test-inline-mode.yml --env GITHUB_TOKEN=your_token_here

# Or set it as an environment variable before running
export GITHUB_TOKEN=your_token_here
act -W .github/workflows/test-inline-mode.yml
```

**Creating a GitHub token for testing:**

1. Go to GitHub Settings → Developer settings → Personal access tokens → **Fine-grained tokens** (recommended)
2. Click "Generate new token"
3. Configure:
   - **Token name**: e.g., "RunWatch Reporter Testing"
   - **Expiration**: Set as needed
   - **Repository access**: Select "Only select repositories" and choose this repository
   - **Permissions** → **Repository permissions**:
     - `Actions`: Read (to fetch workflow run data)
     - `Metadata`: Read (required)
4. Click "Generate token" and copy it immediately

**Alternative (Classic token):**
If using classic tokens, select `public_repo` scope (or `repo` for private repos). Classic tokens apply to all your repositories, so fine-grained tokens are more secure.

**Note:** 
- `act` has known limitations with local actions (`uses: ./`). The `.actrc` file configures `act` to use Node 20. If you encounter path resolution issues, the action will work correctly in GitHub Actions even if `act` has problems with local actions.
- `GITHUB_TOKEN` is required for the action to fetch workflow data from the GitHub API. In GitHub Actions, this is automatically provided. For `act`, you need to provide it as an environment variable using `--env` (not `--secret`).

## License

MIT

---

RunWatch is operated by [Cryostack Tech LLC](https://cryostack.tech/).
