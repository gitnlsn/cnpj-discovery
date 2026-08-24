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
    /**
     * The same reach counted through SECONDARY activities, and disjoint from the
     * three above — a company matching both ways is counted as primary only.
     *
     * Its own columns rather than added into `reach_total`, because a company
     * whose whole business is this CNAE and one that lists it third among nine
     * are different prospects, and `reach_total` is already stored in every
     * existing row. Widening it would silently restate what those rows claim.
     *
     * Zero means "not asked", not "nobody holds it" — a pick saved before this
     * existed, or saved with the toggle off, is indistinguishable from a genuine
     * zero here, so the UI shows a dash until a run actually measured it.
     */
    reachSecundaria: integer("reach_secundaria").notNull().default(0),
    reachSecundariaWithPhone: integer("reach_secundaria_with_phone").notNull().default(0),
    reachSecundariaRecent: integer("reach_secundaria_recent").notNull().default(0),
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
    /**
     * Whether this company was reached by its primary or its secondary CNAE.
     *
     * Stored because it is otherwise lost at exactly the moment it matters. The
     * row keeps the company's own primary CNAE, so a company pulled in because
     * "8599" was its seventh registered activity looks, from here on, like a
     * company in whatever it registered first — and the scoring prompt sees only
     * that. This is the difference between "modelo reprovou por ramo" being a
     * surprise and being expected.
     *
     * Null on every row added before the column existed. Null is not
     * "principal": it means nobody recorded which way it matched.
     */
    cnaeMatch: text("cnae_match", { enum: ["principal", "secundaria"] }),
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
    urlSource: text("url_source", {
      enum: ["email", "places", "manual", "search", "discovery"],
    }),
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
 * `jobs_one_running_idx` is a partial unique index over `(status, lane)`: two
 * fast clicks cannot start two crawls. The guarantee belongs in the database,
 * not in a React handler.
 *
 * It is per *lane* rather than global because the original one-job rule blocked
 * something legitimate: sweeping the open internet for companies that are not in
 * the project while also working the companies that are. Those two touch
 * different tables and different Chrome profiles, so they are allowed to
 * overlap. Within a lane the old guarantee is untouched. See `JobLane`.
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
        "openweb",
      ],
    }).notNull(),
    /**
     * Which lock this job takes. Derived from `kind` by `laneOf`, stored rather
     * than computed so the partial unique index can be a plain column index.
     */
    lane: text("lane", { enum: ["receita", "openweb"] })
      .notNull()
      .default("receita"),
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
      .on(t.status, t.lane)
      .where(sql`status = 'running'`),
    index("jobs_recent_idx").on(t.startedAt),
  ]
);

/**
 * That we ran one discovery query against the open internet.
 *
 * Exists for the same reason `search_lookups` does: without it, "this query found
 * nothing" and "this query never ran" are the same absence. And the invariant is
 * the same one — **a refused run writes NO row here**, because a row would assert
 * we looked when we were turned away.
 */
export const webQueries = sqliteTable(
  "web_queries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    jobId: integer("job_id"),
    /** The exact text sent, so a disappointing sweep can be reproduced by hand. */
    query: text("query").notNull(),
    /** Which engine answered. "places" today; the column outlives the choice. */
    provider: text("provider").notNull(),
    /** Businesses the engine returned, before any filtering. */
    considered: integer("considered").notNull().default(0),
    /** Businesses that survived and became new rows. */
    kept: integer("kept").notNull().default(0),
    ranAt: text("ran_at").notNull().default(now),
  },
  (t) => [index("web_queries_project_idx").on(t.projectId, t.ranAt)]
);

/**
 * A business found on the open internet, keyed by its website rather than a CNPJ.
 *
 * The CNPJ is what we are trying to discover here, so it cannot be the key. The
 * registrable domain is: one website is one prospect, and `apexOf` is what makes
 * `blog.x.com.br` and `x.com.br` stop being two leads. Two Google places that
 * share a website — branches of one chain — collapse into one row, which is the
 * right answer for something being sold to once.
 *
 * **There is no name column, and that is deliberate.** Google's terms let us keep
 * the `place_id` and nothing else, so the name and address the API returns are
 * used during the run to find the company in the Receita base and then discarded.
 * What the screen shows instead comes from `signals.title` — our own crawl of the
 * site, which is our observation to keep. The same reasoning that gave
 * `places_lookups` its shape, applied to a table that could have quietly broken it.
 *
 * `verdict` is NOT NULL with no 'unknown' member: there is no way to persist a
 * lead nobody classified. And "unmatched" means WE COULD NOT MATCH IT — never
 * that the business has no CNPJ, is informal, or is unregistered.
 */
export const webLeads = sqliteTable(
  "web_leads",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The registrable domain. See `apexOf`. */
    apex: text("apex").notNull(),
    /** The URL as found, before any crawl redirect. */
    websiteUrl: text("website_url").notNull(),
    /** Google's durable handle. The one Google-derived value we may keep. */
    placeId: text("place_id"),
    /** Which query first surfaced it, so a lead can be traced to its origin. */
    queryId: integer("query_id"),
    verdict: text("verdict", { enum: ["in_reach", "out_of_reach", "unmatched"] }).notNull(),
    /** Which dimension put an in-base company out of reach. */
    outOfReachBy: text("out_of_reach_by", { enum: ["cnae", "uf", "other"] }),
    matchedCnpj: text("matched_cnpj"),
    /** How the CNPJ was established, so a bad match can be audited. */
    matchVia: text("match_via", {
      enum: ["address", "mirror", "email_domain", "crawl_host", "manual"],
    }),
    /** The matched company's primary CNAE — the fact that makes "out of reach" checkable. */
    matchedCnae: text("matched_cnae"),
    /** What our crawl of the site found. Same columns as `crawls`, same meanings. */
    finalUrl: text("final_url"),
    httpStatus: integer("http_status"),
    crawlError: text("crawl_error"),
    signals: text("signals", { mode: "json" }),
    textExcerpt: text("text_excerpt"),
    pagesFetched: integer("pages_fetched").notNull().default(0),
    /**
     * Contacts our crawl read off the site, across every page it fetched.
     *
     * Their own columns rather than left inside `signals`, because for a lead with
     * no CNPJ these ARE the deliverable: there is no `contacts` row to fall back
     * on — that table is keyed by CNPJ — and no Receita phone. A business found
     * this way is reachable only through what its own site says.
     *
     * An empty array means we read pages and found none. `crawled_at` carries the
     * difference from "nobody looked", as it does for every other column here.
     */
    emails: text("emails", { mode: "json" }).$type<string[]>(),
    phones: text("phones", { mode: "json" }).$type<string[]>(),
    /** Null means nobody crawled it. Set means we looked, error or not. */
    crawledAt: text("crawled_at"),
    /**
     * Your decision about this lead, and how far you got with it.
     *
     * Columns here rather than a row in `leads`, because that table is keyed by
     * CNPJ and the leads this tab exists for do not have one. Same five states, so
     * the two tabs mean the same thing by "contatado" — a second vocabulary would
     * make the pipeline unreadable across them.
     *
     * Null means undecided. That is different from every state below, including
     * "flagged": marking something is an act, and absence is not one.
     */
    status: text("status", {
      enum: ["flagged", "contacted", "replied", "won", "lost"],
    }),
    /** What happened after you reached out. Yours, never touched by a rerun. */
    notes: text("notes"),
    /** When it was turned into a real `companies` row. */
    promotedAt: text("promoted_at"),
    discardedAt: text("discarded_at"),
    foundAt: text("found_at").notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.apex] }),
    index("web_leads_verdict_idx").on(t.projectId, t.verdict),
    index("web_leads_status_idx").on(t.projectId, t.status),
  ]
);

/**
 * The score of a lead that has no CNPJ.
 *
 * Its own table for the reason `scores` is separate from `companies`: the model
 * overwrites this row on every run, and a human decision must never live somewhere
 * a rescore can erase. Keyed by apex, like the lead it belongs to.
 *
 * A failed call writes the row with `error` set and every fit NULL — never a
 * number, for exactly the reason `scores` gives.
 */
export const webLeadScores = sqliteTable(
  "web_lead_scores",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    apex: text("apex").notNull(),
    fits: text("fits", { mode: "json" }),
    bestFit: integer("best_fit"),
    tier: text("tier", { enum: ["hot", "warm", "cold"] }),
    confidence: text("confidence", {
      enum: ["high", "medium", "low", "cannot_determine"],
    }),
    recommendation: text("recommendation"),
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
    primaryKey({ columns: [t.projectId, t.apex] }),
    index("web_lead_scores_rank_idx").on(t.projectId, t.bestFit),
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
