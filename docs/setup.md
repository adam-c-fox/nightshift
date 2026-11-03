# Setup and daily use

You need Node 22.12+ or Node 24 LTS, Git, the [Claude Code](https://claude.com/claude-code) CLI, the Azure CLI (`az`) with the DevOps extension, and the [Codex CLI](https://developers.openai.com/codex/cli). Docker is needed only when the target project's tests use the example Postgres service.

```sh
git clone https://github.com/adam-c-fox/nightshift.git
cd nightshift
npm ci
cp .env.example .env
mkdir -p logs
```

Fill in the root `.env`:

| Variable | What it's for |
| --- | --- |
| `LINEAR_API_KEY` | Fetching tickets and moving them to In Progress and In Review |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`. Cron can't read the login keychain. |
| `NIGHTSHIFT_PROJECT` | Project used when `--project` isn't passed |

Fill in the project's `.env` (see [Projects](#projects)). An empty value there falls through to the root `.env`:

| Variable | What it's for |
| --- | --- |
| `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT`, `AZURE_DEVOPS_PAT` | Opening PRs and reading CI results |
| `AZURE_DEVOPS_USER` | Optional. Your Azure DevOps email, for finding your PRs, when `az account show` doesn't give it |
| `BRANCH_PREFIX` | Optional prefix for ticket branches |

The `az` login, or the PAT with Code (Read & write) scope, must be able to read and write PR threads, because the PR comment sweep replies to and resolves them.

Run `codex login` once with your ChatGPT plan. The runner uses the Codex CLI login stored under `~/.codex/`, so cron needs no separate Codex token.

Install the bundled skills for Claude Code. Run this from the nightshift checkout; the links let `/nightshift-setup` find it when invoked from another repo:

```sh
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/nightshift-setup" ~/.claude/skills/nightshift-setup
ln -s "$PWD/.claude/skills/prep" ~/.claude/skills/prep
ln -s "$PWD/.claude/skills/tonight" ~/.claude/skills/tonight
ln -s "$PWD/.claude/skills/postmortem" ~/.claude/skills/postmortem
```

If one of those names is already installed, inspect the existing directory or link before replacing it. `/prep` and `/tonight` also need a connected Linear tool that can read and update issues; the unattended runner uses `LINEAR_API_KEY` directly.

Configure a project below and [preview a night](#each-evening) before scheduling it. Cron has a minimal `PATH`: set it in your crontab to include the directories containing `node`, `npm`, `claude`, `az` and `codex`, as well as system tools. Find those paths with `command -v node npm claude az codex`. Replace `/path/to/nightshift` and `<name>` with your checkout and project:

```cron
0 23 * * * cd /path/to/nightshift && npm run run -- --project <name> >> logs/cron.log 2>&1
```

## Projects

A project is the set of repos nightshift works in, plus the instructions and tickets for them. Each lives in `projects/<name>/`, which is gitignored. Templates for each file are in [`templates/project/`](../templates/project):

| File | What it's for |
| --- | --- |
| `project.json` | Repos (`path`, `description`, `setup`, `checks`, `network`, `allowLocalBinding`, `tools`), `defaultRepo`, optional `testDb` script, `allowancePercent` and `linearTeams` |
| `AGENTS.md` | Project instructions appended to the root [`AGENTS.md`](../AGENTS.md): repo layout, services available, tools missing |
| `.env` | Azure DevOps settings and `BRANCH_PREFIX` for this project |
| `tonight.md` | Tonight's tickets |
| `test-db.sh` | Optional script that starts the throwaway Postgres |

Each repo lists its own commands. Nothing is built in:

```json
"repos": {
  "app": {
    "path": "/abs/path/to/app",
    "description": "web app, React, API routes",
    "setup": [{ "command": "npm ci --prefer-offline --no-audit" }],
    "checks": [
      { "name": "build", "command": "npm run build" },
      { "name": "tests", "command": "npm test", "in": "services/*/package.json" }
    ],
    "network": ["registry.npmjs.org", "localhost", "127.0.0.1"],
    "allowLocalBinding": true,
    "tools": ["npm", "npx", "node"]
  },
  "infra": {
    "path": "/abs/path/to/infra",
    "description": "Terraform, AWS",
    "checks": [
      { "name": "terraform validate", "command": "terraform init -backend=false -input=false && terraform validate", "in": "environments/*/main.tf" },
      { "name": "terraform fmt", "command": "terraform fmt -check -recursive" }
    ],
    "network": ["registry.terraform.io"],
    "tools": ["terraform"]
  }
}
```

- `setup` (optional): commands run in each fresh worktree before the baseline. A failure stops the ticket.
- `checks` (at least one, unique names): run before and after the change and compared.
- `in` (optional, on `setup` and `checks`): a file glob or list of globs relative to the worktree. The directory of each matched file is a run location, and the command runs once in each. A glob that matches nothing is an error.
- `network` (optional): hosts the sandbox lets agents and tests reach, such as package registries and local services.
- `allowLocalBinding` (optional): lets sandboxed tests listen on localhost.
- `tools` (optional): command prefixes the implementing agent may run, such as `npm` or `.venv/bin/pytest`. The review agent can only run the check commands.

`toolchain` was removed. A repo that still has it fails validation.

`linearTeams` is a list of Linear team keys such as `["ENG"]`. When it's set, `prep-status` and the [dashboard](dashboard.md) only list your Todo tickets from those teams. `/tonight` still lists every Todo ticket assigned to you, and tickets outside `linearTeams` show "—" in its prep column. Leave it out to see all of them. `/prep` and `/tonight` also use `prep-mark` and `prep-status` to keep track of which tickets have been prepped, described under [Prep memory](dashboard.md#prep-memory).

Start a new project by running `/nightshift-setup` from the root of its repo, after installing the skill above. It writes `projects/<name>/`, reads the repo's CI config for `setup` and `checks`, runs them against the repo and reports where the repo doesn't fit. To do it by hand instead, copy [`templates/project`](../templates/project) to `projects/<name>`, create its `.env` from `.env.example`, and replace the placeholder paths in `project.json`; it won't load until they exist. Select a project with `--project <name>` or `NIGHTSHIFT_PROJECT`. For example, `npm run run -- --project <name>` runs it, and `--allowance <pct>` overrides its budget for one run.

## Each evening

Prep tickets one at a time with `/prep <ID> [project]` in Claude Code. It checks the ticket against the code, asks you about anything the agent would have to guess, and writes your answers into the Linear description. The agent also gets the comments, but as a raw thread, so settled decisions belong in the description.

A ticket that needs the unmerged code of another ticket in tonight's file can name it with `base: <ID>` (an earlier ticket in the same repo). It branches from that ticket's branch and opens its PR into it, and is skipped if the base wasn't pushed.

Draft `projects/<name>/tonight.md` from your Linear Todo list by running `/tonight [project]` in Claude Code, or write it by hand following [`templates/project/tonight.md`](../templates/project/tonight.md):

```md
## ENG-142 – export: add CSV download to the runs table
repo: app
- Reuse the existing row formatter in packages/export; don't add a CSV dependency.
```

Preview the night without editing target repos or publishing PRs. This still reads external services and writes local logs and reports:

```sh
npm run run:dry -- --project <name>
```

The report lands in `reports/<name>/nightshift-<date>.html`. Agent output and run logs go to `logs/<name>/`. The runner then moves the night's tickets to `reports/<name>/nightshift-<date>-tonight.md`, leaving only the header in `projects/<name>/tonight.md`, so the next night doesn't rerun them.

## Each morning

Read `reports/<name>/nightshift-<date>.html`. Ticket conflicts and review comments that need a person are listed first, under "Decisions needed". Each one needs a decision: update the ticket or the code, or answer the comment. The Postmortem section at the bottom lists suggested fixes to the instructions, also saved in `reports/<name>/nightshift-<date>-postmortem.md`. Ask Claude to implement the ones you pick by id, for example "implement P1 and P3". `/postmortem [date]` re-runs the postmortem by hand.
