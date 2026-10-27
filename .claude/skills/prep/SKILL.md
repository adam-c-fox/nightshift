---
name: prep
description: Audit one Linear ticket with you and write the missing context into its description, so the nightshift agent can work it unattended. Takes a ticket ID and an optional project.
disable-model-invocation: true
---

Prep one Linear ticket with the user so a nightshift agent can finish it without guessing. Find its gaps, get the user's decisions, and write them into the ticket's description. `/tonight` later re-checks the night's set as a final pass.

The agent sees the ticket's description and comments, plus the title and bullets in `projects/<project>/tonight.md`. Comments reach it as a raw thread, oldest first, with no sign of which points were settled, so every decision goes into the description.

Run the nightshift commands below from its checkout root, where `package.json` names `nightshift` and `projects/example/` exists. If invoked elsewhere, resolve this skill's directory through any symlink and use its great-grandparent as the checkout root. If the skill is a standalone copy, ask the user for the checkout path.

Discover the connected Linear tools for fetching an issue, listing its comments, and updating its description, assignee and state. Tool names and schemas vary by connector; load deferred tools with the host's discovery tool and use their actual schemas. The operation names below describe intent. If no connected tool supports an operation, ask the user to connect Linear and stop before changing the ticket.

## Steps

1. Take the ticket ID and optional project from the arguments (`/prep <ID> [project]`), or ask the user for the ID. The project defaults to the output of `npm run -s project`; if that prints nothing, list `projects/*/project.json` and ask. Fetch the issue and list its comments with the connected Linear tools.
   Done when you hold the ticket and all its comments.

2. Pick the repo with the rule in step 7 of `.claude/skills/tonight/SKILL.md`. Repos, their paths and descriptions live in `projects/<project>/project.json`.
   Ground the ticket in that repo's code: `grep -rn --exclude-dir={node_modules,.terraform,.git,dist}` for every file, function, type, table, route and config key the ticket names, and read the matching code (± 40 lines). Note the test files that cover it and any existing helper the change should reuse.
   Done when every identifier the ticket names is located or confirmed missing, and you know where the tests for it go.

3. Check the ticket against every item in `gaps.md` in this skill's folder, using what you found in the code.
   Done when every item has been checked.

4. First list the gaps as short numbered titles so the user sees how many there are. Then ask about them one at a time with `AskUserQuestion` (load it with ToolSearch if it's deferred), one question per call, in the listed order. Each question states the gap and what the code shows. Put your recommended answer first, labelled "(Recommended)", then at most one real alternative, then "Your call" and "Not ready" (the tool allows four options). The user can type their own answer through "Other". Wait for each answer before you ask the next, and let it change later questions: drop a gap it settles, and reword one it affects.
   "Not ready" ends the prep: list what the ticket still needs, then run `npm run -s prep-mark -- <ID> --project <project> --not-ready "<blockers in one line>"`, leave the Linear ticket unchanged, and stop. If it prints `error`, tell the user and stop anyway.
   Done when every gap has an answer.

5. Draft the new description. Keep the existing text as it is. After it, add only the sections that have content:
   - `## Acceptance criteria`: testable checkboxes, when the ticket has none or they are vague;
   - `## Decisions`: one bullet per gap answer and per decision found only in comments. Write "your call" as "Your call on X; state the choice in notes";
   - `## Pointers`: likely files as `see <path>`, helpers to reuse, areas to leave alone.

   If the description already has a section with one of these names, update it in place. Write it for a developer reading the ticket: plain, specific, with no mention of nightshift, agents or automation.
   Done when every gap answer appears exactly once, and no bullet repeats the existing text.

6. Show the full draft description and ask the user to approve or edit. Repeat until they approve.
   Done when the user has approved the draft.

7. Use the connected Linear update tool to save the approved description, assign the ticket to the authenticated user, and move it to `Todo`. Leave labels and the title as they are. Fetch the ticket again and compare its description with the approved draft.
   Then run `npm run -s prep-mark -- <ID> --project <project> --repo <repo>`. It re-fetches the ticket and records a hash of the saved description. If it prints `error`, show it to the user; the prep itself still stands.
   Done when the saved description matches the draft, the ticket is assigned to the user and in Todo, and prep-mark printed the record.

8. Finish with one line: the ticket ID, its repo, and "ready" or what still blocks it.
   Done when the line is shown.
