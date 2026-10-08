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
6. **Reviews the diff** with read-only agents, one after another: three finders ([bugs](prompts/review-bugs.md), [spec](prompts/review-spec.md), [reuse](prompts/review-reuse.md), on the shared [`review.md`](prompts/review.md)). The bugs finder runs twice, independently and with the same prompt, because a single pass catches a given bug in some runs and misses it in others; the passes run in the order bugs, bugs, spec, reuse, and their candidates are numbered together. Then a [confirm step](prompts/confirm.md) that keeps only the findings it can demonstrate. Unproven ones become "worth a closer look" risks in the PR. An agent then fixes what was confirmed ([`prompts/fix.md`](prompts/fix.md)), and a second read-only pass re-checks the claimed fixes ([`prompts/verify.md`](prompts/verify.md)). Token usage for every run is recorded in the session JSON and shown in the morning report.
7. **Commits and opens or updates the PR.** If CI fails, it pulls the failure logs and makes up to two attempts to fix them. It won't push to a PR that has auto-complete set.

8. **Runs a postmortem after the last ticket.** A read-only agent ([`.claude/skills/postmortem/SKILL.md`](.claude/skills/postmortem/SKILL.md)) reviews the night's logs and suggests changes to the instructions and workflow. It never edits anything. It's skipped on a dry run, when no ticket was worked, or when usage has run out, and the report says so.

Anything that can't be finished cleanly stays on a local branch, marked `needs_review`, with notes saying why. Tickets that end `done` or `needs_review` are moved to In Review in Linear, if the team has that state.

### Budget

Each night gets 15% of the weekly Claude usage, or the project's `allowancePercent`. `--allowance <pct>` overrides it for one run, e.g. `--allowance 100` the night before the weekly reset. An `allowance: <pct>` line in the header of `tonight.md` does the same for one night and is removed once the night is archived; `--allowance` wins over it. The runner reads usage with `claude -p /usage` before each ticket and stops picking up new tickets once the cap is reached. When the 5-hour session reaches 80%, it waits for the session to reset rather than running into extra usage.

## Setup

You need Node 22 or later, the [Claude Code](https://claude.com/claude-code) CLI, the Azure CLI (`az`) with the DevOps extension, and Docker (for the throwaway Postgres that database-backed tests run against).

```sh
npm install
cp .env.example .env
```

Fill in the root `.env`:

| Variable | What it's for |
| --- | --- |
| `LINEAR_API_KEY` | Fetching tickets and moving them to In Progress and In Review |
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
| `project.json` | Repos (`path`, `toolchain`, `description`), `defaultRepo`, optional `testDb` script, `allowancePercent` and `linearTeams` |
| `AGENTS.md` | Project instructions appended to the root [`AGENTS.md`](AGENTS.md): repo layout, services available, tools missing |
| `.env` | Azure DevOps settings and `BRANCH_PREFIX` for this project |
| `tonight.md` | Tonight's tickets |
| `test-db.sh` | Optional script that starts the throwaway Postgres |

`linearTeams` is a list of Linear team keys such as `["ENG"]`. When it's set, `prep-status` and the [dashboard](#dashboard) only list your Todo tickets from those teams. `/tonight` still lists every Todo ticket assigned to you, and tickets outside `linearTeams` show "—" in its prep column. Leave it out to see all of them. `/prep` and `/tonight` also use `prep-mark` and `prep-status` to keep track of which tickets have been prepped, described under [Prep memory](#prep-memory).

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

## Dashboard

The dashboard is a local web page for the evening and the morning. It shows what to prep and plan before you log off, and what needs you after a night. Besides reading and writing files in this repo, it calls Linear and Azure DevOps with the same credentials as the runner, runs the usage check, runs git in the configured repo paths and launches herdr.

### Install

```sh
npm run dashboard:install
```

This installs a LaunchAgent, `io.nightshift.dashboard`, that starts the dashboard at login and restarts it if it stops. Logs go to `logs/dashboard.log`. Run the install again after you move the repo or change Node, because the agent stores the repo path and the Node directory.

To run it in the foreground instead:

```sh
npm run dashboard
```

To uninstall:

```sh
launchctl bootout gui/$(id -u)/io.nightshift.dashboard && rm ~/Library/LaunchAgents/io.nightshift.dashboard.plist
```

Open <http://127.0.0.1:4100>. It listens on that address only, so nothing else on the network can reach it.

### Before clocking off

The home page has a project picker and a "Before clocking off" section for the selected project:

- **Todo tickets.** Your Linear Todo tickets, limited to the project's `linearTeams`, with priority, estimate, prep state, position in `tonight.md` and any open PR. Tickets that are in `tonight.md` but no longer in Todo are listed too, with their Linear state.
- **Prep state.** One of:
  - `fresh`: prepped with `/prep`, the description hasn't changed since and there are no newer comments.
  - `stale`: the description changed after `/prep`.
  - `new comments`: comments arrived after `/prep`.
  - `not ready`: `/prep` recorded blockers. Hover the badge to read them.
  - `inferred`: there's no `/prep` record, but the description already has a Decisions, Acceptance criteria or Pointers section.
  - `none`: no record and no such section.
- **Allowance and usage.** Tonight's allowance and where it comes from (`tonight.md` or the project default), and the weekly usage with its reset time.
- **Warnings.** A ticket in `tonight.md` that Linear can't find, that isn't in Todo or isn't assigned to you; one that is unprepped, stale or not ready; a PR with auto-complete set, which the runner won't push to; and a weekly reset within 24 hours, when `allowance: 100` may be worth setting. If Linear is unavailable or `tonight.md` has a parse error, the page says so and still lists what it can.
- **Prep and Plan tonight.** Each row has a Prep button and the section has a Plan tonight button. They open a herdr workspace running `/prep <ID> <project>` or `/tonight <project>`. If herdr isn't installed or isn't running, the dashboard copies the equivalent `claude` command to your clipboard instead.
- **Refresh.** Clears the caches and reloads. Linear tickets are cached for 5 minutes, PRs and their CI results for 5 minutes, usage for 10 minutes and the Linear team list for 1 hour.

### Prep memory

`/prep` records what it did in `state/prep.json` with `prep-mark`:

```sh
npm run -s prep-mark -- <ID> --project <name> [--repo <repo>] [--not-ready "<blockers>"]
```

It re-fetches the ticket from Linear and stores a hash of the description. Without `--not-ready` the outcome is recorded as ready. `--not-ready` records the blockers instead. The hash is how the dashboard and `/tonight` know a description changed after the prep.

`prep-status` prints one JSON line per Todo ticket in the project's `linearTeams`, with its prep state. `/tonight` uses it for its prep column:

```sh
npm run -s prep-status -- --project <name>
```

### Each morning on the dashboard

- **Run banner.** While a night is running, a banner shows the ticket, the phase and the time elapsed. It reads `logs/<name>/run.json`, which the runner refreshes every minute. If the heartbeat is more than 3 minutes old, the banner says the run looks stopped.
- **Outstanding.** One list of what needs you: tickets that ended `needs_review`, `partial` or `error`, open PRs with their CI result, votes and auto-complete state, and the postmortem suggestions. Each item has a checkbox. The checkboxes are the same ones as in the report, kept in `state/actions.json`, so a tick in one shows in the other.
- **Nights.** One row per report with ticket counts, budget used, duration, suggestions and outstanding items. Reports from before the JSON output only get a link. Reports directly under `reports/` are listed as project `legacy`.

### Projects

`/projects` lists each project with its overall file-check status: config, default repo, `.env` keys, `AGENTS.md` and the test database script. The `linearTeams` and `az` login checks run on the project's own page. Open a project to edit its `project.json`, or use "New project" to create one from `projects/example`. Creating a project doesn't write `.env`. It tells you which keys to fill in at `projects/<name>/.env`.

### Security

The server binds to 127.0.0.1 and only accepts requests whose `Host` is `127.0.0.1` or `localhost` on its port. Every write needs an `X-Nightshift: 1` header and, if there is an `Origin`, it has to be the dashboard's own. The one exception is ticking a checkbox in a report you opened from disk. That report sends the tick to the dashboard when it's running, and keeps it in the browser when it isn't.

## Development

```sh
npm test
npm run typecheck
```

### Replaying a review

`replay-review` re-runs the finders and the confirm step against a change from an earlier night, without the implementer run, the fixer or any PR. It spends real usage, so it isn't part of `npm test`:

```sh
npm run -s replay-review -- --project <name> --ticket <ID> --base <sha> \
  --diff logs/<name>/<ID>-diff.txt --report logs/<name>/<ID>-output.txt [--related ID=branch ...]
```

It adds a detached worktree under the system temp directory at `<sha>`, applies the diff and commits it there, fetches the ticket from Linear and parses the implementer's report. It then prints the confirmed findings, the risks (with a `[data]` marker), the rulings on the implementer's decisions, each lens's outcome (the bugs finder runs twice, so it appears as `bugs` and `bugs (pass 2)`), and the usage of every run with a total. Raw outputs go to `logs/<name>/replay-<date>/`, with the second bugs pass in its own `review-bugs-2` log. The temporary worktree is removed afterwards; your branches and other worktrees are never touched. The repo has no `node_modules` in the replay, so the finders can read code but not run tests, and no check results are passed in. `--related` takes branches of related tickets for the reuse lens.

To judge a replay against a synthetic export example:

1. Use the base commit recorded for that change. For a stacked ticket, use its parent's commit from the same night rather than the current default branch. Check that the saved diff applies before running agents.
2. Write down the known issues in that diff, such as an export that reads only its first row or reports success without writing a file, and check whether the review surfaces them.
3. Check that choices left open by the ticket appear as risks or decisions, rather than being silently treated as requirements.
4. To exercise decision parsing, replay a report with choices in its notes and another with the same choices in a structured `decisions:` list.
5. Compare each lens's candidates with the confirmation verdicts and compare the usage cost with the original run.

