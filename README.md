# GitHub Reporter - GitHub Action

A GitHub Action that reports workflow and job metrics to the RunWatch CI Metrics Dashboard.

## Usage

### Inline Mode

Add this job as the final step in your workflow:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make build

  test:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - run: make test

  report:
    runs-on: ubuntu-latest
    needs: [build, test]
    if: always()
    steps:
      - uses: runwatch/github-reporter@v1
        with:
          api_url: https://api.cimetrics.io/ingest
          api_key: ${{ secrets.CIMETRICS_KEY }}
```

### External Mode

Create a separate workflow file (e.g., `.github/workflows/report-metrics.yml`):

```yaml
on:
  workflow_run:
    workflows: ["CI Pipeline"]
    types: [completed]

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: runwatch/github-reporter@v1
        with:
          api_url: https://api.cimetrics.io/ingest
          api_key: ${{ secrets.CIMETRICS_KEY }}
          workflow_run_id: ${{ github.event.workflow_run.id }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api_url` | ✅ | — | Base URL for your metrics ingestion endpoint |
| `api_key` | ✅ | — | API key or token for authentication |
| `workflow_run_id` | ❌ | `${{ github.run_id }}` | The GitHub Actions run ID to report metrics for |

## Development

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

**Creating a GitHub token for this repo:**

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

