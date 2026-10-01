---
name: tonight
description: Draft tickets/tonight.md from your Linear Todo tickets, with you, before the nightshift run.
disable-model-invocation: true
---

Plan tonight's nightshift run with Adam: fetch his Linear Todo tickets, draft `tickets/tonight.md` together, and write it.

The runner works tickets in file order, so order is priority. The file format is in the header comment of `tickets/tonight.md` and in `parseTickets` in `src/tickets.ts`.

Linear MCP tools are `mcp__claude_ai_Linear__list_issues`, `mcp__claude_ai_Linear__get_issue` and `mcp__claude_ai_Linear__list_comments`. If their parameters are deferred, load them with ToolSearch first.

## Steps

1. Read `tickets/tonight.md`. If `## <ID> – …` headings exist outside the HTML comment, show them and ask Adam: replace, append, or stop.
   Done when Adam has chosen, or the file has no tickets.

2. Fetch candidates with `list_issues`, assignee `me`, state `Todo`. If the Linear MCP is unavailable, run the same query through the `linear:linear-api` skill. If there are none, tell Adam and stop.
   Done when you hold every Todo ticket assigned to Adam.

3. Show a numbered list: ID, title, team, priority, estimate. Ask which to run tonight, as numbers or IDs, in priority order.
   Done when Adam has named an ordered set.

4. For each picked ticket, fetch the full issue with `get_issue` and its comments with `list_comments`.
   Done when every picked ticket has both.

5. Infer each ticket's repo: `terraform` when the team, labels, title or description point at infrastructure (Terraform, `.tf`, azurerm, resource group, module, App Service plan, storage account, Key Vault, networking, IaC), otherwise `main`. Repo paths live in `REPOS` in `src/runner.ts`.
   Done when every ticket has a repo.

6. Draft up to 5 one-line context bullets per ticket, covering:
   - acceptance criteria worth stressing;
   - decisions and constraints from comments;
   - likely files, found with `grep -rln --exclude-dir={node_modules,.terraform,.git} <identifier> <repo path>` on identifiers named in the ticket, written as `see <path>`;
   - areas the agent should leave alone.

   The agent already receives the description, so bullets add what the description lacks.
   Done when each ticket has bullets, each adding something the description lacks.

7. Check each ticket for an open nightshift PR, read-only: `az repos pr list --status active` against the repository, with organisation and project taken from the `AZURE_DEVOPS_*` names in `.env.example` and read from `.env`. Keep their values out of the output. The runner continues an open PR whose source branch is `night/<ID>` or `night/<ID>-*` (see `pickNightPr` in `src/pr.ts`).
   For a match, mark the ticket "requeued, continues PR #N" and ask Adam what feedback the agent should address. Write his answer as bullets that say what to change on top of the existing PR.
   If `az` fails, say so and treat the tickets as new.
   Done when each ticket is marked new or requeued, and every requeued ticket has Adam's feedback as bullets.

8. Show the complete draft: the header comment as it stands in the file, then one `## <ID> – <title>` / `repo: <repo>` / `- bullet` section per ticket, with each inferred repo highlighted. Ask Adam to confirm or edit, and repeat until he approves.
   Done when Adam has approved the draft.

9. Write `tickets/tonight.md`. Validate with:
   `npx tsx -e 'import("./src/tickets.ts").then(m => console.log(JSON.stringify(m.loadTickets(), null, 1)))'`
   Compare the parsed IDs, repos and order with the draft; fix and re-run until they match.
   Done when the parsed output matches the approved draft.

10. Finish with one line per ticket (ID, repo, "continues PR #N" or "new") and the reminder that `npm run run:dry` previews the night.
    Leave `tickets/tonight.md` uncommitted for Adam to commit, and leave the night run and Linear tickets as they are.
    Done when the summary is shown.
