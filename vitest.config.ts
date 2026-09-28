import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts", "apps/desktop/src/main/**/*.test.ts", "apps/desktop/src/workers/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["packages/ui/src/**/*.test.tsx", "apps/desktop/src/renderer/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
