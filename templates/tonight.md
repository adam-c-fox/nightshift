# Tonight

<!--
  Copy this file to tonight.md in the nightshift root and edit it there. Project and repo names come from each project's project.json.

  Optional header line, above the first ticket:
  allowance: <1-100>  ← share of the weekly usage for this night only; overrides NIGHTLY_ALLOWANCE_PERCENT,
                         `--allowance` still wins; removed from this file after the night

  One section per ticket, worked in file order across all projects. Format:

  ## <LINEAR-ID> – <short name>
  project: eoe        ← a project name from projects/
  repo: app           ← optional: a repo name from that project's project.json; defaults to its defaultRepo
  base: <LINEAR-ID>   ← optional: stack on an earlier ticket in this file (same project and repo)
  - <context line>
  - <extra line>

  A stacked ticket branches from its base's branch and opens its PR into it.
  If the base isn't pushed tonight, the stacked ticket is skipped.

  Leave the file empty (just the # heading) to skip the night.
-->

## ENG-142 – export: add CSV download to the runs table
project: eoe
repo: app
- Reuse the existing row formatter in packages/export; don't add a CSV dependency.
- Only the runs table needs it tonight. Leave the other tables alone.

## MEM-7 – summary: cap the memo length
project: memosum
- Keep the cap in the existing config; don't add a new setting.

## ENG-143 – export: add a CSV download button to the runs page
project: eoe
repo: app
base: ENG-142
- Call the CSV endpoint from ENG-142; don't re-implement the formatter.
