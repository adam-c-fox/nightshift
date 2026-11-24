# Adding a provider

Nightshift has one provider interface today: `PrHost`, in [`src/pr-host.ts`](../src/pr-host.ts). Azure DevOps is its only implementation. Part A covers adding another PR host. Part B covers adding a new kind of provider, such as an issue tracker or another coding agent.

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

## B. A new kind of provider

An issue tracker (Jira, GitHub Issues) or another coding agent. These have no interface yet, so the first job is to make one.

1. **List the call surface first.** Grep every call the runner, dashboard, prep commands and skills make into the current provider (`linear.ts`, or `claude.ts` and `codex.ts`). Write the file and line table. The interface is that list and nothing more.
2. **Create the interface file** `src/<role>.ts` (`src/issue-tracker.ts`, `src/coding-agent.ts`) containing:
   - the neutral types and the async interface, with a one-line doc comment per method
   - a `<Role>Descriptor` holding `create` plus whatever static facts setup, sandbox and checks need
   - the `<ROLE>S` table, `<Role>Kind = keyof typeof <ROLE>S`, and `create<Role>(kind, lookup, exec)`

   Implementations go in `src/<role>s/<kind>/`, for example `src/issue-trackers/linear/`. One entry per implementation in the table, with no registry.
3. **Replace provider types at the boundary.** Domain types such as `Ticket` must not carry provider shapes. Identities that can collide across instances, such as GitHub issue numbers, need a qualified id decided in the interface.
4. **Add a required config key** to `project.json` (`"issueTracker": "linear"`, `"codingAgent": "claude"`). Validate it in `parseProjectConfig` against the table's keys, update `templates/project/project.json`, and add the key to every existing project in the same change.
5. **Write the contract suite first** in `tests/<role>-contract.ts` as `describe<Role>Contract(label, fixture)` over a neutral fake world and a fake `Exec`. Make the existing provider pass it before adding a second.
6. **Move the existing provider behind the interface with no behaviour change.** The existing tests are the behaviour contract. They may gain `await` or an input-mapping step, but their expected values must not change. List any intended change explicitly.
7. **Let errors through unchanged.** No per-provider error text.
8. **Build instances from project config, never branch on the kind.** The instance is created where the project is entered (`ProjectContext` in `night.ts`) and, in the dashboard, built per request from the project's config (`dashboard/sources.ts`). Callers take the instance from there.
9. **Wire the edges from the descriptor, not by kind:** prep commands, skills, dashboard queries and project checks, and the sandbox and credentials in `agent-env.ts`.
10. **Update the docs:** [`supported-scope.md`](supported-scope.md), the README, [`setup.md`](setup.md), [`architecture.md`](architecture.md) and this file.
11. **Validate end to end** on a disposable real project before adding a second implementation.
