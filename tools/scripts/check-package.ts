// Repo rules for the built plugin in the current directory. Run by the plugin's `validate` target
// after the build, so `dist/` exists. Prints every problem it finds. The rules about tool schemas
// and credentials are explained in docs/plugin-security.md.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { OWNER, ROOT, SCOPE, readJson } from "./lib.ts";

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/; // OpenClaw's limit is 64 characters
const CREDENTIAL_KEY =
  /secret|password|passphrase|api.?key|private.?key|encrypt.?key|token$|credentials?$/i;

interface PackageJson {
  name: string;
  license?: string;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  openclaw?: { extensions?: string[]; compat?: { pluginApi?: string } };
}

interface Manifest {
  id?: string;
  contracts?: { tools?: string[] };
  configSchema?: JsonSchema;
  configContracts?: { secretInputs?: { paths?: { path: string }[] } };
}

/** The parts of a JSON schema these checks look at. */
interface JsonSchema {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  maxLength?: number;
  maximum?: number;
  exclusiveMaximum?: number;
  maxItems?: number;
  maxProperties?: number;
  properties?: Record<string, JsonSchema>;
  patternProperties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
}

const folderName = basename(process.cwd());
const pkg = readJson<PackageJson>("package.json");
const manifest = readJson<Manifest>("openclaw.plugin.json");

/** Names must follow our scheme: ClawHub needs owner = scope, and the release finds tags by scope. */
function checkNames(): string[] {
  const problems: string[] = [];
  if (pkg.name !== `${SCOPE}/${folderName}`) {
    problems.push(`package name must be "${SCOPE}/${folderName}"`);
  }
  if (manifest.id !== `${OWNER}-${folderName}`) {
    problems.push(`plugin id must be "${OWNER}-${folderName}"`);
  }
  for (const tool of manifest.contracts?.tools ?? []) {
    if (!tool.startsWith(`${OWNER}_`) || !TOOL_NAME.test(tool)) {
      problems.push(`tool "${tool}" must start with "${OWNER}_" and be a valid OpenClaw tool name`);
    }
  }
  return problems;
}

/** npm and ClawHub only ship files from the package folder, so each plugin carries its own copy. */
function checkLicense(): string[] {
  const rootLicense = readFileSync(join(ROOT, "LICENSE"), "utf8");
  const hasCopy = existsSync("LICENSE") && readFileSync("LICENSE", "utf8") === rootLicense;
  return pkg.license === "MIT" && hasCopy
    ? []
    : ['license must be "MIT", with a copy of the root LICENSE'];
}

function checkDependencies(): string[] {
  const problems: string[] = [];
  // Users install our published dependencies without our lockfile, so a range would let them
  // get a version we never tested.
  const runtimeDependencies = { ...pkg.dependencies, ...pkg.optionalDependencies };
  for (const [dependency, spec] of Object.entries(runtimeDependencies)) {
    if (!EXACT_VERSION.test(spec)) {
      problems.push(`dependency "${dependency}" must be an exact version, not "${spec}"`);
    }
  }
  // One minimum OpenClaw version, written in two places.
  if (pkg.peerDependencies?.openclaw !== pkg.openclaw?.compat?.pluginApi) {
    problems.push("peerDependencies.openclaw and openclaw.compat.pluginApi must be equal");
  }
  // OpenClaw installs without running scripts, but a plain `npm install` of the package would.
  for (const script of ["preinstall", "install", "postinstall"]) {
    if (pkg.scripts?.[script])
      problems.push(`the "${script}" script would run when users install it`);
  }
  return problems;
}

/** Only the build output of the plugin's own source files (the ones ESLint checks) may ship. */
function checkPublishedFiles(): string[] {
  const problems: string[] = [];
  if (JSON.stringify(pkg.files) !== JSON.stringify(["dist", "openclaw.plugin.json"])) {
    problems.push('"files" must be ["dist", "openclaw.plugin.json"]');
  }
  for (const file of readdirSync("dist", { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const path = relative("dist", join(file.parentPath, file.name)); // for example "index.js"
    const sourceName = /^(.+)\.js$/.exec(path)?.[1]; // "index"
    const isTestFile = sourceName !== undefined && /\.(test|spec)$/.test(sourceName);
    const hasSource = sourceName !== undefined && existsSync(join("src", `${sourceName}.ts`));
    if (!hasSource || isTestFile) {
      problems.push(`unexpected dist/${path} (delete dist and rebuild if it is stale)`);
    }
  }
  return problems;
}

/** Every path of a config schema, written like `configContracts.secretInputs` writes them. */
function configPaths(schema: JsonSchema | undefined, prefix = ""): string[] {
  if (!schema) return [];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    paths.push(prefix + key, ...configPaths(child, `${prefix}${key}.`));
  }
  // Values of records and items of arrays are written as `*`.
  const repeated = [...Object.values(schema.patternProperties ?? {}), schema.items];
  if (typeof schema.additionalProperties === "object") repeated.push(schema.additionalProperties);
  for (const child of repeated) paths.push(...configPaths(child, `${prefix}*.`));
  for (const branch of [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ]) {
    paths.push(...configPaths(branch, prefix));
  }
  return paths;
}

/** Config settings that look like credentials must be listed as secret inputs (see the guide). */
function checkCredentialKeys(): string[] {
  const secretPaths = new Set(manifest.configContracts?.secretInputs?.paths?.map((p) => p.path));
  const problems: string[] = [];
  for (const path of new Set(configPaths(manifest.configSchema))) {
    const key = path.split(".").at(-1) ?? "";
    if (CREDENTIAL_KEY.test(key) && !secretPaths.has(path)) {
      problems.push(
        `config "${path}" looks like a credential: list it in configContracts.secretInputs`,
      );
    }
  }
  return problems;
}

/**
 * Tool arguments come from a model, so the schema must limit them: every value has a type and a
 * size limit, and objects accept no extra properties. Returns what is missing, with its location.
 */
function schemaProblems(schema: JsonSchema | undefined, location: string): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const problems: string[] = [];
  const isFixedValue = schema.const !== undefined || schema.enum !== undefined;
  const hasBranches = Boolean(schema.anyOf || schema.oneOf || schema.allOf);

  if (schema.type === undefined && !isFixedValue && !hasBranches) {
    problems.push(`${location}: schema needs a type`);
  }
  const isNumber = schema.type === "number" || schema.type === "integer";
  if (isNumber && !isFixedValue && (schema.maximum ?? schema.exclusiveMaximum) === undefined) {
    problems.push(`${location}: number needs maximum`);
  }
  if (schema.patternProperties && schema.maxProperties === undefined) {
    problems.push(`${location}: map needs maxProperties`);
  }
  if (schema.type === "object" && (schema.additionalProperties ?? true) === true) {
    problems.push(`${location}: object needs additionalProperties: false`);
  }
  if (schema.type === "string" && schema.maxLength === undefined && !isFixedValue) {
    problems.push(`${location}: string needs maxLength`);
  }
  if (schema.type === "array" && schema.maxItems === undefined) {
    problems.push(`${location}: array needs maxItems`);
  }

  // Check everything nested inside as well.
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    problems.push(...schemaProblems(child, `${location}.${key}`));
  }
  for (const child of Object.values(schema.patternProperties ?? {})) {
    problems.push(...schemaProblems(child, `${location}[*]`));
  }
  const arrayItems = [schema.items, ...(schema.prefixItems ?? [])];
  for (const item of arrayItems) problems.push(...schemaProblems(item, `${location}[]`));
  if (typeof schema.additionalProperties === "object") {
    problems.push(...schemaProblems(schema.additionalProperties, `${location}[*]`));
  }
  for (const branch of [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ]) {
    problems.push(...schemaProblems(branch, location));
  }
  return problems;
}

/** Loads the built plugin and checks the parameter schema of each of its tools. */
async function checkToolSchemas(): Promise<string[]> {
  const problems: string[] = [];
  for (const entry of pkg.openclaw?.extensions ?? []) {
    const loaded = (await import(pathToFileURL(entry).href)) as { default?: unknown };
    for (const tool of getToolPluginMetadata(loaded.default)?.tools ?? []) {
      problems.push(...schemaProblems(tool.parameters, tool.name));
    }
  }
  return problems;
}

const problems = [
  ...checkNames(),
  ...checkLicense(),
  ...checkDependencies(),
  ...checkPublishedFiles(),
  ...checkCredentialKeys(),
  ...(await checkToolSchemas()),
];

if (problems.length > 0) {
  console.error(problems.map((problem) => `✖ ${problem}`).join("\n"));
  console.error("See docs/plugin-security.md.");
  process.exit(1);
}
console.log("Package checks OK.");
