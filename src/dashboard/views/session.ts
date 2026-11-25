import { esc, STATUS_COLORS } from "../../report.js";
import { PREP_SECTIONS } from "../../prep.js";
import { terminalCommand, type PrepSession, type SessionState } from "../sessions.js";
import { badge } from "./clock-off.js";
import { fragmentSlot, page } from "./layout.js";

const POLL_MS = 1500;
const VISIBLE_ACTIVITY = 12;
const NEEDS_YOU: SessionState[] = ["answering", "reviewing"];
const TERMINAL: SessionState[] = ["saved", "not_ready", "cancelled"];
const STATE_LABELS: Record<SessionState, string> = {
  surveying: "reading the code",
  answering: "needs your answers",
  drafting: "drafting",
  reviewing: "ready for review",
  revising: "revising",
  saving: "saving",
  saved: "saved",
  not_ready: "not ready",
  cancelled: "cancelled",
};

const cost = (s: PrepSession) => `$${s.usage.reduce((sum, u) => sum + u.costUsd, 0).toFixed(2)}`;

const safeUrl = (url: string) => (/^https?:\/\//.test(url) ? url : "");

export function sessionPageHTML(sid: string, ticketId?: string): string {
  return page({
    title: ticketId ? `Prep ${ticketId}` : "Prep",
    nav: "tonight",
    body: `<p><a href="/">Back to tonight</a></p>\n${fragmentSlot(`/fragments/session/${sid}`, "prep")}`,
  });
}

const activityHTML = (s: PrepSession, working: string) => {
  const items = s.activity
    .slice(-VISIBLE_ACTIVITY)
    .map((a) => `<li>${esc(a.text)}</li>`)
    .join("");
  return `<p class="dim" role="status">⏳ ${esc(working)}</p>\n<ul class="activity">${items}</ul>`;
};

const action = (name: string, label: string, primary = false) =>
  `<button type="button" class="btn${primary ? " primary" : ""}" data-session-action="${name}">${esc(label)}</button>`;

const notReadyHTML = () => `<details>
<summary>Not ready…</summary>
<label for="blockers" class="dim">What blocks this ticket (one line)</label>
<textarea id="blockers" rows="2" data-blockers></textarea>
${action("not-ready", "Record as not ready")}
</details>`;

function gapHTML(gap: NonNullable<PrepSession["survey"]>["gaps"][number]): string {
  const id = esc(gap.id);
  const radio = (value: string, label: string, checked = false) =>
    `<label><input type="radio" name="gap-${id}" value="${value}"${checked ? " checked" : ""}> ${label}</label>`;
  return `<fieldset data-gap="${id}">
<legend>${esc(gap.title)}</legend>
<p>${esc(gap.question)}</p>
${radio("recommended", `Recommended: ${esc(gap.recommended)}`, true)}
${gap.alternative === undefined ? "" : radio("alternative", `Alternative: ${esc(gap.alternative)}`)}
${radio("your_call", "Your call")}
${radio("other", "Other:")} <input type="text" data-other aria-label="Other answer for ${esc(gap.title)}">
</fieldset>`;
}

function answeringHTML(s: PrepSession): string {
  const survey = s.survey!;
  const pointers = survey.pointers.length
    ? `<aside><h3>Pointers</h3><ul>${survey.pointers.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></aside>`
    : "";
  return `<p class="dim">Repo: ${esc(survey.repo)}</p>
${pointers}
${survey.gaps.map(gapHTML).join("\n")}
<p>${action("answers", "Draft description", true)}</p>
${notReadyHTML()}`;
}

function newSections(draft: string): string {
  return draft
    .split(/^(?=## )/m)
    .filter((chunk) => PREP_SECTIONS.test(chunk))
    .join("");
}

function reviewingHTML(s: PrepSession): string {
  const draft = s.draft ?? "";
  return `<h3>New sections</h3>
<pre class="highlight">${esc(newSections(draft))}</pre>
<label for="draft" class="dim">Full description, editable</label>
<textarea id="draft" rows="24" data-draft>${esc(draft)}</textarea>
<p>${action("approve", "Approve and save", true)}</p>
<details>
<summary>Ask for changes…</summary>
<label for="feedback" class="dim">What should change</label>
<textarea id="feedback" rows="3" data-feedback></textarea>
${action("revise", "Send feedback")}
</details>
${notReadyHTML()}`;
}

function failedHTML(s: PrepSession): string {
  const label = s.error === "interrupted" ? "Interrupted by a server restart" : `Failed: ${s.error}`;
  return `<div class="error">${esc(label)}</div>
<p>${action("retry", "Retry", true)} ${action("cancel", "Cancel")}</p>`;
}

function savedHTML(s: PrepSession): string {
  const url = safeUrl(s.ticket.url);
  const link = url ? ` <a href="${esc(url)}" target="_blank" rel="noopener">Open ${esc(s.ticketId)}</a>` : "";
  return `<p><strong>Saved to Linear</strong>${link}</p>
<p class="dim">Repo: ${esc(s.survey?.repo ?? "unknown")} · ready</p>`;
}

function bodyHTML(s: PrepSession): string {
  if (s.error !== undefined && !s.running && !TERMINAL.includes(s.state)) return failedHTML(s);
  switch (s.state) {
    case "surveying":
      return activityHTML(s, "Reading the code…");
    case "answering":
      return answeringHTML(s);
    case "drafting":
      return activityHTML(s, "Drafting the description…");
    case "revising":
      return activityHTML(s, "Revising the description…");
    case "reviewing":
      return reviewingHTML(s);
    case "saving":
      return `<p class="dim" role="status">⏳ Saving to Linear…</p>`;
    case "saved":
      return savedHTML(s);
    case "not_ready":
      return `<p><strong>Marked not ready</strong></p><p>${esc(s.blockers ?? "")}</p>`;
    case "cancelled":
      return `<p class="dim">Cancelled.</p>`;
  }
}

export function sessionFragmentHTML(s: PrepSession, root: string): string {
  const url = safeUrl(s.ticket.url);
  const id = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(s.ticketId)}</a>` : esc(s.ticketId);
  const poll = s.running ? ` data-poll="${POLL_MS}"` : "";
  return `<div class="session" data-session="${esc(s.id)}"${poll}>
<h2>Prep ${id} · ${esc(s.ticket.title)} ${badge(STATE_LABELS[s.state], STATUS_COLORS.partial)}</h2>
<p class="dim">est. cost so far ${cost(s)} · <button type="button" class="btn" data-copy="${esc(terminalCommand(s, root))}">Run in terminal instead</button></p>
${bodyHTML(s)}
</div>`;
}

export function openPrepsHTML(sessions: PrepSession[]): string {
  const open = sessions.filter((s) => !TERMINAL.includes(s.state));
  if (open.length === 0) return "";
  const items = open.map((s) => {
    const needsYou = NEEDS_YOU.includes(s.state) ? ` ${badge("needs you", STATUS_COLORS.error)}` : "";
    const failed = s.error !== undefined && !s.running ? " · failed" : "";
    return `<li><a href="/prep/${esc(s.id)}">${esc(s.ticketId)}</a> ${esc(STATE_LABELS[s.state])}${failed}${needsYou} <span class="dim">est. ${cost(s)}</span></li>`;
  });
  return `<h3>Open preps</h3>\n<ul class="open-preps">${items.join("")}</ul>`;
}
