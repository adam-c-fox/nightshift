---
name: tonight
description: Draft tickets/tonight.md from your Linear Todo tickets, with you, before the nightshift run.
disable-model-invocation: true
---

Plan tonight's nightshift run with Adam: fetch his Linear Todo tickets, draft `tickets/tonight.md` together, and write it.

The runner works tickets in file order, so order is priority. `tickets/tonight.md` is gitignored. The file format is in the header comment of `tickets/tonight.example.md` and in `parseTickets` in `src/tickets.ts`.

Linear MCP tools are `mcp__claude_ai_Linear__list_issues`, `mcp__claude_ai_Linear__get_issue` and `mcp__claude_ai_Linear__list_comments`. If their parameters are deferred, load them with ToolSearch first.

## Steps

1. Read `tickets/tonight.md`; if it doesn't exist, copy `tickets/tonight.example.md` to it and delete the example tickets. If `## <ID> – …` headings exist outside the HTML comment, show them and ask Adam: replace, append, or stop.
   Done when Adam has chosen, or the file has no tickets.

2. Fetch candidates with `list_issues`, assignee `me`, state `Todo` only. If the Linear MCP is unavailable, run the same query through the `linear:linear-api` skill. If there are none, tell Adam and stop.
   Done when you hold every Todo ticket assigned to Adam.

3. Show a numbered list: ID, title, team, priority, estimate. Ask which to run tonight, as numbers or IDs, in priority order, and tell him the runner works tickets in file order, so order is priority.
   Done when Adam has named an ordered set.

4. For each picked ticket, fetch the full issue with `get_issue` and its comments with `list_comments`.
   Done when every picked ticket has both.

5. Infer each ticket's repo: `terraform` when the team, labels, title or description point at infrastructure (Terraform, `.tf`, azurerm, resource group, module, App Service plan, storage account, Key Vault, networking, IaC), otherwise `main`. Repo paths live in `REPOS` in `src/repos.ts`.
   Done when every ticket has a repo.

6. Draft up to 5 one-line context bullets per ticket, covering:
   - acceptance criteria worth stressing;
   - decisions and constraints from comments;
   - likely files, found with `grep -rln --exclude-dir={node_modules,.terraform,.git} <identifier> <repo path>` on identifiers named in the ticket, written as `see <path>`;
   - areas the agent should leave alone.

   The agent already receives the description, so bullets add what the description lacks.
   Done when each ticket has bullets, each adding something the description lacks.

7. Look up open PRs for all picked tickets in one read-only call: `npm run -s open-prs -- <repo>:<ID> …`, for example `main:ENG-142 terraform:INF-7`. It prints one JSON line per ticket. It fetches each ticket's Linear branch name (so it needs `LINEAR_API_KEY`). The runner continues an open PR whose source branch is that name exactly or that name plus `-<digits>` (see `pickTicketPr` in `src/pr.ts`).
   A non-null `pr` means the ticket is requeued: mark it "requeued, continues PR #N", ask Adam what feedback the agent should address, and write his answer as bullets saying what to change on top of the existing PR.
   If the line has `"autoComplete": true`, warn Adam: the runner will not push to that PR (it would merge unreviewed), so tonight's work stays on a local branch and the ticket ends as needs_review. Suggest he cancels auto-complete first.
   An `error` line or a non-zero exit means: say so and treat that ticket as new.
   Done when each ticket is marked new or requeued, and every requeued ticket has Adam's feedback as bullets.

8. Show the complete draft: the header comment as it stands in the file, then one `## <ID> – <title>` / `repo: <repo>` / `- bullet` section per ticket, with each inferred repo highlighted. Ask Adam to confirm or edit, and repeat until he approves.
   Done when Adam has approved the draft.

9. Write `tickets/tonight.md`. Validate with:
   `npx tsx -e 'import("./src/tickets.ts").then(m => console.log(JSON.stringify(m.loadTickets(), null, 1)))'`
   Compare the parsed IDs, repos and order with the draft; fix and re-run until they match.
   Done when the parsed output matches the approved draft.

10. Finish with one line per ticket (ID, repo, "continues PR #N" or "new") and the reminder that `npm run run:dry` previews the night.
    Leave the night run and Linear tickets as they are.
    Done when the summary is shown.
