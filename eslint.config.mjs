// @ts-check
import js from "@eslint/js";
import ts from "typescript-eslint";

/**
 * Deliberately small. The rules here are the ones that catch real defects in
 * this codebase — an unawaited promise against SQLite, an `any` smuggling an
 * LLM response past the validators — not a style opinion that Prettier already
 * settles.
 */
export default ts.config(
  {
    ignores: ["**/node_modules/**", "**/.next/**", "data/**", "gmaps-whatsapp-extractor/**"],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: {
      globals: { console: "readonly", process: "readonly", fetch: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Model output and Receita rows arrive as unknown and must go through a
      // validator; a non-null assertion on them defeats the whole point.
      "@typescript-eslint/no-non-null-asserted-optional-chain": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // Scripts, CLI entry points and tests print, assert, and index into
    // fixtures whose shape is known at the call site.
    files: ["scripts/**", "**/test/**", "packages/db/src/migrate.ts"],
    rules: { "no-console": "off", "@typescript-eslint/no-non-null-assertion": "off" },
  }
);
