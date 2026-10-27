# Architecture and design decisions

Nightshift is a local TypeScript runner that coordinates git, issue tracking, coding agents and CI. It runs tickets in file order. Each ticket produces a structured record and a human-readable report; it does not merge its PRs.

## Worktrees isolate tickets

The runner reads `projects/<name>/tonight.md` and fetches the Linear ticket and comments. It moves eligible tickets to In Progress, then creates a worktree beside the target repo, such as `/code/app-ENG-142` for `/code/app`.

A new ticket starts from the remote default branch, falling back to `main` when that default is unavailable. An existing PR continues on its own branch. A ticket with `base: <ID>` starts from an earlier ticket's pushed branch in the same repo and targets that branch when opening its PR. A dependent ticket is skipped when its base was not pushed.

Worktrees get their own dependency installation. This keeps one ticket's files and dependencies separate from another's. The runner owns git commits and pushes; the agent is instructed and permission-restricted against publishing changes itself.

## Baseline checks distinguish regressions

Before implementation, the runner records the repo's build, type, lint, formatting and test results, or Terraform validation and formatting results. It runs the checks again after the change and compares them against the baseline.

A failure already present on the base is reported separately from a regression. A check that never started is unproven, rather than a passing test. Agents receive both sets of results so they can investigate relevant failures without treating unrelated base failures as their own.

Generic instructions in [`AGENTS.md`](../AGENTS.md) are combined with the project's instructions. The implementation agent works test-first and returns a structured report with tests, verification commands, decisions it made and unrelated problems it left alone.

## Independent finders propose, confirmation decides

Review runs sequentially through five passes: bugs, a second independent bugs pass, spec, reuse and Codex. The repeated bugs pass uses the same prompt because an individual run can miss a problem. The [finder prompts](../prompts/review.md) share a candidate format.

Codex is a read-only finder. Its candidates go through the same confirmation path as Claude's. An unavailable or failed Codex pass is recorded in the report without changing the ticket's status by itself. Claude handles confirmation and fix review.

When there are more than four candidates, a tool-free deduplication run groups reports of the same issue. Confirmation then reads at most four groups per batch. Confirmed and rejected verdicts cite a file line and quote it; the runner verifies the citation against the worktree.

An unsupported rejection becomes an unproven risk, shown as "worth a closer look" in the PR. A rejection that admits the reported behavior happens is also unproven, unless a quoted ticket requirement establishes a ticket conflict. Conflicts are left for a person, mark the ticket `needs_review`, and appear under "Decisions needed" in the report and "Needs a decision before merge" in the PR.

## Fixes receive their own review

The fixer addresses confirmed issues. A read-only fix review checks its claims and the diff between snapshots before and after the fix, including affected callers and tests. New candidates go through confirmation and can receive one further fix round with its own review.

Unresolved major findings require review; unresolved blocker findings prevent publication. Before publication, the runner also checks whether an existing PR has auto-complete enabled. It leaves the work local rather than pushing a change that could merge automatically.

The runner commits and opens or updates the PR. If remote CI fails, it retrieves the logs and makes up to two repair attempts. Tickets ending `done` or `needs_review` move to In Review in Linear when the team has that state. Human review remains the final step before merge.

## Budgets follow account usage windows

Claude receives 15% of weekly usage per night by default, configurable through `allowancePercent`. A header `allowance: <pct>` in `tonight.md` overrides the project for one night; `--allowance <pct>` overrides both. The cap is the starting weekly usage plus the allocation, limited to 100%. The one-night header override is removed when tickets are archived.

The runner checks usage before starting more work. If five-hour session usage reaches 80%, it waits for the reset. A Claude run interrupted by a session limit can resume after the reset, up to twice, while the weekly cap remains open. The usage reader uses the OAuth probe when a Claude OAuth token is configured and otherwise invokes the CLI's usage command.

Codex has a separate fixed allocation of 20% of weekly usage, read through `codex app-server`. It waits for the five-hour reset and retries a usage-limited review once. Reports show Claude and Codex allocation and token usage separately. These controls depend on provider usage reporting and do not enforce a dollar spending limit.

Model constants, CLI assumptions and timezone behavior are listed in [supported scope](supported-scope.md#runtime-assumptions).

## Reports preserve what happened

The runner saves agent output, check results and usage in `logs/<name>/`. HTML and JSON night records go in `reports/<name>/`. A heartbeat records the current phase for the dashboard. At the end, the ticket list is archived beside the report so the next night does not rerun it.

A final read-only postmortem reviews the night's logs and suggests instruction or workflow changes. It never applies them. It is skipped for dry runs, when no ticket was worked, or when usage has run out, with the reason recorded in the report.

Review and fix-review replays let a developer evaluate this process against a saved change without rerunning implementation or publishing a PR. Golden sets measure which known issues were found and survived confirmation. See [review replay and scoring](review-replay.md).

## Source map

| Responsibility | Modules |
| --- | --- |
| Night lifecycle and ticket order | [`runner.ts`](../src/runner.ts), [`tickets.ts`](../src/tickets.ts), [`stack.ts`](../src/stack.ts) |
| Project configuration and instructions | [`project.ts`](../src/project.ts), [`instructions.ts`](../src/instructions.ts) |
| Isolation and local checks | [`worktree.ts`](../src/worktree.ts), [`checks.ts`](../src/checks.ts), [`agent-env.ts`](../src/agent-env.ts) |
| Agent processes and usage budgets | [`claude.ts`](../src/claude.ts), [`codex.ts`](../src/codex.ts), [`budget.ts`](../src/budget.ts) |
| Review orchestration and citation verification | [`review.ts`](../src/review.ts), [`confirm.ts`](../src/confirm.ts) |
| Linear, Azure PRs and CI repair | [`linear.ts`](../src/linear.ts), [`pr.ts`](../src/pr.ts), [`ci-logs.ts`](../src/ci-logs.ts), [`ci-fix.ts`](../src/ci-fix.ts) |
| Reports and dashboard | [`report.ts`](../src/report.ts), [`night-record.ts`](../src/night-record.ts), [`dashboard/server.ts`](../src/dashboard/server.ts) |
