---
name: prep
description: Audit one Linear ticket with you and write the missing context into its description, so the nightshift agent can work it unattended. Takes a ticket ID.
disable-model-invocation: true
---

Prep one Linear ticket with Adam so a nightshift agent can finish it without guessing. Find its gaps, get Adam's decisions, and write them into the ticket's description. `/tonight` later re-checks the night's set as a final pass.

The agent sees the ticket's description and comments, plus the title and bullets in `tickets/tonight.md`. Comments reach it as a raw thread, oldest first, with no sign of which points were settled, so every decision goes into the description.

Linear MCP tools are `mcp__claude_ai_Linear__get_issue`, `mcp__claude_ai_Linear__list_comments` and `mcp__claude_ai_Linear__save_issue`. If their parameters are deferred, load them with ToolSearch first. If the Linear MCP is unavailable, use the `linear:linear-api` skill.

## Steps

1. Take the ticket ID from the arguments, or ask Adam for one. Fetch the issue with `get_issue` and its comments with `list_comments`.
   Done when you hold the ticket and all its comments.

2. Pick the repo with the rule in step 6 of `.claude/skills/tonight/SKILL.md`. Repo paths live in `REPOS` in `src/repos.ts`.
   Ground the ticket in that repo's code: `grep -rn --exclude-dir={node_modules,.terraform,.git,dist}` for every file, function, type, table, route and config key the ticket names, and read the matching code (± 40 lines). Note the test files that cover it and any existing helper the change should reuse.
   Done when every identifier the ticket names is located or confirmed missing, and you know where the tests for it go.

3. Check the ticket against every item in `gaps.md` in this skill's folder, using what you found in the code.
   Done when every item has been checked.

4. Show the gaps as one numbered message, each with your recommended answer drawn from the code. Ask Adam to answer each with a decision, "your call", or "not ready".
   "Not ready" ends the prep: list what the ticket still needs, leave Linear unchanged, and stop.
   Done when every gap has an answer.

5. Draft the new description. Keep the existing text as it is. After it, add only the sections that have content:
   - `## Acceptance criteria`: testable checkboxes, when the ticket has none or they are vague;
   - `## Decisions`: one bullet per gap answer and per decision found only in comments. Write "your call" as "Your call on X; state the choice in notes";
   - `## Pointers`: likely files as `see <path>`, helpers to reuse, areas to leave alone.

   If the description already has a section with one of these names, update it in place. Write it for a developer reading the ticket: plain, specific, with no mention of nightshift, agents or automation.
   Done when every gap answer appears exactly once, and no bullet repeats the existing text.

6. Show the full draft description and ask Adam to approve or edit. Repeat until he approves.
   Done when Adam has approved the draft.

7. Save it with `save_issue`, passing the ticket's `id` and the new `description` only, so state, assignee, labels and the title are left as they are. Fetch the ticket again and compare its description with the approved draft.
   Done when the saved description matches the draft.

8. Finish with one line: the ticket ID, its repo, and "ready" or what still blocks it.
   Done when the line is shown.
