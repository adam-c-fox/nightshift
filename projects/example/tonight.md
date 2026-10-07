# Tonight

<!--
  Copy this file to projects/<project>/tonight.md and edit it there. Repo names come from that project's project.json.

  Optional header line, above the first ticket:
  allowance: <1-100>  ← share of the weekly usage for this night only; overrides the project default,
                         `--allowance` still wins; removed from this file after the night

  One section per ticket, worked in file order. Format:

  ## <LINEAR-ID> – <short name>
  repo: app           ← a repo name from project.json
  base: <LINEAR-ID>   ← optional: stack on an earlier ticket in this file (same repo)
  - <context line>
  - <extra line>

  A stacked ticket branches from its base's branch and opens its PR into it.
  If the base isn't pushed tonight, the stacked ticket is skipped.

  Leave the file empty (just the # heading) to skip the night.
-->

## ENG-142 – export: add CSV download to the runs table
repo: app
- Reuse the existing row formatter in packages/export; don't add a CSV dependency.
- Only the runs table needs it tonight. Leave the other tables alone.

## INF-7 – storage: enable soft delete on the uploads bucket
repo: infra
- Retention of 14 days, matching the other buckets in storage.tf.

## ENG-143 – export: add a CSV download button to the runs page
repo: app
base: ENG-142
- Call the CSV endpoint from ENG-142; don't re-implement the formatter.
