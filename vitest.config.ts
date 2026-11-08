import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/dashboard/projects/*/src/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    passWithNoTests: true,
  },
});
