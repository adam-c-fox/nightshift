# Supported scope and extension points

Nightshift can work across different codebases without changing its source when they fit the stack below. Repo paths, routing descriptions, project instructions, tracker projects, and test database scripts are project configuration. The nightly Claude allowance is one setting for every project. Each repo's setup and check commands are configuration too. Providers and agent integrations are code.

PR hosts sit behind the `PrHost` interface in [`pr-host.ts`](../src/pr-host.ts). Each project picks one with the required `prHost` key in `project.json`, and Azure DevOps is the only implementation. Issue trackers sit behind the `IssueTracker` interface in [`issue-tracker.ts`](../src/issue-tracker.ts). Each project picks one with the required `issueTracker` key, and Linear is the only implementation. All projects must use the same tracker, because the queue is shared. The coding agent has no interface yet, so adding one means changing and testing the runner and its related tools.

## What works today

| Area | Current support |
| --- | --- |
| Projects | Multiple local git repos per project, with absolute paths and a default repo. Each repo lists its own `setup` and `checks` commands, sandbox `network` hosts and agent `tools`. |
| Tickets | `issueTracker: linear`: Linear descriptions, comments, assignees and workflow states. The evening list uses the state name `Todo`; the runner looks for a started state and an `In Review` state. Ticket IDs use letters followed by a number, such as `ENG-142`; every tracker's IDs must match that format. |
| PRs and remote CI | `prHost: azure-devops`, through `az`, including existing PRs, reviewer votes, auto-complete, branch policies, build runs and failure logs. A project's repos share its Azure organization/project settings. |
| Target repos | Any repo whose setup and checks are shell commands. A command can run once per directory matched by a file glob. |
| Implementation and review | Claude Code implements and fixes changes, confirms review candidates and runs the postmortem. Codex supplies an additional read-only review pass; an unavailable Codex pass is recorded as skipped. |
| Test services | An optional executable project script accepts `up` and `down`. `up` prints one URL, exported as `TEST_DATABASE_URL`. The example runs Postgres in Docker. |
| Dashboard | A local HTTP server at `127.0.0.1:4100`. The login/startup installer uses macOS LaunchAgents. Prep steps run `claude -p` and need `CLAUDE_CODE_OAUTH_TOKEN`. |

The exact configuration is validated in [`project.ts`](../src/project.ts). Check expansion lives in [`checks.ts`](../src/checks.ts); setup commands and git worktrees live in [`worktree.ts`](../src/worktree.ts).

## Runtime assumptions

Use Node 22.12+ or Node 24 LTS, npm for nightshift itself, git and a Unix shell. CI checks Node 22 and 24 on Linux; macOS is the development environment. The runner uses `sh`, Unix signals and `/dev/null`; Linux use still needs a working Claude sandbox and validation of the full unattended flow. Native Windows is not supported. The LaunchAgent installer is macOS-only.

An unattended run needs authenticated access to Linear, Azure DevOps and Claude Code, plus git credentials for fetching and pushing. The OAuth-token usage probe invokes `curl`. Install whatever runtimes a repo's commands need, and Docker only if the configured test database script uses it. Codex needs its own login for the extra review pass.

The budget logic assumes accounts that expose weekly and five-hour usage windows. It does not provide a dollar-denominated API spending cap. CLI flags, event formats and usage responses are integration dependencies, so a passing unit suite does not establish compatibility with every CLI release or account type.

Model defaults are set in the root `.env`; the values below apply when a key is unset:

| Run | Default | Key |
| --- | --- | --- |
| Claude implementation and fixes | The installed CLI's default model | `IMPLEMENTATION_MODEL` |
| Claude effort (all runs except deduplication) | `high` | `NIGHTSHIFT_CLAUDE_EFFORT` |
| Claude review and confirmation | `claude-opus-5-5` | `REVIEW_MODEL` |
| Candidate deduplication | `claude-sonnet-5-5`, always at low effort | `DEDUPE_MODEL` |
| OAuth usage probe | `claude-haiku-4-5-20251001`, with a one-token request | `USAGE_PROBE_MODEL` |
| Codex review | `gpt-6.1-sol`, at high effort | `CODEX_MODEL` / `CODEX_EFFORT` |

These names must be available to the installed CLI/account. They are machine-wide root `.env` settings, not per project. `replay-review --codex-model` can override the Codex model for a replay. Codex's nightly allowance is `CODEX_ALLOWANCE_PERCENT` (default 20). Report dates and reset displays use `NIGHTSHIFT_TIME_ZONE` (default `America/Vancouver`), independently of the machine's cron timezone. An invalid value stops the run at startup with a message naming the key.

Agents receive restricted credentials and tool permissions. The network allowlist is the repo's `network` list. Tests that need additional service variables need explicit accommodation. See [`agent-env.ts`](../src/agent-env.ts) and the tool profiles in [`claude.ts`](../src/claude.ts).

## Adding integrations

Adding another project, including one with a different package manager or language, is configuration work. Adding another provider is a code change. The useful starting points are:

| Integration | Starting points | Work beyond the API calls |
| --- | --- | --- |
| GitHub or GitLab PRs | [`pr-host.ts`](../src/pr-host.ts), [`pr-hosts/azure-devops/`](../src/pr-hosts/azure-devops), [`pr-host-contract.ts`](../tests/pr-host-contract.ts) | Implement the `PrHost` interface and add one entry to `PR_HOSTS`. Azure branch-policy and stacked-build behavior needs an equivalent or an explicit supported limitation. See [providers.md](providers.md), part A. |
| Jira or GitHub Issues | [`issue-tracker.ts`](../src/issue-tracker.ts), [`issue-trackers/linear/`](../src/issue-trackers/linear), [`issue-tracker-contract.ts`](../tests/issue-tracker-contract.ts) | Implement `IssueTracker` and pass the contract suite. Native IDs that don't match `[A-Z]+-\d+` (GitHub's numeric issue numbers, for example) must map reversibly into it, with a prefix per repository, and `PR` is reserved by the PR sweep. All projects share one tracker, so mixing trackers needs ID namespacing first. Follow [providers.md](providers.md), part B. |
| Another coding agent | [`claude.ts`](../src/claude.ts), [`codex.ts`](../src/codex.ts), [`budget.ts`](../src/budget.ts) | Implement process arguments, authentication, event/output parsing, usage accounting, retries and sandbox permissions. The structured report/review blocks are reusable, but confirmation, fixing and postmortem runs still depend on Claude. |

To add a PR host, follow [providers.md](providers.md), part A. To add an issue tracker, follow part B. For a coding agent, follow part C: list the calls the runner already makes, put an interface around them, and replace provider-specific domain types at that boundary.
