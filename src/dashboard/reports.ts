import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { nightRecordFile } from "../night-record.js";
import { PROJECT_NAME } from "../project.js";
import { REPORT_BASE } from "../report.js";

export const LEGACY_PROJECT = "legacy";

export interface NightFile {
  reportId: string;
  project: string;
  base: string;
  date: string;
  seq: number;
  htmlFile: string;
  jsonFile: string | null;
  href: string;
}

const REPORTS_PREFIX = "/reports/";
const REPORT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;

function nightFile(
  reportsDir: string,
  project: string | null,
  fileName: string,
): NightFile | null {
  if (!fileName.endsWith(".html")) return null;
  const base = fileName.slice(0, -".html".length);
  const match = REPORT_BASE.exec(base);
  if (!match) return null;
  const dir = project === null ? reportsDir : path.join(reportsDir, project);
  const jsonFile = nightRecordFile(dir, base);
  const reportId = project === null ? base : `${project}/${base}`;
  return {
    reportId,
    project: project ?? LEGACY_PROJECT,
    base,
    date: match[1],
    seq: match[2] ? Number(match[2]) : 1,
    htmlFile: path.join(dir, fileName),
    jsonFile: existsSync(jsonFile) ? jsonFile : null,
    href: `${REPORTS_PREFIX}${reportId}.html`,
  };
}

function htmlFilesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

export function listNightFiles(reportsDir: string): NightFile[] {
  if (!existsSync(reportsDir)) return [];
  const entries = readdirSync(reportsDir, { withFileTypes: true });
  const projects = entries
    .filter((entry) => entry.isDirectory() && PROJECT_NAME.test(entry.name))
    .map((entry) => entry.name);
  const nights = [
    ...htmlFilesIn(reportsDir).map((name) => nightFile(reportsDir, null, name)),
    ...projects.flatMap((project) =>
      htmlFilesIn(path.join(reportsDir, project)).map((name) =>
        nightFile(reportsDir, project, name),
      ),
    ),
  ].filter((night): night is NightFile => night !== null);
  return nights.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      b.seq - a.seq ||
      a.project.localeCompare(b.project),
  );
}

function decodeSegments(urlPath: string): string[] | null {
  if (!urlPath.startsWith(REPORTS_PREFIX)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.slice(REPORTS_PREFIX.length));
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  const segments = decoded.split("/");
  const valid =
    segments.length <= 2 &&
    segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== "..",
    );
  return valid ? segments : null;
}

function isRegularFile(file: string): boolean {
  return statSync(file).isFile();
}

export function resolveReportFile(
  reportsDir: string,
  urlPath: string,
): string | null {
  const segments = decodeSegments(urlPath);
  if (!segments) return null;
  const fileName = segments[segments.length - 1];
  const projects = segments.slice(0, -1);
  if (!REPORT_FILE.test(fileName)) return null;
  if (!projects.every((project) => PROJECT_NAME.test(project))) return null;
  const file = path.resolve(reportsDir, ...segments);
  try {
    const realDir = realpathSync(reportsDir);
    const realFile = realpathSync(file);
    const inside = realFile.startsWith(realDir + path.sep);
    return inside && isRegularFile(realFile) ? file : null;
  } catch {
    return null;
  }
}
