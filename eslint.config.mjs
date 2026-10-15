import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const guide = "See docs/plugin-security.md.";
const ssrf = `Use fetchWithSsrFGuard from openclaw/plugin-sdk/ssrf-runtime. ${guide}`;
const banned = `Not allowed in plugin code. ${guide}`;

export default defineConfig(
  globalIgnores(["**/dist/", "tools/templates/"]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true } },
    rules: { "@typescript-eslint/no-deprecated": "error" },
  },
  {
    files: ["plugins/*/src/**/*.{ts,mts,cts}"],
    ignores: ["**/*.spec.{ts,mts,cts}"],
    rules: {
      "no-eval": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { regex: "^(node:)?(http|https|http2|net|tls|dgram|quic)$", message: ssrf },
            {
              regex:
                "^(node:)?(child_process|cluster|ffi|fs|fs/promises|inspector|module|process|vm|worker_threads)$",
              message: banned,
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: ssrf },
        { name: "WebSocket", message: banned },
      ],
      "no-restricted-properties": [
        "error",
        { object: "process", property: "env", message: `Read credentials from config. ${guide}` },
        { object: "process", property: "dlopen", message: banned },
        { property: "getBuiltinModule", message: banned },
        { object: "globalThis", property: "process", message: banned },
        { object: "globalThis", property: "fetch", message: ssrf },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression:not([source.value=/^(\\.\\.?\\/|openclaw\\/plugin-sdk\\/)/])",
          message: `import() only relative paths or openclaw/plugin-sdk/*. ${guide}`,
        },
      ],
    },
  },
);
