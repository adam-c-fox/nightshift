---
name: nightshift-setup
description: Set up the repo you're in as a nightshift project. Writes projects/<name>/ in nightshift, runs a baseline of the night's checks, and reports where the repo doesn't fit.
disable-model-invocation: true
---

# Nightshift setup

Run from the root of a repo that should become a nightshift project. You're done when `projects/<name>/` loads, validation meets step 6, and the user has a report of each **gap** (a way this repo doesn't fit what nightshift can run).

Resolve this skill's directory through any symlink, then set `$NS` to its grandparent, the nightshift checkout. Verify that `$NS/package.json` names `nightshift` and `$NS/templates/project/` exists. If the installed skill is a standalone copy, ask the user for the checkout path. Keep the target repo path separately; all project files go under `$NS`, and all nightshift commands run from `$NS`. The checkout is the source of truth for the project format:

- `$NS/docs/setup.md`, section "Projects", says what each file in a project folder does.
- `$NS/templates/project/` holds the templates.
- `$NS/AGENTS.md` holds the generic agent instructions. A project's `AGENTS.md` is appended after it, so it should only add to it or override it.

## 1. Gather

1. Find each repo. Run `git rev-parse --show-toplevel` here, then read the repo's own `CLAUDE.md`/`AGENTS.md`, its package manifests and lockfiles, and its CI pipeline files (`.github/workflows`, `azure-pipelines.yml` and the like) to learn its layout and how its tests run. The CI files are the source for `setup` and `checks`: lift the exact commands CI runs, prefer check-only variants (e.g. `--check`), and drop deploy and pack steps.
2. Ask the user everything in one `AskUserQuestion`, with your inferred default as the first option:
   - Other repos in the project, as absolute paths. A Terraform repo beside an app repo is common.
   - The project name. It must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`, can't be `new`, and can't already exist in `$NS/projects/`.
   - Each repo's key, matching `^[a-z0-9][a-z0-9_-]*$` (e.g. `app`, `infra`), and its `setup` and `checks` commands (from CI) with any `in` globs.
   - `linearTeams`, as team keys like `ENG`. Leave it out to list every team.
   - `allowancePercent`, default 15.

## 2. Fit check

Nightshift's PR host is hardwired. Check every repo against this:

- **PR host is Azure DevOps.** The `origin` remote must be on `dev.azure.com` or `*.visualstudio.com`. Nightshift opens PRs, reads CI and lists open PRs only through `az`.

A repo on another PR host is a **blocker**. Stop before writing files and tell the user which part of nightshift would need to change. Anything smaller is a gap: note it and carry on.

## 3. Test database

The night exports exactly one service URL, `TEST_DATABASE_URL`, which the project's `testDb` script prints when called with `up`. Find out how the repo's tests get a database: env var names, compose services, test setup files.

- If tests need Postgres, copy `$NS/templates/project/test-db.sh`. Give it a container `NAME` and host port that no other project uses (`grep -h "127.0.0.1:" $NS/projects/*/test-db.sh`). Take the Postgres version, user and database name from the repo's own compose or test config.
- It's a gap if tests read a variable other than `TEST_DATABASE_URL`, or need another service (Redis, a queue, cloud emulators).

## 4. Baseline

Run the exact commands a night runs before each ticket. Write the repo's entry in `project.json` first, then get the expanded check list from nightshift itself:

```sh
cd "$NS" && npx tsx -e "import {repoCheckCommands} from './src/checks.ts'; import {loadProject} from './src/project.ts'; const repo=loadProject('<name>').repos['<repo-key>']; console.log(JSON.stringify(repoCheckCommands(repo, '<worktree>'), null, 1))"
```

Run them in a throwaway worktree so the user's working tree stays untouched:

1. `git fetch`, then `git worktree add --detach <scratchpad>/<repo-key> origin/<default branch>`.
2. Run the repo's `setup` commands (in their `in` directories), then start the test DB if there is one (`test-db.sh up`) and export its URL as `TEST_DATABASE_URL`.
3. Run every command from the list, each in its `cwd`. Record pass or fail, plus the failing tail of the output.
4. Clean up with `test-db.sh down` and `git worktree remove --force`.

The baseline is done when every command has a recorded result. Sort each failure into one of two kinds:

- **Gap**: a check that writes instead of checking (e.g. `format` without `--check`), or a command CI runs that has no local equivalent.
- **Missing here**: an environmental failure, such as a runtime that isn't installed or a service that isn't running. It goes into `AGENTS.md` with the workaround the agent should use.

The baseline runs unsandboxed, but night agents run sandboxed. Their network allowlist is the repo's `network` list, which blocks every other host. Find tests that reach external hosts and either add the host to `network` or list them under **Missing here**.

## 5. Write `$NS/projects/<name>/`

- **`project.json`**: use the example's shape. `/tonight` and `/prep` route each ticket to a repo by its `description`, so fill it with the nouns tickets will use: frameworks, cloud provider, resource types, top-level directories. Set `defaultRepo` when there are two or more repos. Add `testDb` if you wrote the script.
  - Per repo, `setup` and `checks` come from step 1 and the baseline.
  - `network` holds the registries setup and tests reach (npm, PyPI, NuGet, Terraform registry...), plus `localhost` and `127.0.0.1` when tests use local services (with `allowLocalBinding: true`).
  - `tools` holds the command prefixes the agent needs, e.g. `npm`, `dotnet`, `.venv/bin/pytest`.
  - A runtime that isn't installed here is a **Missing here** item, not a reason to drop the check.
- **`.env`**: three keys, then `chmod 600`.
  - `AZURE_DEVOPS_ORG` and `AZURE_DEVOPS_PROJECT` come from `origin`. The remote can be in any of these forms (URL-decode the project name):
    - `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>`
    - `https://dev.azure.com/<org>/<project>/_git/<repo>`
    - `https://<org>.visualstudio.com/<project>/_git/<repo>`
  - Ask the user for an optional `BRANCH_PREFIX`, or leave it empty.
  - The PAT, `LINEAR_API_KEY` and the Claude token belong in the root `$NS/.env`.
- **`AGENTS.md`**: the example's three sections, each holding only facts you verified in steps 1–4:
  - **Repos**: the layout, how to run one test file, and every place the generic `AGENTS.md` is wrong for this repo. The root `AGENTS.md` is stack-neutral, so stack-specific workflow notes go here (e.g. Terraform: validate instead of unit tests, never plan or apply).
  - **Services in this environment**.
  - **Missing here**.
- **`tonight.md`**: the `# Tonight` heading only.
- **`test-db.sh`**, if step 3 produced one. Run `chmod +x` on it.

## 6. Validate

```sh
cd "$NS" && npx tsx -e "import {fileChecks} from './src/dashboard/project-checks.ts'; console.log(JSON.stringify(fileChecks('<name>', {projectsDir: 'projects', exampleDir: 'templates/project'}), null, 1))"
```

Fix and re-run until every check is `pass`. If the user chose an empty `BRANCH_PREFIX`, accept a `.env` warning only when its `keys.missing` contains that key alone, and record it in the report. The checker treats the example's branch-prefix key as required even though the runner permits an empty prefix. Resolve every other missing key or failed check before finishing.

## 7. Report

- The files written.
- The baseline as a table: command, pass or fail, and one line of reason.
- The gaps, blockers first. Give each one its fix and where the fix belongs: in this repo (e.g. "add a `typecheck` script") or in nightshift (e.g. "support pnpm").
- Next steps: `/prep <ID> <name>`, then `/tonight <name>`.
