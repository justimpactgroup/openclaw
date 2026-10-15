// `nx release` calls this once for every plugin that gets a new version. Nx's standard version
// actions write the number into package.json; this adds the two other places a plugin keeps it.
import { join } from "node:path";
import { readJson, updateJson, type Tree } from "@nx/devkit";
import nxJs from "@nx/js/src/release/version-actions";

// Nx's module is CommonJS, so from here its exports sit one level down.
const { default: StandardVersionActions, afterAllProjectsVersioned } = nxJs;

// Also refreshes package-lock.json after all versions are bumped.
export { afterAllProjectsVersioned };

export default class PluginVersionActions extends StandardVersionActions {
  override async updateProjectVersion(tree: Tree, newVersion: string): Promise<string[]> {
    const logs = await super.updateProjectVersion(tree, newVersion); // package.json
    const pluginDir = this.projectGraphNode.data.root;
    const manifestPath = join(pluginDir, "openclaw.plugin.json");
    if (!tree.exists(manifestPath)) return logs; // not a plugin

    // 1. `openclaw plugins validate` fails if the manifest version differs from package.json.
    updateJson<Record<string, unknown>>(tree, manifestPath, (manifest) => ({
      ...manifest,
      version: newVersion,
    }));

    // 2. ClawHub requires `openclaw.build.openclawVersion`: the OpenClaw version used to build.
    const rootPackage = readJson<{ devDependencies: Record<string, string> }>(tree, "package.json");
    updateJson<{ openclaw?: object }>(tree, join(pluginDir, "package.json"), (pkg) => ({
      ...pkg,
      openclaw: {
        ...pkg.openclaw,
        build: { openclawVersion: rootPackage.devDependencies.openclaw },
      },
    }));

    return [...logs, `Updated ${manifestPath} and openclaw.build to ${newVersion}`];
  }
}
