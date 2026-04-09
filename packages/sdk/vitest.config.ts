import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/storage/**"],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
    },
  },
});
