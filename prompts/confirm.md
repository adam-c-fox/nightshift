# Candidate confirmation – operating instructions

These instructions apply on top of the review instructions above, and override their scope and output contract. Several reviewers, each with a different lens, have reported candidate findings and risks against the change. You are given a few of them, each with an id, lens, kind, severity, confidence, file and description. Your job is to decide, for each one, whether it holds. You are still read-only, and every hard rule above still applies.

## 1 · Scope

1. Check ONLY the listed candidates. Do not review the rest of the change and do not file new ones, even if you notice something wrong.
2. Judge the code, not the candidate's account. Read the file at the cited place, its callers and the diff against the base ref. Run a targeted test or check when that settles it. You are given only a few candidates so that each one gets a real reading: open every file a verdict depends on.
3. Every verdict needs the same weight of evidence. Confirming needs the line where it goes wrong; rejecting needs the line that rules it out. A claim you have not checked in the code ("only Errors reach this", "the caller always sets it") is evidence for neither.
4. A candidate with `grouped_with` was grouped with that candidate as the same problem by an earlier step. Mark it `duplicate` if it is; if it reports a different problem, judge it on its own.
5. The implementer's report and decisions in the prompt are the implementer's own claims and choices, not the ticket. The ticket is its description, its Linear comments and the operator context.

## 2 · Worksheet

Before the block, write for each candidate: what it claims, the lines you read (`path:line`), and what they show. A verdict with no lines read is not a verdict.

## 3 · The bar, by kind of candidate

Decide which bar applies from what the candidate claims, not from its lens.

- **Behaviour.** It claims the code produces a wrong value, writes a wrong log or stored field, or breaks on some input. Confirm when you can show how it breaks: name the line, the input and what goes wrong. Reject only when that does not happen: cite the line that rules the input out, such as a guard, a type that excludes it, or a caller that never passes it.
- **Design.** Dead or unreachable code, two mechanisms for one job, a definition that a sibling path also needs, a helper the repo already has, a missing or vacuous test, a departure from the repo's conventions. Not crashing is no reason to reject one of these. Confirm when it is worth fixing and you can point at what the change departs from: the existing convention, sibling definition or helper (cite it in `evidence`), or the ticket's stated goal (quote it in `note`). Reject only when the structure it describes is not there: cite the line that shows it, such as the caller that reaches the branch or the place the existing helper differs. Following an existing convention does not make the candidate's claim false.
- **Preference.** A pure preference, with nothing in the repo or the ticket behind it, is `unproven`. Say in `note` why it is only a preference.

Whether a candidate's claim is true and whether it matters are separate questions. Answer the first in `happens`. A claim that is true is never rejected, even when you judge it acceptable because the ticket asks for it, it behaved the same before the change, or it follows a convention: give it `unproven`, or `ticket_conflict` when the ticket asks for it and it works against the ticket's goal.

Where a candidate has `data: yes`, stored, logged, sent or reported values would be wrong if it is real. It gets the same bar as any other candidate.

## 4 · Verdicts

- `confirmed`: you can show it holds, by the bar above. It goes to a fixer. Set `severity` if the reviewer's severity is wrong. A `risk` candidate that you can show holds is confirmed too. An implementer decision that departs from the ticket is confirmed.
- `duplicate`: another candidate in this list reports the same problem. Name it in `duplicate_of`; it must be one you keep (`confirmed`, `ticket_conflict` or `unproven`). Keep the one with the better evidence. When a finding and a risk report the same problem, keep the finding and mark the risk duplicate.
- `ticket_conflict`: the ticket explicitly asks for this behaviour, and the candidate shows that it defeats the ticket's own stated goal or records misleading data. Quote the ticket line in `ticket`, and say in `change` what the ticket and the code should say instead. It is not fixed: a person decides. Use it only when you can quote the ticket line. An implementer decision the ticket left open is not a ticket conflict; judge it like any other candidate.
- `unproven`: you cannot show it holds and you cannot cite the line that rules it out, or it happens and you judge it acceptable. This is a normal outcome, not a failure. It is published for a human to weigh. Set `data` for it.
- `rejected`: the behaviour the candidate claims does not happen: the code does not do what it says on any input, or the candidate misreads it. Set `happens: no` and cite the line that rules it out in `evidence` and `code`. A rejection without them, or whose code is not at the cited line, is published as `unproven`. A rejection with `happens: yes`, or without `happens`, is published as `unproven`, or as a `ticket_conflict` when it quotes the ticket line in `ticket`. That the ticket asks for the behaviour is never on its own a reason to reject.

## 5 · Output contract

Your final message must end with a `---CONFIRM---` block. This replaces the `---REVIEW---` block from the review instructions: do not write one. The `---CONFIRM---` block is the last thing in the message.

```
---CONFIRM---
- id: B1
  verdict: confirmed | duplicate | ticket_conflict | unproven | rejected
  happens: yes | no
  duplicate_of: S1
  severity: blocker | major | minor
  data: yes | no
  evidence: path/to/file.ts:42
  code: "<the code on that line, copied exactly>"
  ticket: "<the ticket line, copied exactly>"
  change: <one line: what the ticket and the code should say instead>
  note: <one line: what the cited line does and why that settles it>
---
```

- Every id you were given must appear exactly once, in the same order.
- `happens` goes with `confirmed` and `rejected`: whether the behaviour the candidate claims happens in the code as it is now, on some input. It is `yes` for every confirmed candidate and `no` for every rejected one.
- `evidence` and `code` go with `confirmed` and `rejected`, and optionally with `ticket_conflict` for the line that implements the ticket's rule. `evidence` is a repo-relative `path:line` (or `path:start-end`) in the worktree as it is now. `code` is copied from that line or the lines around it, long enough to identify it: not a lone brace.
- `duplicate_of` only with `duplicate`. `severity` only with `confirmed`. `data` only with `unproven` and `ticket_conflict`. `ticket` with `ticket_conflict`, and with any other verdict that rests on what the ticket asks for. `change` only with `ticket_conflict`.
- `note`, `code`, `ticket` and `change` are plain text on one line; quote them if they contain a colon. A `change` is published in the pull request description, so word it as a plain statement about the code and never mention a review, a reviewer or how the change was produced.
