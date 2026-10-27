# Review replay and scoring

## Replaying a review

`replay-review` re-runs the finders and the confirm step against a change from an earlier night, without the implementer run, the fixer or any PR. It spends real usage, so it isn't part of `npm test`:

```sh
npm run -s replay-review -- --project <name> --ticket <ID> --base <sha> \
  --diff logs/<name>/<ID>-diff-review.txt --report logs/<name>/<ID>-output.txt \
  [--session logs/<name>/session-<date>.json] [--related ID=<sha> ...] [--codex-model <slug>] [--no-install]
```

It adds a detached worktree under the system temp directory at `<sha>` and applies the diff there without committing, so new files stay untracked as they were at night. For a node repo it then runs `npm ci` and the repo's build script, so the finders can run tests; `--no-install` skips both. With `--session`, the ticket brief (the night's context lines and Linear snapshot) and the night's check results come from that session file and Linear isn't called; without it, the ticket is fetched from Linear and no check results are passed in. It parses the implementer's report and prints the confirmed findings, the risks (with a `[data]` marker), the ticket conflicts with the quoted ticket line, the overturned rejections, the rulings on the implementer's decisions, each lens's outcome (the bugs finder runs twice, so it appears as `bugs` and `bugs (pass 2)`), and the usage of every run with a total. Raw outputs go to `logs/<name>/replay-<date>/` (`replay-<date>-2` and so on for later runs that day), with the second bugs pass in its own `review-bugs-2` log, the dedupe run, when there was one, in `review-dedupe` and each confirm batch in its own `review-confirm-<n>` log, next to `replay.json`: the review record (candidates with their verdicts, lens runs, rulings), the usage of each run, the arguments and the nightshift commit that ran it. The temporary worktree is removed afterwards; your branches and other worktrees are never touched. `--related` takes related tickets for the reuse lens; give the related ticket's commit from that night, since its branch may have moved. `--codex-model` runs the Codex finder with another model slug than `gpt-6.1-sol`.

Replay the diff the finders saw. The runner saves it as `<ID>-diff-review.txt` before the review; `<ID>-diff.txt` is the final diff, after any fix. For a night older than that file whose fix run changed code, rebuild the pre-fix tree from the fix run's transcript (the `entrypoint: "sdk-cli"` session in the ticket's directory under `~/.claude/projects`): each Edit result carries the file's `originalFile`, so putting each edited file's first original back onto the post-fix commit gives the change the finders reviewed.

To judge a replay against a synthetic export example:

1. Use the base commit recorded for that change. For a stacked ticket, use its parent's commit from the same night rather than the current default branch. Check that the saved diff applies before running agents.
2. Write down the known issues in that diff, such as an export that reads only its first row or reports success without writing a file, and check whether the review surfaces them.
3. Check that choices left open by the ticket appear as risks or decisions, rather than being silently treated as requirements.
4. To exercise decision parsing, replay a report with choices in its notes and another with the same choices in a structured `decisions:` list.
5. Compare each lens's candidates with the confirmation verdicts and compare the usage cost with the original run.


### Scoring against a golden set

A golden set lists the issues a review of one ticket should find, so runs can be compared. It holds client code details, so it lives in the gitignored `projects/<name>/golden/<ID>.json`:

```json
{
  "version": 1,
  "ticket": "ENG-1",
  "items": [
    {
      "id": "1-1",
      "file": "src/export.ts",
      "issue": "reads the first row only",
      "expect": "finding",
      "origin": "change",
      "match": { "files": ["src/export.ts"], "all": [["first row", "rows[0]"], ["only", "ignores"]] }
    }
  ],
  "noise": []
}
```

A candidate matches an item when its file is in `match.files` and every group in `match.all` has a term in its issue or suggestion, ignoring case; the confirm step's note is never searched. `expect` is `finding` when only a confirmed verdict counts. It is `decision` for behaviour the ticket itself asked for: a confirmed verdict counts, and so does a ticket conflict escalated for a person to decide. It is `surfaced` when a ticket conflict or an unproven verdict, published as a risk, is enough. `origin: "fix"` marks an issue the fixer introduced, which the finders never saw: it is reported but not counted. `guard: true` marks a finding the night confirmed and fixed, counted on its own line so a change that loses it shows up. `noise` lists candidates that were rightly rejected, in the same shape, so confirming everything can't pass for recall.

When `projects/<name>/golden/<ID>.json` exists, `replay-review` scores the run and writes `score.json` beside `replay.json`. `score-review` scores records offline at no cost: a night's session file (every ticket with a golden set) or replay records, in any mix:

```sh
npm run -s score-review -- --golden projects/<name>/golden logs/<name>/session-<date>.json logs/<name>/replay-*/replay.json
```

For each item it prints the candidates that match, with the lens and pass that found them or the decision they came from, and what the confirm step did: `confirmed`, `ticket_conflict`, `unproven`, `rejected`, `duplicate` (merged into a candidate that isn't this issue), `missing` (no verdict) or `unconfirmed` (the confirm step didn't run). Near misses are listed as `possible`, for you to check. Then the counts: found, confirmed, surfaced (confirmed, ticket conflict or unproven), met (what `expect` asks for) and lost at confirm, plus the guards confirmed, the noise confirmed, confirmed findings that match no entry, and the cost of each stage. `--json <file>` also writes the scores as JSON. Scoring the night's own session gives the line to beat.

## Replaying a fix review

`replay-fix-review` re-runs the fix review and its confirm step for one ticket from an earlier night, without the implementer, the fixer or any PR. It spends real usage too:

```sh
npm run -s replay-fix-review -- --project <name> --ticket <ID> --base <sha> --pre-diff <file> --diff <file> \
  --report logs/<name>/<ID>-output.txt --fix logs/<name>/<ID>-fix.txt --session logs/<name>/session-<date>.json
```

It adds a detached worktree under the system temp directory at `<sha>`, applies the pre-fix diff and snapshots the tree, then swaps to the final diff and snapshots that. The fix review sees the change between the two snapshots, the findings the fixer was given (from the session JSON), the fixer's own claims from the fix log, and any decisions the fixer added to the implementer's. It then runs the dedupe and confirm steps on what the fix review found, in batches like the review's, and prints the claim results, the fixer candidates with their verdicts, the confirmed findings with their new ids, the ticket conflicts, the risks, the confirm outcome when it wasn't fully confirmed, and the usage of every run with a total. Raw outputs go to `logs/<name>/replay-fix-<date>/`, with the dedupe run in `fix-review-dedupe` and each confirm batch in its own `fix-review-confirm-<n>` log. Nothing else is touched, and the temporary worktree is removed afterwards. There is no `node_modules` in the replay, so tests can't run.

`--diff` is the night's final `<ID>-diff.txt`, with `<ID>-fix-diff-2.txt` reversed first when a second round ran, so the fix review sees only round 1's change. The findings it is given are those the `--fix` log's FIXES block lists, round 1's inputs, so new fixer findings get ids after them.

To get the pre-fix diff for a night recorded since the fix review landed, apply the final `<ID>-diff.txt` to a checkout of the base, reverse `<ID>-fix-diff-2.txt` if there is one, then reverse `<ID>-fix-diff.txt`, and take the diff against the base. For earlier nights, rebuild it by undoing the fix run's edits from its transcript.

For a synthetic fix-review example, change a shared export-name helper and omit coverage for one of its callers. A useful review should identify the missing caller coverage and verify the fixes it was given. Use commit IDs from your own saved run; this repo does not include another project's source or replay logs.
