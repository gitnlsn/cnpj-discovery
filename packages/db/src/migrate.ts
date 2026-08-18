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
  uf                    TEXT,
  municipio             TEXT,
  bairro                TEXT,
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

CREATE TABLE IF NOT EXISTS crawls (
  cnpj          TEXT PRIMARY KEY,
  website_url   TEXT,
  final_url     TEXT,
  http_status   INTEGER,
  error         TEXT,
  url_source    TEXT CHECK (url_source IN ('email','places','manual')),
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

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('compile','discover','crawl','score','places')),
  project_id  TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running','done','failed','cancelled')),
  progress    TEXT,
  log         TEXT NOT NULL DEFAULT '',
  error       TEXT,
  started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
-- One job at a time, enforced by the database. Two fast clicks cannot race past
-- a partial unique index the way they can race past a JavaScript guard.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_running_idx ON jobs (status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_recent_idx ON jobs (started_at);

CREATE TABLE IF NOT EXISTS usage (
  day   TEXT NOT NULL,
  kind  TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
`;

export function migrate(path = dbPath()): void {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(DDL);
  sqlite.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? dbPath();
  migrate(path);
  console.log(`schema aplicado em ${path}`);
}
