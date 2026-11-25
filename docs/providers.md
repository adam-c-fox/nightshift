# Adding a provider

Nightshift has two provider interfaces today: `PrHost`, in [`src/pr-host.ts`](../src/pr-host.ts), and `IssueTracker`, in [`src/issue-tracker.ts`](../src/issue-tracker.ts). Azure DevOps is the only PR host and Linear is the only issue tracker. Part A covers adding another PR host. Part B covers adding another issue tracker. Part C covers adding a new kind of provider, such as another coding agent.

## A. A new PR host

1. **Read the interface and its contract suite.** The interface is [`src/pr-host.ts`](../src/pr-host.ts) and the suite is [`tests/pr-host-contract.ts`](../tests/pr-host-contract.ts). The doc comment on each method is the spec. Don't widen the interface for one host. If a host can't do something, the implementation returns the neutral "unknown" or "none" value, and the limitation goes in [`supported-scope.md`](supported-scope.md).
2. **Write the contract call first.** Add `tests/pr-host-<kind>.test.ts` calling `describePrHostContract("<kind>", world => …)` with a fake `Exec`. Follow [`tests/pr-host-azure-devops.test.ts`](../tests/pr-host-azure-devops.test.ts). Watch every scenario fail. Add the descriptor's remote-parsing table test and unit tests for host-only mapping alongside it.
3. **Create `src/pr-hosts/<kind>/index.ts`** exporting one `PrHostDescriptor`. Kind names are kebab-case and match the product (`github`, `gitlab`). Keep transport, mapping and waits in sibling files, as `src/pr-hosts/azure-devops/` does. Every call goes through the injected `Exec`.
4. **Add one entry to the `PR_HOSTS` table** in `src/pr-host.ts`. That is the only registration: there is no registry and nothing is loaded dynamically. The entry makes the kind a valid `prHost`, adds its `envKeys` to the dashboard's `.env` check, leaves its `secretEnvKeys` out of that check, and adds its `agentDeniedDomains` to the agent sandbox's deny list. It also lets `npm run pr-host` detect the host from a remote.
5. **Let errors through unchanged.** Don't write per-host hint text. Neutral callers already say what they were doing.
6. **Config.** A project selects the host with `"prHost": "<kind>"` in `project.json`. The key is required and has no default. The host's `envKeys` go in the project `.env`. Its `secretEnvKeys` go in the root `.env`.
7. **The setup skill needs no change.** It runs `npm run pr-host -- <origin-url>` and writes what that prints. Check the output for each remote form the host uses.
8. **Update the docs.** [`supported-scope.md`](supported-scope.md), the README table and prerequisites, [`setup.md`](setup.md) (CLI install, env table, cron `PATH`) and [`architecture.md`](architecture.md).
9. **Validate end to end** on a disposable real project: setup through the skill, authentication, draft PR creation, a failing and then fixed required check, CI-fix log retrieval, a stacked ticket, a review-comment sweep with reply and resolve, an auto-merge hold, and the dashboard evening and morning views and project checks.

## B. A new issue tracker

1. **Read the interface and its contract suite.** The interface is [`src/issue-tracker.ts`](../src/issue-tracker.ts) and the suite is [`tests/issue-tracker-contract.ts`](../tests/issue-tracker-contract.ts). The doc comment on each method is the spec. Don't widen the interface for one tracker. If a tracker can't do something, the implementation returns the neutral "unknown" or "none" value, and the limitation goes in [`supported-scope.md`](supported-scope.md).
2. **Write the contract call first.** Add `tests/issue-tracker-<kind>.test.ts` calling the contract suite with a fake `fetch`. Follow [`tests/issue-tracker-linear.test.ts`](../tests/issue-tracker-linear.test.ts). Watch every scenario fail. Add unit tests for tracker-only mapping alongside it.
3. **Create `src/issue-trackers/<kind>/index.ts`** exporting one `IssueTrackerDescriptor`. Kind names are kebab-case and match the product (`jira`, `github-issues`). Keep transport and mapping in sibling files, as `src/issue-trackers/linear/` does. Every call goes through the injected `fetch`.
4. **Add one entry to the `ISSUE_TRACKERS` table** in `src/issue-tracker.ts`. That is the only registration: there is no registry and nothing is loaded dynamically. The entry makes the kind a valid `issueTracker`, adds its `envKeys` to the dashboard's `.env` check, and adds its `agentDeniedTools` to the agent sandbox's deny list.
5. **Config.** A project selects the tracker with `"issueTracker": "<kind>"` in `project.json`. The key is required and has no default. `trackerProjects` names the tracker-side projects the nightshift project owns, and `trackerTeams` lists the ID prefixes the PR sweep accepts. All projects must name the same tracker, because the queue is cross-project (`sharedTrackerKind` in `project.ts`).
6. **Credentials** go in the root `.env`, listed in the descriptor's `envKeys`. The shared queue reads them machine-wide, outside any one project, so the root `.env` is their home.
7. **Ticket IDs.** `identifier` must match `TICKET_ID` (`[A-Z]+-\d+`, in `tickets.ts`). Branches, worktree paths, logs and `state/` keys all derive from it. If native IDs don't fit, map them into that format reversibly. `PR` is reserved by the PR sweep's `PR-<n>` IDs, so a tracker can't use it as a prefix.
8. **Let errors through unchanged.** Don't write per-tracker hint text.
9. **Update the docs.** [`supported-scope.md`](supported-scope.md), the README table, [`setup.md`](setup.md) (env table, `project.json` keys), the setup skill's question about `issueTracker`, [`architecture.md`](architecture.md) and this file.
10. **Validate end to end** on a disposable real project: setup through the skill, the evening view and `prep-status`, a queued ticket moving to In Progress and In Review, a PR-sweep ticket ID, `/prep` and `/tonight` through the tracker's connector, and the dashboard project checks.

## C. A new kind of provider

Another coding agent, or any role with no interface yet. The first job is to make one. Parts A and B are the worked examples.

1. **List the call surface first.** Grep every call the runner, dashboard, prep commands and skills make into the current provider (`claude.ts` and `codex.ts` for a coding agent). Write the file and line table. The interface is that list and nothing more.
2. **Create the interface file** `src/<role>.ts` (`src/pr-host.ts`, `src/issue-tracker.ts`, `src/coding-agent.ts`) containing:
   - the neutral types and the async interface, with a one-line doc comment per method
   - a `<Role>Descriptor` holding `create` plus whatever static facts setup, sandbox and checks need, including where credentials live: a role used by a cross-project flow keeps them in the root `.env`
   - the `<ROLE>S` table, `<Role>Kind = keyof typeof <ROLE>S`, and `create<Role>(kind, lookup, exec)`

   Implementations go in `src/<role>s/<kind>/`, for example `src/pr-hosts/azure-devops/`. One entry per implementation in the table, with no registry.
3. **Replace provider types at the boundary.** Domain types such as `Ticket` must not carry provider shapes. Decide one canonical ID format in the interface (for tickets, `TICKET_ID`) and map native IDs into it reversibly. Persisted records that embed provider types, such as session JSON, need a renamed field read with a fallback.
4. **Add a required config key** to `project.json` (`"prHost": "azure-devops"`, `"codingAgent": "claude"`). Validate it in `parseProjectConfig` against the table's keys, update `templates/project/project.json`. `projects/` is gitignored, so the key can't be added to existing projects in git. Fail old key names with a rename message and put the migration in the PR description.
5. **Write the contract suite first** in `tests/<role>-contract.ts` as `describe<Role>Contract(label, fixture)` over a neutral fake world and a fake transport: `Exec` for CLIs, `fetch` for HTTP. Make the existing provider pass it before adding a second.
6. **Move the existing provider behind the interface with no behaviour change.** The existing tests are the behaviour contract. They may gain `await`, change import paths when the provider module moves, or gain an input-mapping step, but their expected values must not change. List any intended change explicitly.
7. **Let errors through unchanged.** No per-provider error text.
8. **Build instances from project config, never branch on the kind.** The instance is created where the project is entered (`ProjectContext` in `night.ts`) and, in the dashboard, built per request from the project's config (`dashboard/sources.ts`). Callers take the instance from there. A role used by the shared queue (evening view, queue add, `prep-status`) has no single project, so pick the kind from all projects (`sharedTrackerKind`) and fail loudly when they disagree.
9. **Wire the edges from the descriptor, not by kind:** prep commands, skills, dashboard queries and project checks, and the sandbox and credentials in `agent-env.ts`. Skills that reach the provider through MCP connectors keep doing so, with wording that names the configured provider. Move reads to npm commands only when two implementations need one shared definition.
10. **Update the docs:** [`supported-scope.md`](supported-scope.md), the README, [`setup.md`](setup.md), [`architecture.md`](architecture.md) and this file.
11. **Validate end to end** on a disposable real project before adding a second implementation.
