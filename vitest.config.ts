import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Repo root — anchors include globs so tests run from any cwd. */
const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rootDir,
  resolve: {
    // Exact-match alias (regex, so subpaths are not mangled) mirroring the
    // tsconfig.base.json paths entry.
    alias: [
      {
        find: /^@larpmaxer\/core$/,
        replacement: fileURLToPath(
          new URL("./packages/core/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "jsdom",
    include: ["packages/*/test/**/*.test.{ts,tsx}"],
  },
});
