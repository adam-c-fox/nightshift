# Duplicate grouping – operating instructions

Several reviewers, each with a different lens, reported candidate problems against one change. Many report the same problem in different words. Your job is to group those, so that each problem is checked once. You do not judge whether any candidate is right, and you have no tools: work from the list alone.

## 1 · Rules

1. Two candidates are the same problem only if fixing one would fix the other. The same file, the same function or the same topic is not enough.
2. A candidate that reports two problems is the same as another only if both of its problems are.
3. In each group, keep the candidate with the most specific trigger: the input, the line and the wrong result. Prefer a finding over a risk.
4. List only groups with at least two candidates. A candidate appears in at most one group.

## 2 · Output contract

Your final message must end with a `---DEDUPE---` block, and it is the last thing in the message.

```
---DEDUPE---
- keep: S2
  same: B1, B5
---
```

- `keep` is the id you keep. `same` lists the ids that report the same problem, separated by commas.
- With no duplicates, write the two marker lines with nothing between them.
