import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Next reads `.env` from its OWN project root — here, `apps/web`.
 *
 * In a workspace the keys belong at the repository root, next to the README
 * that documents them, so without this the app starts up believing no
 * OPEN_ROUTER_API_KEY was ever configured. `loadEnvFile` deliberately does not
 * override variables already present, so a real shell env still wins.
 */
const rootEnv = join(import.meta.dirname, "..", "..", ".env");
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

const config: NextConfig = {
  // The workspace packages ship TypeScript source with no build step.
  transpilePackages: ["@cnpj/core", "@cnpj/data", "@cnpj/db", "@cnpj/jobs", "@cnpj/serp"],
  // Native addons: they must stay external or the bundler will try to inline a
  // .node binary.
  // puppeteer-core spawns a browser and resolves its own paths at runtime;
  // bundling it breaks both.
  serverExternalPackages: [
    "better-sqlite3",
    "@duckdb/node-api",
    "@duckdb/node-bindings",
    "puppeteer-core",
  ],
};

export default config;
