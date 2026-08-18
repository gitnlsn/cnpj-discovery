import type { NextConfig } from "next";

const config: NextConfig = {
  // The workspace packages ship TypeScript source with no build step.
  transpilePackages: ["@cnpj/core", "@cnpj/data", "@cnpj/db", "@cnpj/jobs"],
  // Native addons: they must stay external or the bundler will try to inline a
  // .node binary.
  serverExternalPackages: ["better-sqlite3", "@duckdb/node-api", "@duckdb/node-bindings"],
};

export default config;
