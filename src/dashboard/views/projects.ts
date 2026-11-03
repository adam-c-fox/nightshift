import { esc } from "../../report.js";
import type { CheckLevel, ConfigCheck } from "../project-checks.js";
import { badge } from "./clock-off.js";
import { fragmentSlot, page, refreshButton } from "./layout.js";

export const LEVEL_COLORS: Record<CheckLevel, string> = {
  pass: "#22c55e",
  warn: "#eab308",
  fail: "#ef4444",
};

const TEMPLATE_COLOR = "#6b7280";
const TEMPLATE_PROJECT = "example";
const ALL_PASS = "All checks pass";

const PROJECTS_CSS = `
  ul.checks { list-style: none; }
  ul.checks li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.75rem;
                 padding: 0.5rem 0; border-bottom: 1px solid var(--border);
                 overflow-wrap: anywhere; }
  ul.checks .check-name { font-weight: 600; }
  ul.checks .check-keys { flex: 1 1 100%; font-size: 0.85rem; }
  .page-actions { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }`;

const STYLE = `<style>${PROJECTS_CSS}</style>`;

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
<h1>Projects</h1>
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

export function projectPageHTML(name: string): string {
  const checksUrl = `/fragments/project-checks?name=${encodeURIComponent(name)}`;
  return page({
    title: name,
    nav: "projects",
    body: `${STYLE}
<p><a href="/projects">← Projects</a></p>
<h1>${esc(name)}</h1>
<h2>Checks</h2>
<div class="page-actions">${refreshButton("all", "Re-check")}</div>
${fragmentSlot(checksUrl, "checks")}`,
  });
}
