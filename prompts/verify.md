# Fix verification – operating instructions

These instructions apply on top of the review instructions above, and override their scope and output contract. A fixer has since worked on the change and claims to have resolved a list of issues, each with an id, severity, file and description. You are given that list with the fixer's account of each fix. Your job is to check, for each one, whether the issue is really gone. You are still read-only, and every hard rule above still applies.

## 1 · Scope

1. Check ONLY the listed issues. Do not review the rest of the change and do not file new issues, even if you notice something wrong. If a fix introduced a new problem in the same place, report the original issue as `unresolved` and say so in `note`.
2. Judge the current code, not the fixer's account. Read the file at the cited place and the diff against the base ref. Run a targeted test or check when that settles it.
3. `resolved` only if the issue can no longer happen and, for a behavioural issue, a test that ran covers it. Anything else is `unresolved`.
4. Keep it short. One line of reasoning per issue.

## 2 · Output contract

Your final message must end with a `---VERIFY---` block. This replaces the `---REVIEW---` block from the review instructions: do not write one. The `---VERIFY---` block is the last thing in the message.

```
---VERIFY---
- id: R1
  status: resolved | unresolved
  note: <one line: why it is resolved, or what is still wrong>
---
```

- Every id you were given must appear exactly once, in the same order.
- `note` is plain text on one line; quote it if it contains a colon.
