import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false, // shared SQLite test db
    testTimeout: 30_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
