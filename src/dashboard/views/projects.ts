import { esc } from "../../report.js";
import {
  LINEAR_TEAM_KEY,
  PROJECT_NAME,
  REPO_NAME_PATTERN,
  TOOLCHAINS,
} from "../../project.js";
import type { LinearTeam } from "../../linear.js";
import type { Loaded } from "../cache.js";
import type { CheckLevel, ConfigCheck } from "../project-checks.js";
import { badge } from "./clock-off.js";
import { errorBox, fragmentSlot, page, refreshButton } from "./layout.js";

export const LEVEL_COLORS: Record<CheckLevel, string> = {
  pass: "#22c55e",
  warn: "#eab308",
  fail: "#ef4444",
};

const TEMPLATE_COLOR = "#6b7280";
const TEMPLATE_PROJECT = "example";
const ALL_PASS = "All checks pass";
const NAME_PATTERN = PROJECT_NAME.source.slice(1, -1);
const ROW_INDEX_PLACEHOLDER = "__i__";

type Json = Record<string, unknown>;
type Teams = Loaded<LinearTeam[]>;
type RepoFields = {
  name: string;
  path: string;
  toolchain: string;
  description: string;
};

const PROJECTS_CSS = `
  .form-grid { display: grid; gap: 0.9rem; max-width: 640px; }
  .field { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
  .field label, fieldset legend { font-size: 0.85rem; color: var(--text-dim); }
  .field .hint { font-size: 0.8rem; }
  input[type="text"], input[type="number"] { font: inherit; color: var(--text);
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 0.4rem 0.6rem; min-height: 2.25rem; width: 100%; min-width: 0; }
  fieldset { border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem;
             min-width: 0; }
  .repo-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.6rem;
              padding: 0.75rem 0; border-bottom: 1px solid var(--border); }
  @media (min-width: 640px) {
    .repo-row { grid-template-columns: 1fr 2fr 9rem; }
    .repo-row .wide { grid-column: 1 / -1; }
  }
  .team-list { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; }
  .team-list label { display: flex; align-items: center; gap: 0.4rem; color: var(--text); }
  .form-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  .form-result { overflow-wrap: anywhere; min-height: 1.25rem; }
  .form-result.error { color: ${LEVEL_COLORS.fail}; }
  ul.checks { list-style: none; }
  ul.checks li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.75rem;
                 padding: 0.5rem 0; border-bottom: 1px solid var(--border);
                 overflow-wrap: anywhere; }
  ul.checks .check-name { font-weight: 600; }
  ul.checks .check-keys { flex: 1 1 100%; font-size: 0.85rem; }
  .page-actions { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  a.btn { text-decoration: none; display: inline-flex; align-items: center; }`;

const STYLE = `<style>${PROJECTS_CSS}</style>`;

const FORM_SCRIPT = `(() => {
  const form = document.getElementById("project-form");
  const result = form.querySelector(".form-result");
  const rows = form.querySelector(".repo-rows");
  const template = document.getElementById("repo-row");
  let nextRow = Number(rows.dataset.next);

  const showResult = (message, isError) => {
    result.className = "form-result" + (isError ? " error" : "");
    result.textContent = message;
  };

  const read = (row, name) => row.querySelector('[name="' + name + '"]').value.trim();

  const collect = () => {
    const repos = [...rows.querySelectorAll(".repo-row")].map((row) => ({
      name: read(row, "repoName"),
      path: read(row, "path"),
      toolchain: read(row, "toolchain"),
      description: read(row, "description"),
    }));
    const allowance = form.querySelector('[name="allowancePercent"]').value.trim();
    const testDb = form.querySelector('[name="testDb"]').value.trim();
    const typedTeams = form.querySelector('[name="linearTeamsText"]');
    const teams = typedTeams
      ? typedTeams.value.split(",")
      : [...form.querySelectorAll('input[name="linearTeam"]:checked')].map((box) => box.value);
    return {
      repos,
      defaultRepo: form.querySelector('[name="defaultRepo"]').value.trim(),
      allowancePercent: allowance === "" ? null : Number(allowance),
      testDb: testDb === "" ? null : testDb,
      linearTeams: teams.map((key) => key.trim().toUpperCase()).filter(Boolean),
    };
  };

  const reloadChecks = async () => {
    const slot = document.querySelector('[data-fragment^="/fragments/project-checks"]');
    if (!slot) return;
    try {
      const res = await fetch(slot.dataset.fragment);
      if (res.ok) slot.innerHTML = await res.text();
    } catch {}
  };

  const showCreated = (name, envKeys) => {
    const fill = envKeys.length
      ? " Now fill in projects/" + name + "/.env with: " + envKeys.join(", ")
      : "";
    showResult("Created projects/" + name + "/." + fill, false);
    const link = document.createElement("a");
    link.href = "/projects/" + encodeURIComponent(name);
    link.textContent = " Open " + name;
    result.append(link);
  };

  form.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("[data-add-repo]")) {
      rows.insertAdjacentHTML(
        "beforeend",
        template.innerHTML.split("${ROW_INDEX_PLACEHOLDER}").join(String(nextRow++)),
      );
    }
    const remove = target.closest("[data-remove-repo]");
    if (remove) remove.closest(".repo-row").remove();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const creating = form.dataset.mode === "create";
    let created = false;
    submit.disabled = true;
    showResult(creating ? "Creating…" : "Saving…", false);
    try {
      const input = collect();
      const name = creating ? form.querySelector('[name="name"]').value.trim() : form.dataset.name;
      const body = creating ? { name, ...input } : input;
      const res = await fetch(form.dataset.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Nightshift": "1" },
        body: JSON.stringify(body),
      });
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok) {
        showResult((data && data.error) || "Request failed (" + res.status + ")", true);
        return;
      }
      if (creating) {
        created = true;
        showCreated(name, (data && data.envKeys) || []);
      } else {
        showResult("Saved.", false);
        await reloadChecks();
      }
    } catch (err) {
      showResult("Request failed: " + err.message, true);
    } finally {
      submit.disabled = created;
    }
  });
})();`;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function field(id: string, label: string, control: string, hint = ""): string {
  const hintHtml = hint ? `<span class="hint dim">${esc(hint)}</span>` : "";
  return `<div class="field"><label for="${esc(id)}">${esc(label)}</label>${control}${hintHtml}</div>`;
}

function textInput(
  id: string,
  name: string,
  value: string,
  extra = "",
): string {
  return `<input type="text" id="${esc(id)}" name="${esc(name)}" value="${esc(value)}"${extra}>`;
}

function toolchainSelect(id: string, selected: string): string {
  const known = (TOOLCHAINS as readonly string[]).includes(selected);
  const values = known ? [...TOOLCHAINS] : [selected, ...TOOLCHAINS];
  const options = values
    .map(
      (value) =>
        `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(value)}</option>`,
    )
    .join("");
  return `<select id="${esc(id)}" name="toolchain">${options}</select>`;
}

function repoRow(index: string, repo: RepoFields): string {
  const id = (part: string) => `repo-${index}-${part}`;
  const nameInput = textInput(
    id("name"),
    "repoName",
    repo.name,
    ` pattern="${esc(REPO_NAME_PATTERN)}" required`,
  );
  const pathInput = textInput(id("path"), "path", repo.path, " required");
  const descriptionInput = textInput(
    id("description"),
    "description",
    repo.description,
  );
  return `<div class="repo-row">
  ${field(id("name"), "Repo name", nameInput)}
  ${field(id("path"), "Path (absolute)", pathInput)}
  ${field(id("toolchain"), "Toolchain", toolchainSelect(id("toolchain"), repo.toolchain))}
  <div class="wide">${field(id("description"), "Description", descriptionInput)}</div>
  <div class="wide"><button type="button" class="btn" data-remove-repo>Remove</button></div>
</div>`;
}

function blankRepo(): RepoFields {
  return { name: "", path: "", toolchain: TOOLCHAINS[0], description: "" };
}

function repoEntries(raw: Json): RepoFields[] {
  if (!isObject(raw.repos)) return [];
  return Object.entries(raw.repos).map(([name, repo]) => {
    const config = isObject(repo) ? repo : {};
    return {
      name,
      path: text(config.path),
      toolchain: text(config.toolchain) || TOOLCHAINS[0],
      description: text(config.description),
    };
  });
}

function reposFieldset(raw: Json, mode: "edit" | "create"): string {
  const entries = repoEntries(raw);
  const initial =
    entries.length === 0 && mode === "create" ? [blankRepo()] : entries;
  const rows = initial.map((repo, i) => repoRow(String(i), repo)).join("\n");
  return `<fieldset>
  <legend>Repos</legend>
  <div class="repo-rows" data-next="${initial.length}">${rows}</div>
  <button type="button" class="btn" data-add-repo>Add repo</button>
  <template id="repo-row">${repoRow(ROW_INDEX_PLACEHOLDER, blankRepo())}</template>
</fieldset>`;
}

function configuredTeams(raw: Json): string[] {
  return Array.isArray(raw.linearTeams)
    ? raw.linearTeams.filter(
        (key): key is string =>
          typeof key === "string" && LINEAR_TEAM_KEY.test(key),
      )
    : [];
}

function teamsField(raw: Json, teams: Teams): string {
  const configured = configuredTeams(raw);
  if (!teams.ok) {
    return `<div class="field">
  <label for="linear-teams-text">Team keys, comma separated</label>
  ${textInput("linear-teams-text", "linearTeamsText", configured.join(", "))}
  <span class="hint dim">Linear unavailable: ${esc(teams.error)}</span>
</div>`;
  }
  const listed = teams.value.map((team) => ({
    key: team.key,
    label: `${team.key} — ${team.name}`,
  }));
  const unlisted = configured
    .filter((key) => !listed.some((team) => team.key === key))
    .map((key) => ({ key, label: `${key} — not in Linear` }));
  const boxes = [...listed, ...unlisted]
    .map(({ key, label }) => {
      const id = `team-${key}`;
      const checked = configured.includes(key) ? " checked" : "";
      return `<label for="${esc(id)}"><input type="checkbox" id="${esc(id)}" name="linearTeam" value="${esc(key)}"${checked}>${esc(label)}</label>`;
    })
    .join("");
  return `<fieldset>
  <legend>Linear teams</legend>
  <div class="team-list">${boxes || '<span class="dim">No teams found.</span>'}</div>
</fieldset>`;
}

export function projectFormHTML(opts: {
  name?: string;
  raw: Record<string, unknown>;
  teams: Teams;
  mode: "edit" | "create";
}): string {
  const { raw, teams, mode } = opts;
  const creating = mode === "create";
  const name = opts.name ?? "";
  const action = creating
    ? "/api/projects"
    : `/api/projects/${encodeURIComponent(name)}`;
  const allowance =
    typeof raw.allowancePercent === "number"
      ? String(raw.allowancePercent)
      : "";
  const nameField = creating
    ? field(
        "project-name",
        "Project name",
        textInput(
          "project-name",
          "name",
          "",
          ` pattern="${esc(NAME_PATTERN)}" required`,
        ),
        "Letters, digits, dot, dash and underscore",
      )
    : "";
  const testDbHint = creating
    ? "absolute path, or leave blank and add it later"
    : "absolute path to the test database";
  const defaultRepoInput = textInput(
    "default-repo",
    "defaultRepo",
    text(raw.defaultRepo),
    ' placeholder="only needed with 2+ repos"',
  );
  const allowanceInput = `<input type="number" id="allowance-percent" name="allowancePercent" min="1" max="100" step="1" value="${esc(allowance)}" placeholder="15">`;
  return `<form id="project-form" class="form-grid" data-mode="${mode}" data-name="${esc(name)}" data-action="${esc(action)}">
  ${nameField}
  ${reposFieldset(raw, mode)}
  ${field("default-repo", "Default repo", defaultRepoInput)}
  ${field("allowance-percent", "Allowance percent", allowanceInput)}
  ${field("test-db", "Test database", textInput("test-db", "testDb", text(raw.testDb)), testDbHint)}
  ${teamsField(raw, teams)}
  <div class="form-actions"><button type="submit" class="btn primary">${creating ? "Create" : "Save"}</button></div>
  <div class="form-result" aria-live="polite"></div>
</form>
<script>${FORM_SCRIPT}</script>`;
}

export function projectsListHTML(
  projects: { name: string; level: CheckLevel; reason: string }[],
): string {
  const rows = projects
    .map((project) => {
      const tag =
        project.name === TEMPLATE_PROJECT
          ? ` ${badge("template", TEMPLATE_COLOR)}`
          : "";
      return `<tr>
  <td data-label="Name"><a href="/projects/${encodeURIComponent(project.name)}">${esc(project.name)}</a>${tag}</td>
  <td data-label="Status">${badge(project.level, LEVEL_COLORS[project.level])}</td>
  <td data-label="Reason">${esc(project.reason || ALL_PASS)}</td>
</tr>`;
    })
    .join("\n");
  const table = projects.length
    ? `<table class="tickets"><thead><tr><th>Name</th><th>Status</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="empty">No projects yet.</p>`;
  return page({
    title: "Projects",
    nav: "projects",
    body: `${STYLE}
<div class="page-actions"><h1>Projects</h1><a class="btn primary" href="/projects/new">New project</a></div>
${table}`,
  });
}

function keysSummary(keys: NonNullable<ConfigCheck["keys"]>): string {
  const parts = [];
  if (keys.present.length) parts.push(`present: ${keys.present.join(", ")}`);
  if (keys.missing.length) parts.push(`missing: ${keys.missing.join(", ")}`);
  return parts.join(" · ");
}

export function projectChecksHTML(checks: ConfigCheck[]): string {
  const items = checks
    .map((check) => {
      const summary = check.keys ? keysSummary(check.keys) : "";
      const keys = summary
        ? `<span class="check-keys dim">${esc(summary)}</span>`
        : "";
      return `<li>${badge(check.level, LEVEL_COLORS[check.level])}<span class="check-name">${esc(check.name)}</span><span class="dim">${esc(check.reason)}</span>${keys}</li>`;
    })
    .join("");
  return `<ul class="checks">${items}</ul>`;
}

export function projectPageHTML(
  name: string,
  raw: unknown,
  rawError: string | undefined,
  teams: Teams,
): string {
  const editor = rawError
    ? errorBox(
        `project.json can't be read: ${rawError}. Fix it by hand; the form needs valid JSON.`,
      )
    : projectFormHTML({
        name,
        raw: isObject(raw) ? raw : {},
        teams,
        mode: "edit",
      });
  const checksUrl = `/fragments/project-checks?name=${encodeURIComponent(name)}`;
  return page({
    title: name,
    nav: "projects",
    body: `${STYLE}
<p><a href="/projects">← Projects</a></p>
<h1>${esc(name)}</h1>
<h2>Checks</h2>
<div class="page-actions">${refreshButton("all", "Re-check")}</div>
${fragmentSlot(checksUrl, "checks")}
<h2>Edit</h2>
${editor}`,
  });
}

export function newProjectHTML(teams: Teams): string {
  return page({
    title: "New project",
    nav: "projects",
    body: `${STYLE}
<h1>New project</h1>
${projectFormHTML({ raw: {}, teams, mode: "create" })}`,
  });
}
