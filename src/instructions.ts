import path from "node:path";

export const GENERIC_AGENTS_MD = path.resolve(import.meta.dirname, "..", "AGENTS.md");

export function composeInstructions(generic: string, projectName: string, projectInstructions: string): string {
  if (projectInstructions.trim() === "") return generic;
  return `${generic.trimEnd()}\n\n---\n\n# Project: ${projectName}\n\n${projectInstructions}`;
}
