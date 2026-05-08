import { defineConfig } from "vitest/config";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", ".."); // apps/cli → repo root

/** Minimal .env file parser (no dotenv dependency); mirrors packages/sdk/vitest.config.ts. */
function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf-8");
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

// `.env.local` is gitignored and holds real values. Loaded from repo root
// so the CLI tests share the same fixture as packages/sdk integration tests.
const localEnv = loadEnvFile(join(repoRoot, ".env.local"));

export default defineConfig({
  test: {
    globals: true,
    env: localEnv,
  },
});
