# Ticket gaps

A gap is something the night agent would have to guess at. It works unattended from the ticket's description and comments plus the `tickets/tonight.md` title and bullets, and stops as `needs_review` when the intended behaviour is ambiguous or the ticket turns out to be a feature request rather than the stated change (`AGENTS.md` §5).

Check each ticket for:

- acceptance criteria that are missing, vague or untestable;
- edge cases with no stated behaviour (empty or invalid input, errors, permissions, concurrency);
- for anything that runs repeatedly (a poller, a queue consumer, a retry): the end state of each input it skips, rejects or fails on;
- contradictions between the description and the comments, and decisions settled only in comments;
- contracts shared with another ticket that neither defines;
- files, functions or config the ticket names that don't exist in the repo, or that it names ambiguously (more than one match);
- scope larger than one reviewable PR, or a behaviour change bigger than the title implies;
- steps the agent can't do: secrets, manual infra, tools missing in the worktree (e.g. LibreOffice), Terraform `plan` or `apply`, anything needing a human.

One line per gap. No padding; "no gaps" is a fine answer.
