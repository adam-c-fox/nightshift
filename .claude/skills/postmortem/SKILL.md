---
name: postmortem
description: Review a nightshift night and suggest fixes to the instructions and workflow. Suggests only, never edits. Optional date argument, default the latest night.
disable-model-invocation: true
---

Review one nightshift night and suggest changes to the instructions that would have prevented what went wrong. You are read-only: never edit, write or delete any file, and never run anything that changes state. Adam reads your suggestions in the morning and chooses which to implement.

## Input

`logs/<project>/session-<date>.json`, written by the runner. Project-specific instructions live in `projects/<project>/AGENTS.md`, so suggestions can target that file. It holds every ticket's outcome (status, summary, notes, tests, checks, review findings, fix resolutions, fix verification, followups, PR and CI results) and, per ticket, `logFiles`: the agent, review (one transcript per lens, `-review-bugs`, `-review-spec` and `-review-reuse`, plus `-review-confirm`; older nights have a single `-review`), fix and verify transcripts, and `<ID>-diff.txt`, the committed change against its base. When invoked by hand as `/postmortem [date]`, use the given date, or the newest `logs/<project>/session-*.json` if none; take the project from `npm run -s project` or ask. When the runner invokes it, the project is the one in the session path it was given (`logs/<project>/...`); never read `.env`. To see code around the change, read files under the ticket's `worktreePath`.

## What to look for

For each ticket that went wrong: status `needs_review`, `partial` or `error`, review findings (each one is a mistake the implementer made), fixes `not_fixed` or still open after verification, check regressions, CI fix attempts, budget aborts, skipped or failed stages.

For each, find the instruction-level root cause: which part of `AGENTS.md`, `projects/<project>/AGENTS.md`, `prompts/review.md`, `prompts/review-bugs.md`, `prompts/review-spec.md`, `prompts/review-reuse.md`, `prompts/confirm.md`, `prompts/fix.md`, `prompts/verify.md`, `.claude/skills/prep/gaps.md` (gap-finding), `.claude/skills/prep/SKILL.md` (ticket descriptions), `.claude/skills/tonight/SKILL.md` (context bullets) or the runner's behaviour was missing, vague or misleading, so that the agent did what it did. Read those files and the relevant log lines before concluding.

## Rules

1. Group issues with the same cause across tickets into one suggestion.
2. Rank by expected impact: what would have prevented the most or the worst problems comes first.
3. Quote evidence from the logs in `problem`, with the ticket id and file.
4. `change` is the concrete text to add or replace and the place it goes. Keep it short, in the repo's terse style.
5. Never suggest loosening a check, skipping tests or relaxing TDD to make things pass.
6. Ignore pure code bugs with no instruction cause, and one-off flukes that no instruction could have prevented.
7. An empty list is a fine result. Do not invent suggestions.
8. Suggest only. Do not edit any file, including the ones you propose changing.

## Output

End your final message with this block. It is the last thing in the message. In manual mode, also print the suggestions as a short readable list above it.

```
---POSTMORTEM---
suggestions:
  - id: P1
    target: AGENTS.md
    tickets: ENG-142, ENG-150
    problem: <one line: what went wrong, with evidence>
    cause: <one line: which instruction was missing, vague or misleading>
    change: <one line: the exact text to add or replace, and where>
---
```

- Ids run P1, P2, … in rank order.
- `target` is one file path; use separate suggestions for separate files.
- Each field is plain text on one line; quote it if it contains a colon.
- With nothing to suggest, write `suggestions: []`.
