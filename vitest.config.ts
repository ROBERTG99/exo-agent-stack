import { defineConfig } from "vitest/config";

// `make check-fast` runs the "unit" project; `make test` adds integration and contract.
// Dashboard component tests join "unit" (with a DOM environment) in T-34.
export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: [
            "tests/unit/**/*.test.ts",
            "tests/harness/**/*.test.ts",
            "packages/*/test/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "contract",
          environment: "node",
          include: ["tests/contract/**/*.test.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
    },
  },
});
