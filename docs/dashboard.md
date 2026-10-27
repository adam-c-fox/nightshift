# Dashboard

The dashboard is a local web page for the evening and the morning. It shows what to prep and plan before you log off, and what needs you after a night. Besides reading and writing files in this repo, it calls Linear and Azure DevOps with the same credentials as the runner, runs the usage check, runs git in the configured repo paths and launches herdr.

## Install

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

## Before clocking off

The home page has a project picker and a "Before clocking off" section for the selected project:

- **Todo tickets.** Your Linear Todo tickets, limited to the project's `linearTeams`, with priority, estimate, prep state, position in `tonight.md` and any open PR. Tickets that are in `tonight.md` but no longer in Todo are listed too, with their Linear state.
- **Prep state.** One of:
  - `fresh`: prepped with `/prep`, the description hasn't changed since and there are no newer comments.
  - `stale`: the description changed after `/prep`.
  - `new comments`: comments arrived after `/prep`.
  - `not ready`: `/prep` recorded blockers. Hover the badge to read them.
  - `inferred`: there's no `/prep` record, but the description already has a Decisions, Acceptance criteria or Pointers section.
  - `none`: no record and no such section.
- **Allowance and usage.** Tonight's allowance and where it comes from (`tonight.md` or the project default), and the weekly usage with its reset time, with the Codex weekly usage and its 20% nightly allowance next to it.
- **Warnings.** A ticket in `tonight.md` that Linear can't find, that isn't in Todo or isn't assigned to you; one that is unprepped, stale or not ready; a PR with auto-complete set, which the runner won't push to; and a weekly reset within 24 hours, when `allowance: 100` may be worth setting. If Linear is unavailable or `tonight.md` has a parse error, the page says so and still lists what it can.
- **Prep and Plan tonight.** Each row has a Prep button and the section has a Plan tonight button. They open a herdr workspace running `/prep <ID> <project>` or `/tonight <project>`. If herdr isn't installed or isn't running, the dashboard copies the equivalent `claude` command to your clipboard instead.
- **Refresh.** Clears the caches and reloads. Linear tickets are cached for 5 minutes, PRs and their CI results for 5 minutes, usage for 10 minutes and the Linear team list for 1 hour.

## Prep memory

`/prep` records what it did in `state/prep.json` with `prep-mark`:

```sh
npm run -s prep-mark -- <ID> --project <name> [--repo <repo>] [--not-ready "<blockers>"]
```

It re-fetches the ticket from Linear and stores a hash of the description. Without `--not-ready` the outcome is recorded as ready. `--not-ready` records the blockers instead. The hash is how the dashboard and `/tonight` know a description changed after the prep.

`prep-status` prints one JSON line per Todo ticket in the project's `linearTeams`, with its prep state. `/tonight` uses it for its prep column:

```sh
npm run -s prep-status -- --project <name>
```

## Each morning on the dashboard

- **Run banner.** While a night is running, a banner shows the ticket, the phase and the time elapsed. It reads `logs/<name>/run.json`, which the runner refreshes every minute. If the heartbeat is more than 3 minutes old, the banner says the run looks stopped.
- **Outstanding.** One list of what needs you: tickets that ended `needs_review`, `partial` or `error`, open PRs with their CI result, votes and auto-complete state, and the postmortem suggestions. Each item has a checkbox. The checkboxes are the same ones as in the report, kept in `state/actions.json`, so a tick in one shows in the other.
- **Nights.** One row per report with ticket counts, budget used, Codex used, duration, suggestions and outstanding items. Reports from before the JSON output only get a link. Reports directly under `reports/` are listed as project `legacy`.

## Projects

`/projects` lists each project with its overall file-check status: config, default repo, `.env` keys, `AGENTS.md` and the test database script. The `linearTeams` and `az` login checks run on the project's own page. Open a project to edit its `project.json`, or use "New project" to create one from `projects/example`. Creating a project doesn't write `.env`. It tells you which keys to fill in at `projects/<name>/.env`.

## Security

The server binds to 127.0.0.1 and only accepts requests whose `Host` is `127.0.0.1` or `localhost` on its port. Every write needs an `X-Nightshift: 1` header and, if there is an `Origin`, it has to be the dashboard's own. The one exception is ticking a checkbox in a report you opened from disk. That report sends the tick to the dashboard when it's running, and keeps it in the browser when it isn't.
