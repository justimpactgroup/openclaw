// Creates a new plugin from tools/templates/plugin. Usage: npm run new-plugin -- <name>
// [--description "..."]. Check the result with `npm run check:project -- @justimpactgroup/<name>`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { OWNER, ROOT, SCOPE, readJson } from "./lib.ts";

const TEMPLATE_FOLDER = join(ROOT, "tools/templates/plugin");
const PLACEHOLDER = /__[A-Z][A-Z_]*__/; // for example __PACKAGE_NAME__

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The folder name must be lowercase kebab-case. Up to 43 characters keep the example tool name
 *  (prefix and "_echo" added) within OpenClaw's limit of 64. */
function validName(name: string | undefined): string {
  if (!name || !/^[a-z][a-z0-9-]{0,42}$/.test(name)) {
    fail("Usage: npm run new-plugin -- <name>   (lowercase kebab-case, at most 43 characters)");
  }
  return name;
}

/** "crm-sync" becomes "Just Impact Group Crm Sync". */
function displayNameFor(name: string): string {
  const words = name.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return `Just Impact Group ${words.join(" ")}`;
}

/** The OpenClaw version in use, and the typebox version OpenClaw pins. New plugins pin the same
 *  typebox, so users install what we tested. */
function readOpenclawVersions(): { openclaw: string; typebox: string } {
  const openclaw = readJson<{ version: string; dependencies: Record<string, string> }>(
    join(ROOT, "node_modules/openclaw/package.json"),
  );
  const typebox = openclaw.dependencies.typebox?.replace(/^[~^]/, "");
  if (!typebox) throw new Error("Could not determine OpenClaw's typebox version.");
  return { openclaw: openclaw.version, typebox };
}

/** Replaces the placeholders in every file of the new plugin. Fails if one is left over. */
function fillPlaceholders(folder: string, values: Record<string, string>): void {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      fillPlaceholders(path, values);
      continue;
    }
    // In .json and .ts files the values sit inside double-quoted strings, so escape them.
    const isQuoted = /\.(json|ts)$/.test(path);
    let content = readFileSync(path, "utf8");
    for (const [placeholder, value] of Object.entries(values)) {
      content = content.replaceAll(
        placeholder,
        isQuoted ? JSON.stringify(value).slice(1, -1) : value,
      );
    }
    const leftover = PLACEHOLDER.exec(content);
    if (leftover) throw new Error(`Unreplaced placeholder ${leftover[0]} in ${path}`);
    writeFileSync(path, content);
  }
}

/** Installs the new plugin's dependencies, then builds it and generates openclaw.plugin.json. */
function installAndBuild(folder: string): void {
  // typebox is OpenClaw's exact pin; accept it even if it is younger than min-release-age.
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--min-release-age-exclude=typebox"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  const tool = (name: string) => join(ROOT, "node_modules/.bin", name);
  const run = (command: string, args: string[]) =>
    execFileSync(tool(command), args, { cwd: folder, stdio: "inherit" });
  run("tsc", ["-p", "tsconfig.lib.json", "--noCheck"]);
  run("openclaw", ["plugins", "build"]);
  execFileSync(tool("prettier"), ["--write", folder], { stdio: "ignore" });
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { description: { type: "string" } },
});
const name = validName(positionals[0]);
const folder = join(ROOT, "plugins", name);
if (existsSync(folder)) fail(`plugins/${name} already exists`);

const displayName = displayNameFor(name);
const versions = readOpenclawVersions();

cpSync(TEMPLATE_FOLDER, folder, { recursive: true });
fillPlaceholders(folder, {
  __PACKAGE_NAME__: `${SCOPE}/${name}`,
  __NAME__: name,
  __PLUGIN_ID__: `${OWNER}-${name}`,
  __TOOL_NAME__: `${OWNER}_${name.replaceAll("-", "_")}_echo`,
  __DISPLAY_NAME__: displayName,
  __DESCRIPTION__: values.description ?? `${displayName} plugin for OpenClaw`,
  __OPENCLAW_VERSION__: versions.openclaw,
  __TYPEBOX_VERSION__: versions.typebox,
});
cpSync(join(ROOT, "LICENSE"), join(folder, "LICENSE"));
installAndBuild(folder);

console.log(`Created plugins/${name}. Check it with: npm run check:project -- ${SCOPE}/${name}`);
