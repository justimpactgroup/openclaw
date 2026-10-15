// Publishes the plugin in the current directory to ClawHub. Run by release.yml after the npm
// publish, once for every plugin.
//
// It only publishes when both are true:
// - `nx release` tagged this exact version on the current commit, so it belongs to this release;
// - ClawHub doesn't have this version yet, so running a release again is safe.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { OWNER, ROOT, readJson } from "./lib.ts";

const { name, version } = readJson<{ name: string; version: string }>("package.json");
const releaseTag = `${name}@${version}`; // the tag name `nx release` creates
const clawhub = join(ROOT, "node_modules/.bin/clawhub");

/** Runs a command and returns what it printed. Throws if it fails. */
function output(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function isTaggedOnCurrentCommit(): boolean {
  return output("git", ["tag", "--points-at", "HEAD", "--list", releaseTag]).trim() !== "";
}

function isOnClawhub(): boolean {
  try {
    const result = output(clawhub, ["package", "inspect", name, "--version", version, "--json"]);
    const found = JSON.parse(result) as { version?: { version?: string } | null };
    return found.version?.version === version;
  } catch {
    return false; // ClawHub doesn't know the package or version
  }
}

function publish(): void {
  execFileSync(
    clawhub,
    [
      ...["--workdir", ".", "package", "publish", ".", "--family", "code-plugin"],
      // The source ref tells ClawHub which commit this is; several plugins can share one commit.
      ...["--owner", OWNER, "--source-ref", releaseTag],
      // ClawHub scans an upload before it goes public; wait, so a blocked version fails the job.
      "--wait",
    ],
    { stdio: "inherit" },
  );
}

if (!isTaggedOnCurrentCommit()) {
  console.log(`skip ${releaseTag}: not released at this commit`);
} else if (isOnClawhub()) {
  console.log(`skip ${releaseTag}: already on ClawHub`);
} else {
  publish();
}
