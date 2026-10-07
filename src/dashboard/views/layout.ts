import { esc, STATUS_COLORS, THEME_CSS } from "../../report.js";
import type { RefreshTarget } from "../cache.js";
import type { LaunchRequest } from "../launch.js";

export const DASHBOARD_CSS = `
  body { padding: 1rem; max-width: 1100px; margin: 0 auto; }
  @media (min-width: 640px) { body { padding: 2rem; } }
  a { color: var(--accent); }
  a:hover { color: var(--text); }
  a:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px; }
  header.top { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
               margin-bottom: 1.5rem; }
  header.top .brand { font-size: 1.2rem; font-weight: 700; margin-right: auto; }
  nav { display: flex; gap: 0.5rem; }
  nav a { color: var(--text-dim); text-decoration: none; padding: 0.4rem 0.8rem;
          border: 1px solid transparent; border-radius: 6px; }
  nav a:hover { color: var(--text); border-color: var(--border); }
  nav a[aria-current="page"] { color: var(--text); background: var(--surface);
                               border-color: var(--border); }
  h2 { font-size: 1.05rem; margin: 1.75rem 0 0.75rem; }
  .dim { color: var(--text-dim); }
  .loading { color: var(--text-dim); }
  .btn, select { font: inherit; color: var(--text); background: var(--surface);
          border: 1px solid var(--border); border-radius: 6px; padding: 0.4rem 0.8rem;
          min-height: 2.25rem; }
  .btn { cursor: pointer; }
  .btn:hover { border-color: var(--accent); }
  .btn:active { background: var(--accent); }
  .btn:disabled { opacity: 0.5; cursor: progress; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.primary:hover { filter: brightness(1.1); }
  .project-picker { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1.25rem;
         background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
         padding: 0.75rem 1rem; margin-bottom: 1rem; }
  .bar .spacer { flex: 1 1 auto; }
  .bar .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .banner, .error { border: 1px solid var(--border); border-left-width: 4px; border-radius: 6px;
                    background: var(--surface); padding: 0.6rem 0.9rem; margin-bottom: 0.75rem;
                    overflow-wrap: anywhere; }
  .banner { border-left-color: ${STATUS_COLORS.partial}; }
  .error { border-left-color: ${STATUS_COLORS.error}; }
  .error .btn { margin-left: 0.5rem; }
  ul.warnings { list-style: none; margin-bottom: 1rem; }
  ul.warnings li { padding: 0.35rem 0; color: var(--text-dim); overflow-wrap: anywhere; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--text-dim); font-weight: 600; font-size: 0.8rem;
       padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border); }
  td { padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--border); vertical-align: top;
       overflow-wrap: anywhere; }
  tr.not-todo { opacity: 0.6; }
  .badge { display: inline-block; color: #fff; font-size: 0.7rem; font-weight: 700;
           padding: 0.2rem 0.6rem; border-radius: 4px; letter-spacing: 0.5px; white-space: nowrap; }
  .state { color: var(--text-dim); font-size: 0.85rem; }
  .slot { min-height: 1.5rem; }
  .is-actioned { opacity: 0.5; transition: opacity 0.3s; }
  .run-banner { background: var(--surface); border: 1px solid var(--border);
                border-left: 4px solid var(--accent); border-radius: 6px;
                padding: 0.6rem 0.9rem; margin-bottom: 0.75rem; overflow-wrap: anywhere; }
  .run-banner.stale { border-color: ${STATUS_COLORS.error}; }
  .empty { color: var(--text-dim); }
  ul.inbox { list-style: none; }
  li.inbox-item { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.75rem;
                  padding: 0.6rem 0; border-bottom: 1px solid var(--border);
                  transition: opacity 0.3s; }
  li.inbox-item .when { font-size: 0.8rem; }
  li.inbox-item .inbox-body { flex: 1 1 100%; min-width: 0; display: flex; flex-wrap: wrap;
                              align-items: baseline; gap: 0.25rem 0.6rem; overflow-wrap: anywhere; }
  li.inbox-item .summary { flex: 1 1 100%; }
  input.inbox-tick { width: 1.1rem; height: 1.1rem; accent-color: #22c55e; cursor: pointer; flex: none; }
  #toast { position: fixed; left: 1rem; right: 1rem; bottom: 1rem; max-width: 640px;
           margin: 0 auto; background: var(--surface); border: 1px solid var(--accent);
           border-radius: 8px; padding: 0.75rem 1rem; overflow-wrap: anywhere;
           box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5); display: none; user-select: all; }
  #toast.show { display: block; }
  @media (max-width: 639px) {
    table.tickets, table.tickets tbody, table.tickets tr, table.tickets td { display: block; }
    table.tickets thead { display: none; }
    table.tickets tr { background: var(--surface); border: 1px solid var(--border);
                       border-radius: 8px; margin-bottom: 0.75rem; padding: 0.25rem 0; }
    table.tickets td { display: flex; justify-content: space-between; gap: 1rem;
                       border-bottom: 0; padding: 0.35rem 0.9rem; text-align: right; }
    table.tickets td::before { content: attr(data-label); color: var(--text-dim);
                               text-align: left; flex: none; }
    table.tickets td.action::before { content: none; }
    table.tickets td.action { justify-content: flex-start; }
  }`;

export const CLIENT_SCRIPT = `(() => {
  const toastEl = document.getElementById("toast");
  let toastTimer;
  const toast = (message) => {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 10000);
  };

  const loadFragment = async (el) => {
    const ticket = (el.loadTicket = (el.loadTicket || 0) + 1);
    let html;
    try {
      const res = await fetch(el.dataset.fragment);
      html = res.ok
        ? await res.text()
        : '<div class="error">Couldn&#39;t load this section (' + res.status + '). <button type="button" class="btn" data-retry>Retry</button></div>';
    } catch {
      html = '<div class="error">Couldn&#39;t load this section (network error). <button type="button" class="btn" data-retry>Retry</button></div>';
    }
    if (ticket === el.loadTicket) el.innerHTML = html;
  };
  const loadAll = () => document.querySelectorAll("[data-fragment]").forEach(loadFragment);

  const post = async (url, body, method = "POST") => {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "X-Nightshift": "1" },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || "Request failed (" + res.status + ")");
    return data;
  };

  const launch = async (button) => {
    button.disabled = true;
    try {
      const result = await post("/api/launch", JSON.parse(button.dataset.launch));
      if (result.launched) {
        toast('Opened herdr workspace "' + result.agent + '"');
      } else {
        const message = "herdr unavailable (" + result.reason + "). Command copied: " + result.command;
        try {
          await navigator.clipboard.writeText(result.command);
          toast(message);
        } catch {
          toast("herdr unavailable (" + result.reason + "). Copy this command: " + result.command);
        }
      }
    } catch (err) {
      toast(err.message);
    } finally {
      button.disabled = false;
    }
  };

  const refresh = async (button) => {
    button.disabled = true;
    try {
      await post("/api/refresh", { what: button.dataset.refresh });
      loadAll();
    } catch (err) {
      toast(err.message);
    } finally {
      button.disabled = false;
    }
  };

  const tick = async (box) => {
    const now = new Date().toISOString();
    const item = box.closest(".inbox-item, li, tr");
    try {
      await post(
        "/api/actions?report=" + encodeURIComponent(box.dataset.report),
        { [box.dataset.key]: { at: box.checked ? now : null, updatedAt: now } },
        "PUT",
      );
      if (box.checked && item) {
        item.classList.add("is-actioned");
        setTimeout(() => item.remove(), 600);
      }
    } catch (err) {
      box.checked = !box.checked;
      toast(err.message);
    }
  };

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const launchButton = target && target.closest("[data-launch]");
    if (launchButton) return launch(launchButton);
    const refreshButton = target && target.closest("[data-refresh]");
    if (refreshButton) return refresh(refreshButton);
    const retry = target && target.closest("[data-retry]");
    if (retry) {
      const slot = retry.closest("[data-fragment]");
      if (slot) loadFragment(slot);
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target.matches && target.matches("input.inbox-tick")) tick(target);
    if (target.id === "project") location.href = "/?project=" + encodeURIComponent(target.value);
  });

  document.querySelectorAll("[data-fragment]").forEach((el) => {
    loadFragment(el);
    const seconds = Number(el.dataset.poll);
    if (seconds > 0) {
      setInterval(() => { if (!document.hidden) loadFragment(el); }, seconds * 1000);
    }
  });
})();`;

export function page(opts: {
  title: string;
  nav: "tonight" | "projects";
  body: string;
}): string {
  const link = (href: string, label: string, key: typeof opts.nav) =>
    `<a href="${href}"${opts.nav === key ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<style>${THEME_CSS}${DASHBOARD_CSS}</style>
</head>
<body>
<header class="top">
  <span class="brand">🌙 Nightshift</span>
  <nav aria-label="Main">${link("/", "Tonight", "tonight")}${link("/projects", "Projects", "projects")}</nav>
</header>
<main>${opts.body}</main>
<div id="toast" role="status" aria-live="polite"></div>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

export function fragmentSlot(
  url: string,
  label: string,
  opts: { poll?: number } = {},
): string {
  const poll = opts.poll ? ` data-poll="${opts.poll}"` : "";
  return `<div class="slot" data-fragment="${esc(url)}"${poll}><p class="loading">Loading ${esc(label)}…</p></div>`;
}

export function errorBox(message: string): string {
  return `<div class="error">${esc(message)}</div>`;
}

export function launchButton(req: LaunchRequest, label: string): string {
  return `<button type="button" class="btn primary" data-launch="${esc(JSON.stringify(req))}">${esc(label)}</button>`;
}

export function refreshButton(what: RefreshTarget, label: string): string {
  return `<button type="button" class="btn" data-refresh="${esc(what)}">${esc(label)}</button>`;
}
