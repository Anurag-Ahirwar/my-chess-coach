import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Layer boundaries (docs/TECHNICAL_ARCHITECTURE.md §3): core is pure, infra
 * does not reach into app/ui, and app does not reach into ui.
 */
const layerImports = (forbiddenLayers, extraPatterns = []) => ({
  patterns: [
    ...forbiddenLayers.flatMap((layer) => [
      { group: [`@/${layer}`, `@/${layer}/*`], message: `This layer must not import from ${layer}/.` },
      { group: [`**/${layer}`, `**/${layer}/*`], message: `This layer must not import from ${layer}/.` },
    ]),
    ...extraPatterns,
  ],
});

const browserGlobalsBannedInCore = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "fetch",
  "Worker",
  "XMLHttpRequest",
].map((name) => ({ name, message: "core/ is pure: pass I/O in from infra/ or app/." }));

export default tseslint.config(
  { ignores: ["dist", "coverage", "playwright-report", "test-results", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        layerImports(
          ["infra", "app", "ui"],
          [
            { group: ["react", "react-*", "react/*", "zustand", "zustand/*"], message: "core/ is pure: no React or state libraries." },
          ],
        ),
      ],
      "no-restricted-globals": ["error", ...browserGlobalsBannedInCore],
    },
  },
  {
    files: ["src/infra/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", layerImports(["app", "ui"])] },
  },
  {
    files: ["src/app/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", layerImports(["ui"])] },
  },
  {
    files: ["tests/**/*.{ts,tsx}", "scripts/**/*.{ts,mjs}", "*.config.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
