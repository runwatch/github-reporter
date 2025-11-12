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

# Build the action
pnpm run build

# Run tests
pnpm test

# Lint
pnpm run lint

# Format
pnpm run format
```

## License

MIT

