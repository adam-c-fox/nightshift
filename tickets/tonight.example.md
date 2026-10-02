# Tonight

<!--
  Copy this file to tickets/tonight.md (gitignored) and edit it there.

  One section per ticket, worked in file order. Format:

  ## <LINEAR-ID> – <short name>
  repo: main          ← "main" or "terraform"
  - <context line>
  - <extra line>

  Leave the file empty (just the # heading) to skip the night.
-->

## ENG-142 – export: add CSV download to the runs table
repo: main
- Reuse the existing row formatter in packages/export; don't add a CSV dependency.
- Only the runs table needs it tonight. Leave the other tables alone.

## INF-7 – storage: enable soft delete on the export bucket
repo: terraform
- Retention of 14 days, matching the other buckets in storage.tf.
