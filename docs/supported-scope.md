# Supported scope and extension points

Nightshift can work across different codebases without changing its source when they fit the stack below. Repo paths, routing descriptions, project instructions, Linear teams, test database scripts and nightly Claude allowances are project configuration. Providers, check commands and agent integrations are code.

There is no connector registry or provider interface today. New integrations are feasible, but adding one means changing and testing the runner and its related tools.

## What works today

| Area | Current support |
| --- | --- |
| Projects | Multiple local git repos per project, with absolute paths and a default repo. Each repo selects `node` or `terraform`. |
| Tickets | Linear descriptions, comments, assignees and workflow states. The evening list uses the state name `Todo`; the runner looks for a started state and an `In Review` state. Ticket IDs use letters followed by a number, such as `ENG-142`. |
| PRs and remote CI | Azure DevOps through `az`, including existing PRs, reviewer votes, auto-complete, branch policies, build runs and failure logs. A project's repos share its Azure organization/project settings. |
| Node repos | npm with a root `package-lock.json`, Vitest and optional npm workspaces. Worktrees run `npm ci`; checks run root `build`, `typecheck`, `lint`, `format` and Vitest, plus each workspace's `npm test`. |
| Terraform repos | Root-module discovery, `init -backend=false`, `validate` and recursive `fmt -check`. The runner does not run `plan` or `apply`. |
| Implementation and review | Claude Code implements and fixes changes, confirms review candidates and runs the postmortem. Codex supplies an additional read-only review pass; an unavailable Codex pass is recorded as skipped. |
| Test services | An optional executable project script accepts `up` and `down`. `up` prints one URL, exported as `TEST_DATABASE_URL`. The example runs Postgres in Docker. |
| Dashboard | A local HTTP server at `127.0.0.1:4100`. The login/startup installer uses macOS LaunchAgents. Herdr is optional; launch buttons offer a Claude command when it is unavailable. |

The exact configuration is validated in [`project.ts`](../src/project.ts). Check discovery and commands live in [`checks.ts`](../src/checks.ts); dependency installation and git worktrees live in [`worktree.ts`](../src/worktree.ts).

## Runtime assumptions

Use Node 22.12+ or Node 24 LTS, npm, git and a Unix shell. CI checks Node 22 and 24 on Linux; macOS is the development environment. The runner uses `sh`, Unix signals and `/dev/null`; Linux use still needs a working Claude sandbox and validation of the full unattended flow. Native Windows is not supported. The LaunchAgent installer is macOS-only.

An unattended run needs authenticated access to Linear, Azure DevOps and Claude Code, plus git credentials for fetching and pushing. The OAuth-token usage probe invokes `curl`. Install Terraform for Terraform repos and Docker only if the configured test database script uses it. Codex needs its own login for the extra review pass.

The budget logic assumes accounts that expose weekly and five-hour usage windows. It does not provide a dollar-denominated API spending cap. CLI flags, event formats and usage responses are integration dependencies, so a passing unit suite does not establish compatibility with every CLI release or account type.

Model defaults are currently source constants:

| Run | Default | Location |
| --- | --- | --- |
| Claude implementation and fixes | The installed CLI's default model, at high effort | [`claude.ts`](../src/claude.ts) |
| Claude review and confirmation | `claude-opus-5-5`, at high effort | [`claude.ts`](../src/claude.ts) |
| Candidate deduplication | `claude-sonnet-5-5`, at low effort | [`claude.ts`](../src/claude.ts) |
| OAuth usage probe | `claude-haiku-4-5-20251001`, with a one-token request | [`budget.ts`](../src/budget.ts) |
| Codex review | `gpt-6.1-sol`, at high effort | [`codex.ts`](../src/codex.ts) |

These names must be available to the installed CLI/account. The normal runner does not expose model selection in `project.json`; `replay-review --codex-model` can override the Codex model for a replay. Codex's nightly allowance is a fixed 20%. Report dates and reset displays use `America/Vancouver` in [`time.ts`](../src/time.ts), independently of the machine's cron timezone.

Agents receive restricted credentials and tool permissions. The network allowlist permits the npm registry and local services for Node, or the Terraform registry for Terraform. Tests that need other hosts or additional service variables need explicit accommodation. See [`agent-env.ts`](../src/agent-env.ts) and the tool profiles in [`claude.ts`](../src/claude.ts).

## Adding integrations

Adding another project on the supported stack is configuration work. Adding another provider is a code change. The useful starting points are:

| Integration | Starting points | Work beyond the API calls |
| --- | --- | --- |
| GitHub or GitLab PRs | [`pr.ts`](../src/pr.ts), [`ci-logs.ts`](../src/ci-logs.ts), [`dashboard/azure.ts`](../src/dashboard/azure.ts) | Normalize open/update PR operations, branch matching, check status, failure logs, votes and auto-merge protection. Wire the provider into the runner, dashboard, project checks and setup skill. Azure branch-policy and stacked-build behavior needs an equivalent or an explicit supported limitation. |
| Jira or GitHub Issues | [`linear.ts`](../src/linear.ts), [`types.ts`](../src/types.ts), [`tickets.ts`](../src/tickets.ts) | Normalize ticket content, comments, assignment and state transitions. Update prep commands, skills, dashboard queries and ticket-ID validation. GitHub's numeric issue IDs need a repository-qualified identity so tickets from different repos cannot collide. |
| Another coding agent | [`claude.ts`](../src/claude.ts), [`codex.ts`](../src/codex.ts), [`budget.ts`](../src/budget.ts) | Implement process arguments, authentication, event/output parsing, usage accounting, retries and sandbox permissions. The structured report/review blocks are reusable, but confirmation, fixing and postmortem runs still depend on Claude. |
| Another package manager or language | [`types.ts`](../src/types.ts), [`project.ts`](../src/project.ts), [`checks.ts`](../src/checks.ts), [`worktree.ts`](../src/worktree.ts) | Add toolchain validation, dependency installation, test/build discovery, network rules and allowed commands. Update the agent instructions and setup skill. Commands are not configurable per project today. |

For a second PR host, first extract a small provider interface around the operations the runner already calls, then implement both Azure and the new host against it. Share that provider between the runner and dashboard rather than adding another set of provider conditionals. For a second issue tracker, do the same with ticket retrieval and workflow updates, and replace Linear-specific domain types at that boundary.

The core worktree, check-comparison, review-confirmation and report logic can stay. [`runner.ts`](../src/runner.ts) and [`dashboard/sources.ts`](../src/dashboard/sources.ts) currently import providers directly, so changing only one API module will not complete a connector. Use the existing provider tests as behavior contracts, then validate authentication, PR creation, CI failure handling and status updates in a disposable real project.
