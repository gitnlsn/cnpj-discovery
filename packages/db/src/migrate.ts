import Database from "better-sqlite3";
import { dbPath } from "./index";

/**
 * The schema, applied idempotently.
 *
 * Hand-written rather than generated: there is one file, it is small, and a
 * generated migration folder for a local single-user database is more machinery
 * than the problem deserves. `IF NOT EXISTS` throughout means running this twice
 * is a no-op.
 */
const DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  icp_text          TEXT NOT NULL DEFAULT '',
  spec              TEXT,
  spec_model        TEXT,
  spec_compiled_at  TEXT,
  spec_draft        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cnae_picks (
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cnae              TEXT NOT NULL,
  descricao         TEXT,
  status            TEXT NOT NULL CHECK (status IN ('ok','unknown','empty')),
  reach_total       INTEGER NOT NULL DEFAULT 0,
  reach_with_phone  INTEGER NOT NULL DEFAULT 0,
  reach_recent      INTEGER NOT NULL DEFAULT 0,
  reach_secundaria             INTEGER NOT NULL DEFAULT 0,
  reach_secundaria_with_phone  INTEGER NOT NULL DEFAULT 0,
  reach_secundaria_recent      INTEGER NOT NULL DEFAULT 0,
  rationale         TEXT,
  suggested_by      TEXT NOT NULL DEFAULT 'llm' CHECK (suggested_by IN ('llm','human')),
  chosen            INTEGER NOT NULL DEFAULT 0,
  checked_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, cnae)
);

CREATE TABLE IF NOT EXISTS companies (
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cnpj                  TEXT NOT NULL,
  razao_social          TEXT,
  nome_fantasia         TEXT,
  cnae                  TEXT NOT NULL,
  cnae_descricao        TEXT,
  cnae_match            TEXT CHECK (cnae_match IN ('principal','secundaria')),
  uf                    TEXT,
  municipio             TEXT,
  bairro                TEXT,
  tipo_logradouro       TEXT,
  logradouro            TEXT,
  numero                TEXT,
  complemento           TEXT,
  cep                   TEXT,
  data_inicio_atividade TEXT,
  porte                 TEXT,
  capital_social        REAL,
  natureza_juridica     TEXT,
  mei                   INTEGER NOT NULL DEFAULT 0,
  simples               INTEGER NOT NULL DEFAULT 0,
  email                 TEXT,
  source_period         TEXT,
  added_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, cnpj)
);
CREATE INDEX IF NOT EXISTS companies_cnae_idx ON companies (project_id, cnae);

CREATE TABLE IF NOT EXISTS contacts (
  cnpj        TEXT NOT NULL,
  phone_e164  TEXT NOT NULL,
  is_mobile   INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL CHECK (source IN ('rf','site')),
  wa_me       TEXT,
  revealed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (cnpj, phone_e164)
);

-- Google-derived data only. Their terms permit storing the place_id and nothing
-- else, so nothing else has a column here to be stored in.
CREATE TABLE IF NOT EXISTS places_lookups (
  cnpj        TEXT PRIMARY KEY,
  place_id    TEXT,
  website_url TEXT,
  found       INTEGER NOT NULL DEFAULT 0,
  checked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS search_lookups (
  cnpj       TEXT PRIMARY KEY,
  provider   TEXT,
  query      TEXT,
  considered INTEGER NOT NULL DEFAULT 0,
  verified   INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS search_hits (
  cnpj        TEXT NOT NULL,
  url         TEXT NOT NULL,
  title       TEXT,
  description TEXT,
  kind        TEXT,
  headline    TEXT,
  matched_on  TEXT,
  checked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (cnpj, url)
);

CREATE TABLE IF NOT EXISTS crawls (
  cnpj          TEXT PRIMARY KEY,
  website_url   TEXT,
  final_url     TEXT,
  http_status   INTEGER,
  error         TEXT,
  url_source    TEXT CHECK (url_source IN ('email','places','manual','search','discovery')),
  signals       TEXT,
  text_excerpt  TEXT,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  checked_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS crawls_checked_idx ON crawls (checked_at);

CREATE TABLE IF NOT EXISTS scores (
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cnpj           TEXT NOT NULL,
  fits           TEXT,
  best_fit       INTEGER,
  tier           TEXT CHECK (tier IN ('hot','warm','cold')),
  confidence     TEXT CHECK (confidence IN ('high','medium','low','cannot_determine')),
  recommendation TEXT,
  wrong_type     INTEGER NOT NULL DEFAULT 0,
  hook           TEXT,
  advice         TEXT,
  evidence       TEXT,
  model          TEXT,
  prompt_sha     TEXT,
  error          TEXT,
  scored_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, cnpj)
);
CREATE INDEX IF NOT EXISTS scores_rank_idx ON scores (project_id, best_fit);

-- A company you decided is worth pursuing, and how far you have got with it.
--
-- Separate from "companies" on purpose: being in the project means "I pulled
-- this row in to look at it", while being here means "I decided". Those are
-- different claims and collapsing them loses the decision.
--
-- This records what you did. It does not contact anyone.
CREATE TABLE IF NOT EXISTS leads (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cnpj         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'flagged'
               CHECK (status IN ('flagged','contacted','replied','won','lost')),
  notes        TEXT,
  flagged_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  contacted_at TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, cnpj)
);
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads (project_id, status);

-- What you saw when you looked at a company, in your own words.
--
-- Not a column on "companies" (that table is a pure Receita snapshot), not on
-- "scores" (the model overwrites that row on every run and would erase it), and
-- not "leads.notes" (that is a log of what happened after you reached out).
-- Unlike notes, this is read back into the scoring prompt as evidence.
CREATE TABLE IF NOT EXISTS impressions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cnpj       TEXT NOT NULL,
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, cnpj)
);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('compile','discover','crawl','score','places','pipeline','continuous','search','openweb')),
  lane        TEXT NOT NULL DEFAULT 'receita' CHECK (lane IN ('receita','openweb')),
  project_id  TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running','done','failed','cancelled')),
  progress    TEXT,
  log         TEXT NOT NULL DEFAULT '',
  error       TEXT,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
-- One job at a time PER LANE, enforced by the database. Two fast clicks cannot
-- race past a partial unique index the way they can race past a JavaScript
-- guard. Per lane because a sweep of the open internet and the work on a
-- project's companies touch different tables and different Chrome profiles, so
-- blocking one on the other bought nothing. Inside a lane the rule is unchanged.
--
-- The lane column must stay NOT NULL: SQLite treats NULLs as distinct in a
-- unique index, so a null lane would silently allow unlimited concurrent jobs.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_running_idx ON jobs (status, lane) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_recent_idx ON jobs (started_at);

-- Que a gente RODOU esta consulta na internet aberta.
--
-- Mesmo motivo de search_lookups: sem esta tabela, "esta consulta não achou
-- nada" e "esta consulta nunca rodou" são a mesma ausência. E a mesma
-- invariante: uma rodada RECUSADA não escreve linha aqui, porque a linha
-- afirmaria que olhamos quando fomos recusados.
CREATE TABLE IF NOT EXISTS web_queries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id     INTEGER,
  query      TEXT NOT NULL,
  provider   TEXT NOT NULL,
  considered INTEGER NOT NULL DEFAULT 0,
  kept       INTEGER NOT NULL DEFAULT 0,
  ran_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS web_queries_project_idx ON web_queries (project_id, ran_at);

-- Um negócio achado na internet aberta, com chave no site e não num CNPJ — o
-- CNPJ é justamente o que estamos tentando descobrir.
--
-- NÃO existe coluna de nome, e isso é deliberado: os termos do Google permitem
-- guardar o place_id e nada mais, então nome e endereço são usados durante a
-- rodada para achar a empresa na base da Receita e descartados. O que a tela
-- mostra vem de signals.title — o nosso próprio crawl do site.
--
-- "unmatched" significa NÃO ACHAMOS o CNPJ: nunca que a empresa não tem um.
-- Os CHECKs abaixo são essa regra no banco, para veredito e CNPJ não poderem
-- discordar.
CREATE TABLE IF NOT EXISTS web_leads (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  apex            TEXT NOT NULL,
  website_url     TEXT NOT NULL,
  place_id        TEXT,
  query_id        INTEGER,
  verdict         TEXT NOT NULL CHECK (verdict IN ('in_reach','out_of_reach','unmatched')),
  out_of_reach_by TEXT CHECK (out_of_reach_by IN ('cnae','uf','other')),
  matched_cnpj    TEXT,
  match_via       TEXT CHECK (match_via IN ('address','mirror','email_domain','crawl_host','manual')),
  matched_cnae    TEXT,
  final_url       TEXT,
  http_status     INTEGER,
  crawl_error     TEXT,
  signals         TEXT,
  text_excerpt    TEXT,
  pages_fetched   INTEGER NOT NULL DEFAULT 0,
  emails          TEXT,
  phones          TEXT,
  status          TEXT CHECK (status IN ('flagged','contacted','replied','won','lost')),
  notes           TEXT,
  crawled_at      TEXT,
  promoted_at     TEXT,
  discarded_at    TEXT,
  found_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, apex),
  CHECK ((verdict = 'unmatched') = (matched_cnpj IS NULL)),
  CHECK ((matched_cnpj IS NULL) = (match_via IS NULL))
);
CREATE INDEX IF NOT EXISTS web_leads_verdict_idx ON web_leads (project_id, verdict);
CREATE INDEX IF NOT EXISTS web_leads_status_idx ON web_leads (project_id, status);

-- A nota de um lead que não tem CNPJ. Tabela própria pelo mesmo motivo que
-- scores é separada de companies: o modelo reescreve esta linha em cada rodada.
CREATE TABLE IF NOT EXISTS web_lead_scores (
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  apex           TEXT NOT NULL,
  fits           TEXT,
  best_fit       INTEGER,
  tier           TEXT CHECK (tier IN ('hot','warm','cold')),
  confidence     TEXT CHECK (confidence IN ('high','medium','low','cannot_determine')),
  recommendation TEXT,
  wrong_type     INTEGER NOT NULL DEFAULT 0,
  hook           TEXT,
  advice         TEXT,
  evidence       TEXT,
  model          TEXT,
  prompt_sha     TEXT,
  error          TEXT,
  scored_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, apex)
);
CREATE INDEX IF NOT EXISTS web_lead_scores_rank_idx ON web_lead_scores (project_id, best_fit);

CREATE TABLE IF NOT EXISTS usage (
  day   TEXT NOT NULL,
  kind  TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
CREATE TABLE IF NOT EXISTS linkedin_pages (
  cnpj                   TEXT NOT NULL,
  url                    TEXT NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('entity','profile')),
  slug                   TEXT,
  name                   TEXT,
  description            TEXT,
  industry               TEXT,
  employees_min          INTEGER,
  employees_max          INTEGER,
  employees_on_linkedin  INTEGER,
  headquarters           TEXT,
  website                TEXT,
  founded                TEXT,
  followers              INTEGER,
  headline               TEXT,
  location               TEXT,
  error                  TEXT,
  checked_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (cnpj, url)
);
CREATE INDEX IF NOT EXISTS linkedin_pages_checked_idx ON linkedin_pages (checked_at);

`;

/**
 * `jobs.kind` gained 'pipeline', and SQLite cannot alter a CHECK constraint.
 *
 * The table is rebuilt when the old constraint is still in place. Job rows are
 * a log of runs — nothing downstream reads them — so dropping the history is
 * the cheap correct answer rather than carrying a migration framework.
 */
function upgradeJobsKind(sqlite: Database.Database): void {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'")
    .get() as { sql?: string } | undefined;
  // The sentinel must name the NEWEST kind. Checking for an older one is a
  // silent no-op on every database that already has it, and the CHECK then
  // rejects inserts of the new kind at runtime rather than at migration time.
  if (!row?.sql || row.sql.includes("'openweb'")) return;
  sqlite.exec("DROP TABLE jobs;");
}

/**
 * `jobs_one_running_idx` went from `(status)` to `(status, lane)`.
 *
 * `CREATE UNIQUE INDEX IF NOT EXISTS` is a no-op against an index that already
 * exists under the old definition, so the old one has to be dropped by name
 * before the DDL can install the new one. Dropping an index loses nothing —
 * it is derived data — which is why this needs none of the table-rebuild
 * ceremony below.
 *
 * Without this, a database created before lanes keeps the global lock and the
 * open-internet sweep still refuses to start next to a continuous run, which is
 * exactly the bug the lane was introduced to fix.
 */
function upgradeJobsRunningIndex(sqlite: Database.Database): void {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='jobs_one_running_idx'")
    .get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("lane")) return;
  sqlite.exec("DROP INDEX jobs_one_running_idx;");
}

/**
 * `crawls.url_source` gained 'search', then 'discovery', and SQLite cannot alter a CHECK.
 *
 * Unlike `jobs`, these rows are worth keeping — a crawl is minutes of network
 * time and the text a score was built from. So this is a real rebuild: create
 * the table under a temporary name, copy every row across, swap. Same shape as
 * the DDL above, deliberately duplicated here because the DDL's
 * `IF NOT EXISTS` is what makes it a no-op on the database being fixed.
 */
function upgradeCrawlUrlSource(sqlite: Database.Database): void {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='crawls'")
    .get() as { sql?: string } | undefined;
  // The sentinel must name the NEWEST value. Checking an older one is a silent
  // no-op on every database that already has it, and the CHECK then rejects the
  // new value at runtime instead of at migration time.
  if (!row?.sql || row.sql.includes("'discovery'")) return;

  sqlite.exec(`
    BEGIN;
    CREATE TABLE crawls_new (
      cnpj          TEXT PRIMARY KEY,
      website_url   TEXT,
      final_url     TEXT,
      http_status   INTEGER,
      error         TEXT,
      url_source    TEXT CHECK (url_source IN ('email','places','manual','search','discovery')),
      signals       TEXT,
      text_excerpt  TEXT,
      pages_fetched INTEGER NOT NULL DEFAULT 0,
      checked_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    INSERT INTO crawls_new
      SELECT cnpj, website_url, final_url, http_status, error, url_source,
             signals, text_excerpt, pages_fetched, checked_at
      FROM crawls;
    DROP TABLE crawls;
    ALTER TABLE crawls_new RENAME TO crawls;
    CREATE INDEX IF NOT EXISTS crawls_checked_idx ON crawls (checked_at);
    COMMIT;
  `);
}

/**
 * Columns added to a table that already exists.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing database, so a new
 * column in the DDL above reaches a fresh install and nobody else. Listed here
 * as well, it reaches the database that is already on disk. `ADD COLUMN` is one
 * of the few alterations SQLite does in place, and it needs no default because
 * every column here is nullable.
 */
const ADDED_COLUMNS: { table: string; column: string; type: string }[] = [
  { table: "projects", column: "spec_draft", type: "TEXT" },
  { table: "search_hits", column: "headline", type: "TEXT" },
  { table: "companies", column: "tipo_logradouro", type: "TEXT" },
  { table: "companies", column: "logradouro", type: "TEXT" },
  { table: "companies", column: "numero", type: "TEXT" },
  { table: "companies", column: "complemento", type: "TEXT" },
  { table: "companies", column: "cep", type: "TEXT" },
  // NOT NULL with a constant default is one of the few things SQLite will add
  // in place, and it has to be NOT NULL: a null lane would make the partial
  // unique index treat every running job as distinct.
  { table: "jobs", column: "lane", type: "TEXT NOT NULL DEFAULT 'receita'" },
  { table: "cnae_picks", column: "reach_secundaria", type: "INTEGER NOT NULL DEFAULT 0" },
  {
    table: "cnae_picks",
    column: "reach_secundaria_with_phone",
    type: "INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "cnae_picks",
    column: "reach_secundaria_recent",
    type: "INTEGER NOT NULL DEFAULT 0",
  },
  // Nullable on purpose: a row added before this column cannot honestly claim
  // "principal", it can only say that nobody recorded which way it matched.
  { table: "companies", column: "cnae_match", type: "TEXT" },
  // For a lead with no CNPJ these are the only way to reach the business: there
  // is no `contacts` row (that table is keyed by CNPJ) and no Receita phone.
  { table: "web_leads", column: "emails", type: "TEXT" },
  { table: "web_leads", column: "phones", type: "TEXT" },
  { table: "web_leads", column: "status", type: "TEXT" },
  { table: "web_leads", column: "notes", type: "TEXT" },
];

function addMissingColumns(sqlite: Database.Database): void {
  for (const { table, column, type } of ADDED_COLUMNS) {
    const cols = sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as {
      name: string;
    }[];
    // Table does not exist yet: the DDL below will create it WITH the column, so
    // there is nothing to add here.
    if (!cols.length) continue;
    if (cols.some((c) => c.name === column)) continue;
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }
}

export function migrate(path = dbPath()): void {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  upgradeJobsKind(sqlite);
  upgradeJobsRunningIndex(sqlite);
  upgradeCrawlUrlSource(sqlite);
  // BEFORE the DDL, not after. The DDL creates indexes, and an index on a column
  // that `ADDED_COLUMNS` has not added yet fails with "no such column" — which is
  // how this was discovered. Running it first is correct in both directions: on a
  // fresh database the table does not exist yet and this is a no-op, and the DDL
  // then creates it with the column already in place.
  addMissingColumns(sqlite);
  sqlite.exec(DDL);
  sqlite.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? dbPath();
  migrate(path);
  console.log(`schema aplicado em ${path}`);
}
