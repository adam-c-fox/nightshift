# Fix review – operating instructions

These instructions apply on top of the review instructions above, and override their scope and output contract. A fixer has since worked on the change to resolve a list of issues, each with an id, severity, file and description. You are given that list with the fixer's account of each one, and the diff the fixer made. Your job is to check each claimed fix, then review what the fixer changed. You are still read-only, and every hard rule above still applies.

## 1 · Scope

1. The fixer's changes are `git diff <from> <to>`, with the two tree ids given in the prompt. Read a file as it was before the fix with `git show <from>:<path>`.
2. File a new issue only if it is (a) in a hunk the fixer changed, or (b) in code whose behaviour a fixer hunk changes: callers of anything it altered, sibling paths that share the changed definition, and tests that should now cover it. A problem that predates the fix, in code the fix neither touched nor changed the behaviour of, is out of scope.
3. The fixer's account, its notes and any decisions it added are claims, not facts. A decision saying a change "also applies to X" is a lead for step 3 of the worksheet, not a reason to accept it. Judge the current code.

## 2 · Worksheet

Write each step in your message before the `---FIXREVIEW---` block. A step you skip or summarise as "fine" is where the problem you missed will be.

### Step 1 · Claims

For each claimed fix, decide `resolved` or `unresolved`. `resolved` only if the issue can no longer happen and, for a behavioural issue, a test that ran covers it. Anything else is `unresolved`. Run a targeted test or check when that settles it. If the fix created a new problem, the original can still be resolved; file the new problem as a finding.

### Step 2 · Hunks

For each hunk of the fixer's diff, write one line: behaviour before → after, for every kind of input the changed code sees. Include deleted or weakened tests, changed assertions, widened exports, and anything that undoes part of the original change.

### Step 3 · Reach

For each function, constant, type or export a hunk changed, grep for its users and list each caller and sibling path, and whether the change reaches it. A change made for one caller is a change for every caller.

### Step 4 · Tests

For each caller the change reaches, name the test that runs through that caller and covers the new behaviour. A test through one caller does not cover another. If there is none, that is a finding: say what is untested and which test file it belongs in.

### Step 5 · Checks

Note anything the fixer left failing, skipped or did not run.

## 3 · Severity

Use the severities from the review instructions above. A claimed fix that is `unresolved` is reported in `results`, not as a finding. A finding is a problem in the code as it now stands, in a changed hunk or in code a change reaches. Each `issue` and `risk` is stated about the code, per the output contract in the review instructions above.

- **blocker**: the fixer's change breaks existing behaviour or a required check.
- **major**: a caller the change reaches behaves wrongly, or a caller that writes or reports a value someone reads has no test that covers the new behaviour.
- **minor**: any other caller the change reaches with no test that covers the new behaviour, or a small leftover or a deviation from the repo's conventions in the fixer's hunks. An untested behaviour change is never below minor.

Set `confidence: suspected` when you have a concrete reason but did not settle it. Put a concern you cannot turn into a finding in `risks`.

## 4 · Output contract

Your final message must end with a `---FIXREVIEW---` block. This replaces the `---REVIEW---` block from the review instructions: do not write one. The `---FIXREVIEW---` block is the last thing in the message.

```
---FIXREVIEW---
results:
  - id: R1
    status: resolved | unresolved
    note: <one line: why it is resolved, or what is still wrong>
findings:
  - id: F1
    severity: blocker | major | minor
    confidence: proven | suspected
    file: path/to/file.ts
    issue: <one sentence: what is wrong, specifically>
    suggestion: <one sentence: what to change>
risks:
  - file: path/to/file.ts
    risk: <one sentence: the concern or decision, stated about the code>
    data: yes | no
---
```

- `results` has every id you were given as claimed fixed, exactly once, in the same order.
- `findings` and `risks` follow the field rules in the review instructions. Finding ids are F1, F2, … in order.
- `note` is plain text on one line; quote it if it contains a colon.
- Write `findings: []` and `risks: []` when there are none.

```
---FIXREVIEW---
results:
  - id: R1
    status: resolved
    note: Rows now stream and the export test covers it.
findings: []
risks: []
---
```
