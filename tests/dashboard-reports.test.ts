import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGACY_PROJECT,
  listNightFiles,
  resolveReportFile,
} from "../src/dashboard/reports.js";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nightshift-")));
  const reportsDir = join(root, "reports");
  mkdirSync(join(reportsDir, "acme"), { recursive: true });
  mkdirSync(join(reportsDir, "beta"), { recursive: true });
  const files = [
    "acme/nightshift-2026-10-01.html",
    "acme/nightshift-2026-10-01.json",
    "acme/nightshift-2026-10-01-2.html",
    "acme/nightshift-2026-10-01-postmortem.md",
    "acme/nightshift-2026-10-01-tonight.md",
    "beta/nightshift-2026-10-02.html",
    "nightshift-2026-09-01.html",
    "notes.html",
  ];
  for (const file of files) writeFileSync(join(reportsDir, file), "x");
  writeFileSync(join(root, "secret.html"), "secret");
  writeFileSync(join(root, "secret.txt"), "secret");
  symlinkSync(join(root, "secret.html"), join(reportsDir, "acme", "link.html"));
  symlinkSync(root, join(reportsDir, "outside"));
  return { root, reportsDir };
}

describe("listNightFiles", () => {
  it("lists per-project and legacy nights newest first", () => {
    const { reportsDir } = fixture();
    const nights = listNightFiles(reportsDir);
    expect(nights.map((night) => night.reportId)).toEqual([
      "beta/nightshift-2026-10-02",
      "acme/nightshift-2026-10-01-2",
      "acme/nightshift-2026-10-01",
      "nightshift-2026-09-01",
    ]);
  });

  it("marks legacy files and builds their href", () => {
    const { reportsDir } = fixture();
    const legacy = listNightFiles(reportsDir).find(
      (night) => night.reportId === "nightshift-2026-09-01",
    );
    expect(legacy).toMatchObject({
      project: LEGACY_PROJECT,
      base: "nightshift-2026-09-01",
      date: "2026-09-01",
      seq: 1,
      href: "/reports/nightshift-2026-09-01.html",
      htmlFile: join(reportsDir, "nightshift-2026-09-01.html"),
      jsonFile: null,
    });
  });

  it("sets jsonFile only where the JSON record exists and parses seq", () => {
    const { reportsDir } = fixture();
    const nights = listNightFiles(reportsDir);
    const withJson = nights.filter((night) => night.jsonFile !== null);
    expect(withJson.map((night) => night.reportId)).toEqual([
      "acme/nightshift-2026-10-01",
    ]);
    expect(withJson[0].jsonFile).toBe(
      join(reportsDir, "acme", "nightshift-2026-10-01.json"),
    );
    const seqs = Object.fromEntries(
      nights.map((night) => [night.reportId, night.seq]),
    );
    expect(seqs["acme/nightshift-2026-10-01-2"]).toBe(2);
    expect(seqs["acme/nightshift-2026-10-01"]).toBe(1);
  });

  it("returns an empty list when the reports dir is missing", () => {
    const { root } = fixture();
    expect(listNightFiles(join(root, "nope"))).toEqual([]);
  });

  it("orders same-night reports by project name", () => {
    const { reportsDir } = fixture();
    writeFileSync(join(reportsDir, "beta", "nightshift-2026-10-01.html"), "x");
    const ids = listNightFiles(reportsDir).map((night) => night.reportId);
    expect(ids.indexOf("acme/nightshift-2026-10-01")).toBeLessThan(
      ids.indexOf("beta/nightshift-2026-10-01"),
    );
  });

  it("does not follow symlinked project directories", () => {
    const { reportsDir } = fixture();
    expect(
      listNightFiles(reportsDir).some((night) => night.project === "outside"),
    ).toBe(false);
  });
});

describe("resolveReportFile", () => {
  it.each([
    [
      "/reports/acme/nightshift-2026-10-01.html",
      "acme/nightshift-2026-10-01.html",
    ],
    ["/reports/nightshift-2026-09-01.html", "nightshift-2026-09-01.html"],
    ["/reports/notes.html", "notes.html"],
    [
      "/reports/acme%2fnightshift-2026-10-01.html",
      "acme/nightshift-2026-10-01.html",
    ],
  ])("resolves %s", (urlPath, relative) => {
    const { reportsDir } = fixture();
    expect(resolveReportFile(reportsDir, urlPath)).toBe(
      join(reportsDir, relative),
    );
  });

  it.each([
    ["dot-dot segment", "/reports/../secret.html"],
    ["encoded dot-dot", "/reports/%2e%2e/secret.html"],
    ["upper-case encoded dot-dot", "/reports/%2E%2E/secret.html"],
    ["encoded slash traversal", "/reports/acme/..%2f..%2fsecret.html"],
    [
      "encoded slash traversal upper-case",
      "/reports/acme/..%2F..%2Fsecret.html",
    ],
    ["double-encoded dot-dot", "/reports/%252e%252e/secret.html"],
    ["double-encoded slash", "/reports/acme/..%252f..%252fsecret.html"],
    ["single dot segment", "/reports/./notes.html"],
    ["project dot-dot with file", "/reports/acme/../notes.html"],
    ["backslash traversal", "/reports/..\\secret.html"],
    ["encoded backslash traversal", "/reports/acme/..%5c..%5csecret.html"],
    ["backslash in file name", "/reports/acme\\nightshift-2026-10-01.html"],
    ["NUL byte raw", "/reports/notes.html\0.html"],
    ["NUL byte encoded", "/reports/notes.html%00.html"],
    ["NUL byte before extension", "/reports/secret%00.html"],
    ["absolute path", "/reports//etc/passwd.html"],
    ["encoded absolute path", "/reports/%2fetc%2fpasswd.html"],
    ["absolute path to secret", "/reports/%2f%2e%2e%2fsecret.html"],
    ["missing prefix", "/other/notes.html"],
    ["prefix without slash", "/reportsnotes.html"],
    ["no path after prefix", "/reports/"],
    ["markdown file", "/reports/acme/nightshift-2026-10-01-postmortem.md"],
    ["json file", "/reports/acme/nightshift-2026-10-01.json"],
    ["missing file", "/reports/acme/missing.html"],
    ["too many segments", "/reports/a/b/c.html"],
    ["bad encoding", "/reports/%E0%A4%A.html"],
    ["leading dot file name", "/reports/.hidden.html"],
    ["trailing slash", "/reports/acme/nightshift-2026-10-01.html/"],
    ["directory", "/reports/acme"],
    ["symlink escaping reports", "/reports/acme/link.html"],
    ["symlinked directory escaping reports", "/reports/outside/secret.html"],
  ])("rejects %s", (_name, urlPath) => {
    const { reportsDir } = fixture();
    expect(resolveReportFile(reportsDir, urlPath)).toBeNull();
  });

  it("allows a symlink that stays inside reports", () => {
    const { reportsDir } = fixture();
    symlinkSync(
      join(reportsDir, "notes.html"),
      join(reportsDir, "acme", "alias.html"),
    );
    expect(resolveReportFile(reportsDir, "/reports/acme/alias.html")).toBe(
      join(reportsDir, "acme", "alias.html"),
    );
  });

  it("returns null when the reports dir does not exist", () => {
    const { root } = fixture();
    expect(
      resolveReportFile(join(root, "nope"), "/reports/notes.html"),
    ).toBeNull();
  });
});
