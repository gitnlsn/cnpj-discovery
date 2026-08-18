import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Everything the app produces, and nothing it merely read.
 *
 * The Receita base lives in Parquet and is queried in place; a company only
 * appears here once it has been deliberately pulled into a project. That is the
 * whole point of the rewrite — the previous version stored 2.1M companies to
 * work with a few hundred.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** What is being sold, in the operator's words. */
  description: text("description").notNull().default(""),
  /** The ideal customer profile, verbatim. Never paraphrased on save. */
  icpText: text("icp_text").notNull().default(""),
  /** Compiled ProjectSpec. Written by the model, validated by parseProjectSpec. */
  spec: text("spec", { mode: "json" }),
  specModel: text("spec_model"),
  specCompiledAt: text("spec_compiled_at"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

/**
 * A CNAE the model proposed for a project, with the reach it actually has.
 *
 * `status` is the load-bearing column. The model invents CNAE codes — that is
 * not a maybe — so a suggestion is only shown once it has been checked against
 * the official dictionary. "unknown" (no such code) and "empty" (real code, no
 * companies) are different facts and must not collapse into one another.
 */
export const cnaePicks = sqliteTable(
  "cnae_picks",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    cnae: text("cnae").notNull(),
    descricao: text("descricao"),
    status: text("status", { enum: ["ok", "unknown", "empty"] }).notNull(),
    reachTotal: integer("reach_total").notNull().default(0),
    reachWithPhone: integer("reach_with_phone").notNull().default(0),
    reachRecent: integer("reach_recent").notNull().default(0),
    /** Why the model picked it — shown next to the number so both can be judged. */
    rationale: text("rationale"),
    suggestedBy: text("suggested_by", { enum: ["llm", "human"] }).notNull().default("llm"),
    chosen: integer("chosen", { mode: "boolean" }).notNull().default(false),
    checkedAt: text("checked_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.cnae] })]
);

/** A company pulled into a project. The only Receita data that gets persisted. */
export const companies = sqliteTable(
  "companies",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    cnpj: text("cnpj").notNull(),
    razaoSocial: text("razao_social"),
    nomeFantasia: text("nome_fantasia"),
    cnae: text("cnae").notNull(),
    cnaeDescricao: text("cnae_descricao"),
    uf: text("uf"),
    municipio: text("municipio"),
    bairro: text("bairro"),
    dataInicioAtividade: text("data_inicio_atividade"),
    porte: text("porte"),
    capitalSocial: real("capital_social"),
    naturezaJuridica: text("natureza_juridica"),
    mei: integer("mei", { mode: "boolean" }).notNull().default(false),
    simples: integer("simples", { mode: "boolean" }).notNull().default(false),
    email: text("email"),
    /** Which Receita snapshot this row came from, e.g. "2026-08". */
    sourcePeriod: text("source_period"),
    addedAt: text("added_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.cnpj] }),
    index("companies_cnae_idx").on(t.projectId, t.cnae),
  ]
);

/**
 * A revealed contact. Written only when the operator asks for it, per company.
 *
 * `source` matters: a number found on the company's own site is usually better
 * than the one filed with the Receita, which is frequently the accountant's.
 */
export const contacts = sqliteTable(
  "contacts",
  {
    cnpj: text("cnpj").notNull(),
    phoneE164: text("phone_e164").notNull(),
    isMobile: integer("is_mobile", { mode: "boolean" }).notNull().default(false),
    source: text("source", { enum: ["rf", "site"] }).notNull(),
    waMe: text("wa_me"),
    revealedAt: text("revealed_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.cnpj, t.phoneE164] })]
);

/**
 * Google Places results, kept apart from everything else on purpose.
 *
 * Google's terms allow storing the `place_id` indefinitely and nothing else —
 * not the name, not the phone, not the rating. Isolating it in its own table
 * makes that a property of the schema instead of a rule someone has to remember.
 */
export const placesLookups = sqliteTable("places_lookups", {
  cnpj: text("cnpj").primaryKey(),
  placeId: text("place_id"),
  websiteUrl: text("website_url"),
  found: integer("found", { mode: "boolean" }).notNull().default(false),
  checkedAt: text("checked_at").notNull().default(now),
});

/** What one crawl of a company's site found. */
export const crawls = sqliteTable(
  "crawls",
  {
    cnpj: text("cnpj").primaryKey(),
    websiteUrl: text("website_url"),
    finalUrl: text("final_url"),
    httpStatus: integer("http_status"),
    error: text("error"),
    /** How the URL was discovered, so a bad guess can be told from a dead site. */
    urlSource: text("url_source", { enum: ["email", "places", "manual"] }),
    signals: text("signals", { mode: "json" }),
    /** Capped at 8 KB by the writer — see crawl.ts. */
    textExcerpt: text("text_excerpt"),
    pagesFetched: integer("pages_fetched").notNull().default(0),
    checkedAt: text("checked_at").notNull().default(now),
  },
  (t) => [index("crawls_checked_idx").on(t.checkedAt)]
);

/**
 * One score per company per project.
 *
 * A failed model call writes the row with `error` set and every fit NULL. It
 * must never write a number, because a fabricated 5 is indistinguishable from a
 * real one and poisons the ranking silently.
 */
export const scores = sqliteTable(
  "scores",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    cnpj: text("cnpj").notNull(),
    fits: text("fits", { mode: "json" }),
    bestFit: integer("best_fit"),
    tier: text("tier", { enum: ["hot", "warm", "cold"] }),
    confidence: text("confidence", {
      enum: ["high", "medium", "low", "cannot_determine"],
    }),
    recommendation: text("recommendation"),
    /** The model rejected the company by line of business, not by score. */
    wrongType: integer("wrong_type", { mode: "boolean" }).notNull().default(false),
    hook: text("hook"),
    advice: text("advice"),
    evidence: text("evidence", { mode: "json" }),
    model: text("model"),
    promptSha: text("prompt_sha"),
    error: text("error"),
    scoredAt: text("scored_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.cnpj] }),
    index("scores_rank_idx").on(t.projectId, t.bestFit),
  ]
);

/**
 * Background work. One row per run, progress written as it goes.
 *
 * `jobs_one_running_idx` is a partial unique index: two fast clicks cannot start
 * two crawls. The guarantee belongs in the database, not in a React handler.
 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", {
      enum: ["compile", "discover", "crawl", "score", "places"],
    }).notNull(),
    projectId: text("project_id"),
    status: text("status", { enum: ["running", "done", "failed", "cancelled"] }).notNull(),
    progress: text("progress", { mode: "json" }),
    log: text("log").notNull().default(""),
    error: text("error"),
    startedAt: text("started_at").notNull().default(now),
    finishedAt: text("finished_at"),
  },
  (t) => [
    uniqueIndex("jobs_one_running_idx")
      .on(t.status)
      .where(sql`status = 'running'`),
    index("jobs_recent_idx").on(t.startedAt),
  ]
);

/** Daily counters for the paid Places quota and the LLM request cap. */
export const usage = sqliteTable(
  "usage",
  {
    day: text("day").notNull(),
    kind: text("kind").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.kind] })]
);
