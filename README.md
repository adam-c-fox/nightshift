# Nightshift

Nightshift works through Linear tickets overnight with Claude Code. You pick the tickets before you log off. It works each one test-first in its own git worktree, reviews the change, fixes what the review finds and opens an Azure DevOps PR. In the morning there's an HTML report waiting.

![A nightshift report](docs/report.png)

<sub>The screenshot shows sample data.</sub>

## How a night runs

Cron starts the runner at 23:00. It reads the project's `tonight.md` and works the tickets in file order. For each ticket it:

1. **Fetches the Linear ticket** and moves it to In Progress.
2. **Creates a worktree** off `origin/main`. If the ticket already has an open PR, it continues on that PR's branch instead.
3. **Runs the repo's checks** (tests, typecheck, lint, or `terraform validate` and `fmt`) to get a baseline.
4. **Runs the agent** with the ticket, your context bullets and [`AGENTS.md`](AGENTS.md) plus the project's own `AGENTS.md`. The agent works test-first and ends with a structured report, including anything it spotted but didn't fix ("Spotted, not fixed" in the report).
5. **Re-runs the checks** against the baseline, so only failures the change introduced count as regressions.
6. **Reviews the diff** with a separate read-only agent ([`prompts/review.md`](prompts/review.md)), then has an agent fix the findings ([`prompts/fix.md`](prompts/fix.md)), and re-checks the claimed fixes with a second read-only pass ([`prompts/verify.md`](prompts/verify.md)).
7. **Commits and opens or updates the PR.** If CI fails, it pulls the failure logs and makes up to two attempts to fix them. It won't push to a PR that has auto-complete set.

8. **Runs a postmortem after the last ticket.** A read-only agent ([`.claude/skills/postmortem/SKILL.md`](.claude/skills/postmortem/SKILL.md)) reviews the night's logs and suggests changes to the instructions and workflow. It never edits anything. It's skipped on a dry run, when no ticket was worked, or when usage has run out, and the report says so.

Anything that can't be finished cleanly stays on a local branch, marked `needs_review`, with notes saying why.

### Budget

Each night gets 15% of the weekly Claude usage, or the project's `allowancePercent`. `--allowance <pct>` overrides it for one run, e.g. `--allowance 100` the night before the weekly reset. The runner reads usage with `claude -p /usage` before each ticket and stops picking up new tickets once the cap is reached. When the 5-hour session reaches 80%, it waits for the session to reset rather than running into extra usage.

## Setup

You need Node 22 or later, the [Claude Code](https://claude.com/claude-code) CLI, the Azure CLI (`az`) with the DevOps extension, and Docker (for the throwaway Postgres that database-backed tests run against).

```sh
npm install
cp .env.example .env
```

Fill in the root `.env`:

| Variable | What it's for |
| --- | --- |
| `LINEAR_API_KEY` | Fetching tickets and moving them to In Progress |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`. Cron can't read the login keychain. |
| `NIGHTSHIFT_PROJECT` | Project used when `--project` isn't passed |

Fill in the project's `.env` (see [Projects](#projects)). An empty value there falls through to the root `.env`:

| Variable | What it's for |
| --- | --- |
| `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_PAT` | Opening PRs and reading CI results |
| `BRANCH_PREFIX` | Optional prefix for ticket branches |

Schedule it:

```cron
0 23 * * * cd /path/to/nightshift && npm run run -- --project <name> >> logs/cron.log 2>&1
```

## Projects

A project is the set of repos nightshift works in, plus the instructions and tickets for them. Each lives in `projects/<name>/`, which is gitignored apart from `projects/example/`:

| File | What it's for |
| --- | --- |
| `project.json` | Repos (`path`, `toolchain`, `description`), `defaultRepo`, optional `testDb` script and `allowancePercent` |
| `AGENTS.md` | Project instructions appended to the root [`AGENTS.md`](AGENTS.md): repo layout, services available, tools missing |
| `.env` | Azure DevOps settings and `BRANCH_PREFIX` for this project |
| `tonight.md` | Tonight's tickets |
| `test-db.sh` | Optional script that starts the throwaway Postgres |

Start a new project by copying [`projects/example`](projects/example) to `projects/<name>` and replacing the placeholder paths in `project.json`; it won't load until they exist. Select a project with `--project <name>` or `NIGHTSHIFT_PROJECT`. For example, `npm run run -- --project <name>` runs it, and `--allowance <pct>` overrides its budget for one run.

## Each evening

Prep tickets one at a time with `/prep <ID> [project]` in Claude Code. It checks the ticket against the code, asks you about anything the agent would have to guess, and writes your answers into the Linear description. The agent also gets the comments, but as a raw thread, so settled decisions belong in the description.

A ticket that needs the unmerged code of another ticket in tonight's file can name it with `base: <ID>` (an earlier ticket in the same repo). It branches from that ticket's branch and opens its PR into it, and is skipped if the base wasn't pushed.

Draft `projects/<name>/tonight.md` from your Linear Todo list by running `/tonight [project]` in Claude Code, or write it by hand following [`projects/example/tonight.md`](projects/example/tonight.md):

```md
## ENG-142 – export: add CSV download to the runs table
repo: app
- Reuse the existing row formatter in packages/export; don't add a CSV dependency.
```

Preview the night without changing anything:

```sh
npm run run:dry -- --project <name>
```

The report lands in `reports/<name>/nightshift-<date>.html`. Agent output and run logs go to `logs/<name>/`. The runner then moves the night's tickets to `reports/<name>/nightshift-<date>-tonight.md`, leaving only the header in `projects/<name>/tonight.md`, so the next night doesn't rerun them.

## Each morning

Read `reports/<name>/nightshift-<date>.html`. The Postmortem section at the bottom lists suggested fixes to the instructions, also saved in `reports/<name>/nightshift-<date>-postmortem.md`. Ask Claude to implement the ones you pick by id, for example "implement P1 and P3". `/postmortem [date]` re-runs the postmortem by hand.

## Development

```sh
npm test
npm run typecheck
```
