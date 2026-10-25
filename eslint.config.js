import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "vendor/**",
      ".exos-state/**",
      "docs/images/**",
      "dashboard/src/api/schema.d.ts",
      "fixtures/review-target/**",
      "fixtures/build-templates/**",
      "evals/datasets/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
