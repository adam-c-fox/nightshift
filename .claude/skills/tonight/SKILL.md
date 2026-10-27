---
name: tonight
description: Draft a project's tonight.md from your Linear Todo tickets, with you, before the nightshift run. Optional project argument.
disable-model-invocation: true
---

Plan tonight's nightshift run with the user: fetch their Linear Todo tickets, draft `projects/<project>/tonight.md` together, and write it.

The runner works tickets in file order, so order is priority. `projects/<project>/tonight.md` is gitignored. The file format is in the header comment of `projects/example/tonight.md` and in `parseTickets` in `src/tickets.ts`.

Run the nightshift commands below from its checkout root, where `package.json` names `nightshift` and `projects/example/` exists. If invoked elsewhere, resolve this skill's directory through any symlink and use its great-grandparent as the checkout root. If the skill is a standalone copy, ask the user for the checkout path.

Discover the connected Linear tools for listing the current user's issues, fetching an issue, and listing its comments. Tool names and schemas vary by connector; load deferred tools with the host's discovery tool and use their actual schemas. The operation names below describe intent. If no connected tool supports an operation, ask the user to connect Linear and stop before writing tonight's file.

## Steps

1. Pick the project: the first argument (`/tonight [project]`), else the output of `npm run -s project`. If that prints nothing, list `projects/*/project.json` and ask the user which one. Repos, their paths and descriptions live in `projects/<project>/project.json`.
   Done when you have a project name.

2. Read `projects/<project>/tonight.md`; if it doesn't exist, copy `projects/example/tonight.md` to it and delete the example tickets. If `## <ID> – …` headings exist outside the HTML comment, show them and ask the user: replace, append, or stop. An existing `allowance:` header line is part of the header: keep it or replace it according to the answer in step 11.
   Done when the user has chosen, or the file has no tickets.

3. Fetch candidates with the issue-listing tool, assigned to the authenticated user and in state `Todo` only. If there are none, tell the user and stop.
   Done when you hold every Todo ticket assigned to the user.

4. Run `npm run -s prep-status -- --project <project>`; it prints one JSON line per Todo ticket in the project's `linearTeams`, with a `prep` field. Show a numbered list: ID, title, team, priority, estimate, prep. The prep column is one of: fresh, stale, new comments, not ready (with its blockers), inferred, none. Stale means the description changed after `/prep`; new comments means comments arrived after `/prep`. A ticket from step 3 that is missing from the output shows "—": it is outside this project's `linearTeams`. If the command errors, show the prep column as "?" and say why. Ask which to run tonight, as numbers or IDs, in priority order, and tell them the runner works tickets in file order, so order is priority.
   When a picked ticket depends on another picked ticket's unmerged code, order it after its parent and add `base: <ID>` under `repo:`. Both must be in the same repo.
   Done when the user has named an ordered set.

5. For each picked ticket, fetch the full issue and list its comments with the connected Linear tools.
   Done when every picked ticket has both.

6. Check each picked ticket against every item in `.claude/skills/prep/gaps.md`. Tickets prepped with `/prep` carry their decisions in the description under `## Decisions`; count those as answered.
   Say in the gap list header which picked tickets are fresh-prepped ("prepped, decisions recorded"), but still check every item in `gaps.md` for every ticket. For each stale, not ready or none ticket, add a one-line note suggesting `/prep <ID>` first.
   First list all tickets' gaps as short numbered titles, grouped by ticket, so the user sees how many there are. Then ask about them one at a time with `AskUserQuestion` (load it with ToolSearch if it's deferred), one question per call, in the listed order, with the ticket ID as the header. Each question states the gap and what the ticket and comments show. Put your recommended answer first, labelled "(Recommended)", then at most one real alternative, then "Your call" and "Drop ticket" (the tool allows four options). The user can type their own answer through "Other". Wait for each answer before you ask the next, and let it change later questions: drop a gap it settles, and reword one it affects.
   Write "your call" as a bullet like "Your call on X; state the choice in notes". "Drop ticket" removes it from tonight's set for the remaining steps and skips its other gaps.
   Done when every gap has an answer or its ticket is dropped.

7. Infer each ticket's repo: pick the repo whose `description` in `project.json` best matches the ticket's team, labels, title and description; fall back to `defaultRepo`. Repos, their paths and descriptions live in `projects/<project>/project.json`.
   Done when every ticket has a repo.

8. Draft up to 5 one-line context bullets per ticket, plus one per resolved gap, covering:
   - each gap answer from step 6, as one bullet;
   - acceptance criteria worth stressing;
   - decisions and constraints from comments;
   - likely files, found with `grep -rln --exclude-dir={node_modules,.terraform,.git} <identifier> <repo path>` on identifiers named in the ticket, written as `see <path>`;
   - areas the agent should leave alone.

   The agent already receives the description, so bullets add what the description lacks. Don't repeat a gap answer in another bullet.
   Done when each ticket has bullets, each adding something the description lacks.

9. Look up open PRs for all picked tickets in one read-only call: `npm run -s open-prs -- --project <project> <repo>:<ID> …`. It prints one JSON line per ticket. It fetches each ticket's Linear title (so it needs `LINEAR_API_KEY`) to build the branch name `<BRANCH_PREFIX>/<id>-<slug>` (see `ticketBranchName` in `src/worktree.ts`). The runner continues an open PR whose source branch is that name exactly or that name plus `-<digits>` (see `pickTicketPr` in `src/pr.ts`).
   A non-null `pr` means the ticket is requeued: mark it "requeued, continues PR #N", ask the user what feedback the agent should address, and write their answer as bullets saying what to change on top of the existing PR.
   If the line has `"autoComplete": true`, warn the user: the runner will not push to that PR (it would merge unreviewed), so tonight's work stays on a local branch and the ticket ends as needs_review. Suggest they cancel auto-complete first.
   An `error` line or a non-zero exit means: say so and treat that ticket as new.
   Done when each ticket is marked new or requeued, and every requeued ticket has the user's feedback as bullets.

10. Show the complete draft: the header comment as it stands in the file, then one `## <ID> – <title>` / `repo: <repo>` / `- bullet` section per ticket, with each inferred repo highlighted. Ask the user to confirm or edit, and repeat until they approve.
   Done when the user has approved the draft.

11. Run `npm run -s usage -- --project <project>`; it prints one JSON line with `weeklyPercent` and `resetInfo`. Show the user the weekly usage and reset. Read the project default from `allowancePercent` in `projects/<project>/project.json` (15 if unset).
    Ask with `AskUserQuestion`, one question, header "Allowance": options "Project default (N%) (Recommended)" and "Use the rest of the week (100%)". The user can type a number through "Other". If the weekly reset is within about 24 hours, put "Use the rest of the week (100%)" first and mark it "(Recommended)" instead.
    If the line is an `error` or the command exits non-zero, say usage couldn't be read and ask with the project default recommended.
    Done when the user has chosen an allowance. Write `allowance: <n>` in the header only when it differs from the project default; drop any existing line otherwise.

12. Write `projects/<project>/tonight.md`, with the `allowance: <n>` line in the header above the first ticket when step 11 calls for one. Validate with:
   `npx tsx -e 'Promise.all([import("./src/tickets.ts"), import("./src/project.ts")]).then(([t, p]) => { const pr = p.loadProject(process.argv[1]); console.log(JSON.stringify(t.loadTickets(pr.ticketsFile, { names: Object.keys(pr.repos), defaultRepo: pr.defaultRepo }), null, 1)) })' <project>`
   Compare the parsed IDs, repos and order with the draft; fix and re-run until they match.
   Done when the parsed output matches the approved draft.

13. Finish with one line per ticket (ID, repo, "continues PR #N" or "new") and the reminder that `npm run run:dry -- --project <project>` previews the night.
    Leave the night run and Linear tickets as they are.
    Done when the summary is shown.
