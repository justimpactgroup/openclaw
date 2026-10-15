// Checks package-lock.json before `npm ci` installs from it. Usage: npm run check:lockfile
//
// `npm ci` installs exactly what the lockfile says, and nobody reads lockfile diffs closely. So a
// tampered lockfile could swap a package for a different one on the npm registry. This fails
// unless every entry is the registry tarball its own path names, with a sha512 hash.
import { join } from "node:path";
import { ROOT, readJson } from "./lib.ts";

const REGISTRY = "https://registry.npmjs.org/";
const NODE_MODULES = "node_modules/";
const PLUGIN_FOLDER = /^plugins\/[a-z0-9][a-z0-9._-]*$/; // workspace links may only point here
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

interface LockEntry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  inBundle?: boolean;
}

/** The tarball URL npm uses for a package, for example `@scope/pkg` at 1.2.3. */
function registryUrl(packageName: string, version: string): string {
  const fileName = packageName.split("/").pop();
  return `${REGISTRY}${packageName}/-/${fileName}-${version}.tgz`;
}

/** Returns what is wrong with one lockfile entry, or an empty list. */
function checkEntry(path: string, entry: LockEntry): string[] {
  const nameStart = path.lastIndexOf(NODE_MODULES);
  if (nameStart === -1) return []; // the root package and the workspace sources
  const packageName = path.slice(nameStart + NODE_MODULES.length);

  // Workspace packages are linked into node_modules; the link must lead to one of our plugins.
  if (entry.link) {
    return PLUGIN_FOLDER.test(entry.resolved ?? "") ? [] : [`links to ${entry.resolved}`];
  }

  // npm lists the contents of a bundled package nested, with no source of its own.
  const isNested = nameStart > 0;
  const hasSource = Boolean(entry.resolved || entry.integrity);
  const isPlainBundled =
    entry.inBundle && isNested && !hasSource && (entry.name ?? packageName) === packageName;
  if (isPlainBundled) return [];

  const problems: string[] = [];
  const version = entry.version ?? "";
  if (!VERSION.test(version)) problems.push(`invalid version ${entry.version}`);

  const expectedUrl = registryUrl(packageName, version);
  if (entry.resolved !== expectedUrl) {
    problems.push(`resolved is ${entry.resolved}, expected ${expectedUrl}`);
  }
  if (!entry.integrity?.startsWith("sha512-")) problems.push("no sha512 integrity");
  return problems;
}

const lockfile = readJson<{ lockfileVersion?: number; packages?: Record<string, LockEntry> }>(
  join(ROOT, "package-lock.json"),
);

const problems: string[] = [];
if (lockfile.lockfileVersion !== 3) problems.push("lockfileVersion must be 3");
for (const [path, entry] of Object.entries(lockfile.packages ?? {})) {
  for (const problem of checkEntry(path, entry)) problems.push(`${path}: ${problem}`);
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `✖ package-lock.json ${problem}`).join("\n"));
  process.exit(1);
}
console.log("Lockfile OK.");
