import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");
export const SCOPE = "@justimpactgroup";
/** ClawHub's publishing owner (it must equal the scope) and the prefix of plugin ids and tools. */
export const OWNER = SCOPE.slice(1);

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
