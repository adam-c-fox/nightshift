# Nightshift

Nightshift works through Linear tickets overnight with Claude Code. You pick the tickets before you log off. It works each one test-first in its own git worktree, reviews the change, fixes what the review finds and opens an Azure DevOps PR. In the morning there's an HTML report waiting.

![A nightshift report](docs/report.png)

<sub>The screenshot shows sample data.</sub>

## How a night runs

Cron starts the runner at 23:00. It reads `tickets/tonight.md` and works the tickets in file order. For each ticket it:

1. **Fetches the Linear ticket** and moves it to In Progress.
2. **Creates a worktree** off `origin/main`. If the ticket already has an open PR, it continues on that PR's branch instead.
3. **Runs the repo's checks** (tests, typecheck, lint, or `terraform validate` and `fmt`) to get a baseline.
4. **Runs the agent** with the ticket, your context bullets and [`AGENTS.md`](AGENTS.md). The agent works test-first and ends with a structured report.
5. **Re-runs the checks** against the baseline, so only failures the change introduced count as regressions.
6. **Reviews the diff** with a separate read-only agent ([`prompts/review.md`](prompts/review.md)), then has an agent fix the findings ([`prompts/fix.md`](prompts/fix.md)).
7. **Commits and opens or updates the PR.** If CI fails, it pulls the failure logs and makes up to two attempts to fix them. It won't push to a PR that has auto-complete set.

Anything that can't be finished cleanly stays on a local branch, marked `needs_review`, with notes saying why.

### Budget

Each night gets 15% of the weekly Claude usage. The runner reads usage with `claude -p /usage` before each ticket and stops picking up new tickets once the cap is reached. When the 5-hour session reaches 80%, it waits for the session to reset rather than running into extra usage.

## Setup

You need Node 22 or later, the [Claude Code](https://claude.com/claude-code) CLI, the Azure CLI (`az`) with the DevOps extension, and Docker (for the throwaway Postgres that database-backed tests run against).

```sh
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | What it's for |
| --- | --- |
| `LINEAR_API_KEY` | Fetching tickets and moving them to In Progress |
| `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_PAT` | Opening PRs and reading CI results |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`. Cron can't read the login keychain. |
| `BRANCH_PREFIX` | Optional prefix for ticket branches |

The repos nightshift works in are set in [`src/repos.ts`](src/repos.ts).

Schedule it:

```cron
0 23 * * * cd /path/to/nightshift && npm run run >> logs/cron.log 2>&1
```

## Each evening

Draft `tickets/tonight.md` from your Linear Todo list by running `/tonight` in Claude Code, or write it by hand following [`tickets/tonight.example.md`](tickets/tonight.example.md):

```md
## ENG-142 – export: add CSV download to the runs table
repo: main
- Reuse the existing row formatter in packages/export; don't add a CSV dependency.
```

Preview the night without changing anything:

```sh
npm run run:dry
```

The report lands in `reports/nightshift-<date>.html`. Agent output and run logs go to `logs/`.

## Development

```sh
npm test
npm run typecheck
```
