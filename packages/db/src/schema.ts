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
  /**
   * The first half of a compile that has not finished — see `TargetingDraft`.
   *
   * Compiling is two model calls, and the second one is the one that answers
   * 503. Keeping the first call's output here means a retry pays for one call
   * instead of two. Cleared the moment a spec is written, so a non-null value
   * always means "there is a compile to finish".
   */
  specDraft: text("spec_draft", { mode: "json" }),
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
    suggestedBy: text("suggested_by", { enum: ["llm", "human"] })
      .notNull()
      .default("llm"),
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
    /**
     * The street, as four columns rather than one formatted line.
     *
     * Stored raw for the same reason the phone is: formatting is a view, and a
     * view that has been flattened into storage cannot be corrected without a
     * re-sync. `formatAddress` composes them at read time.
     */
    tipoLogradouro: text("tipo_logradouro"),
    logradouro: text("logradouro"),
    numero: text("numero"),
    complemento: text("complemento"),
    cep: text("cep"),
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

/**
 * That we searched the web for a company, and what came back.
 *
 * Two tables rather than one, for the same reason `places_lookups` exists: a
 * company with no rows in `search_hits` is ambiguous — nobody searched, or
 * somebody searched and found nothing. This table is the record of having
 * looked, so those stay different facts. A blocked run must leave NO row here,
 * because a row would assert we looked when we were refused.
 */
export const searchLookups = sqliteTable("search_lookups", {
  cnpj: text("cnpj").primaryKey(),
  /** Which engine answered — "duckduckgo" or "google". */
  provider: text("provider"),
  /** The exact query, so a bad result can be reproduced by hand. */
  query: text("query"),
  /** Results the engine returned, before verification. */
  considered: integer("considered").notNull().default(0),
  /** Results that survived the name and host gates. */
  verified: integer("verified").notNull().default(0),
  checkedAt: text("checked_at").notNull().default(now),
});

/**
 * One verified search result.
 *
 * `description` is not decoration. For a `social` hit the crawler never fetches
 * the page — link hubs are short-circuited by design — so this snippet is the
 * only thing we will ever know about that business, and it is what reaches the
 * model as evidence.
 */
export const searchHits = sqliteTable(
  "search_hits",
  {
    cnpj: text("cnpj").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    description: text("description"),
    /** classifyHit's answer: "social" | "site" | "linkedin". Others are not stored. */
    kind: text("kind"),
    /**
     * For a LinkedIn profile: what the person says they do.
     *
     * Stored because it is a fact we derived, not a verdict we reached — whether
     * it counts as evidence is decided at read time, so the rule can improve
     * without a backfill. See `domain/linkedin.ts`.
     */
    headline: text("headline"),
    /** Which field carried the name, so a run can be audited afterwards. */
    matchedOn: text("matched_on"),
    checkedAt: text("checked_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.cnpj, t.url] })]
);

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
    urlSource: text("url_source", { enum: ["email", "places", "manual", "search"] }),
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
 * A company you decided is worth pursuing, and how far you have got with it.
 *
 * Separate from `companies` deliberately: being in the project means "I pulled
 * this row in to look at it"; being here means "I decided". Collapsing the two
 * loses the decision, which is the only part a human actually made.
 *
 * `contacted` records that you reached out. Nothing in this app sends anything.
 */
export const leads = sqliteTable(
  "leads",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    cnpj: text("cnpj").notNull(),
    status: text("status", {
      enum: ["flagged", "contacted", "replied", "won", "lost"],
    })
      .notNull()
      .default("flagged"),
    notes: text("notes"),
    flaggedAt: text("flagged_at").notNull().default(now),
    contactedAt: text("contacted_at"),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.cnpj] }),
    index("leads_status_idx").on(t.projectId, t.status),
  ]
);

/**
 * What YOU saw when you looked at this company, in your own words.
 *
 * Its own table for three reasons. `companies` is otherwise a pure Receita
 * snapshot and human prose does not belong in it. `scores` is overwritten by the
 * model on every run, so a rescore there could erase what a person wrote. And
 * `leads.notes` is a different thing entirely: that is a log of what happened
 * after you reached out, written once the company is already a lead. This is
 * written *while* deciding, and unlike `notes` it is read back into the scoring
 * prompt as evidence.
 *
 * Absent row means no impression. An empty one is never stored, because the
 * difference decides whether the prompt gains its impression rules at all.
 */
export const impressions = sqliteTable(
  "impressions",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    cnpj: text("cnpj").notNull(),
    body: text("body").notNull(),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.cnpj] })]
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
      enum: [
        "compile",
        "discover",
        "crawl",
        "score",
        "places",
        "pipeline",
        "continuous",
        "search",
      ],
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

/**
 * One LinkedIn page we fetched, and what it said.
 *
 * Kept out of `search_hits` on purpose. That table records what a *search engine*
 * showed us, and its rows are cheap, plentiful and unattributable. These rows are
 * the product of a signed-in fetch against a site whose robots.txt forbids it —
 * they cost pacing, they carry account risk, and they are the thing to look at
 * when deciding whether the feature was worth turning on. Mixing the two would
 * make that question unanswerable.
 *
 * `error` is what makes a refusal distinguishable from an absence. A row with
 * `error` set means we tried and were stopped; NO row means nobody looked. The
 * one thing that must never happen is a clean row with every field null, which
 * would read as "LinkedIn has nothing on this company" — see the long note in
 * `findPresence` about exactly this failure mode on the search path.
 */
export const linkedinPages = sqliteTable(
  "linkedin_pages",
  {
    cnpj: text("cnpj").notNull(),
    /** The canonical URL fetched — `/company/<slug>/about/` or `/in/<slug>`. */
    url: text("url").notNull(),
    kind: text("kind", { enum: ["entity", "profile"] }).notNull(),
    slug: text("slug"),
    name: text("name"),
    description: text("description"),
    /** LinkedIn's own industry label, not a CNAE. */
    industry: text("industry"),
    /**
     * The self-declared band. Two columns rather than a string so it can be
     * filtered on; `employees_max` is null for an open-ended top band ("10.001+").
     */
    employeesMin: integer("employees_min"),
    employeesMax: integer("employees_max"),
    /** Members who list this company as employer — a count, not a claim. */
    employeesOnLinkedin: integer("employees_on_linkedin"),
    headquarters: text("headquarters"),
    website: text("website"),
    founded: text("founded"),
    followers: integer("followers"),
    /** Profiles only: what the person says they do. */
    headline: text("headline"),
    location: text("location"),
    /** Why this fetch produced nothing. Null on a page we actually read. */
    error: text("error"),
    checkedAt: text("checked_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.cnpj, t.url] }),
    index("linkedin_pages_checked_idx").on(t.checkedAt),
  ]
);
