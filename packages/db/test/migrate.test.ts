import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { migrate } from "../src/migrate";
import { projects } from "../src/schema";

const tmp = () => join(mkdtempSync(join(tmpdir(), "cnpj-db-")), "app.db");

const columns = (path: string): string[] => {
  const sqlite = new Database(path);
  const rows = sqlite.prepare("SELECT name FROM pragma_table_info('projects')").all() as {
    name: string;
  }[];
  sqlite.close();
  return rows.map((r) => r.name);
};

test("uma base nova nasce com todas as colunas", () => {
  const path = tmp();
  migrate(path);
  assert.ok(columns(path).includes("spec_draft"));
});

/**
 * O caso que passa despercebido: `CREATE TABLE IF NOT EXISTS` não faz nada numa
 * base que já existe, então uma coluna nova chega só na instalação limpa. Esta
 * base de verdade tem meses de dados — se a migração não a alcançar, o app
 * quebra num SELECT e o desenvolvimento não vê nada.
 */
test("uma base antiga ganha a coluna sem perder as linhas", () => {
  const path = tmp();
  const sqlite = new Database(path);
  sqlite.exec(`
    CREATE TABLE projects (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      icp_text          TEXT NOT NULL DEFAULT '',
      spec              TEXT,
      spec_model        TEXT,
      spec_compiled_at  TEXT,
      created_at        TEXT NOT NULL DEFAULT '2026-01-01',
      updated_at        TEXT NOT NULL DEFAULT '2026-01-01'
    );
    INSERT INTO projects (id, name, description) VALUES ('antigo', 'Antigo', 'Sites');
  `);
  sqlite.close();
  assert.ok(!columns(path).includes("spec_draft"), "a base começa sem a coluna");

  migrate(path);

  assert.ok(columns(path).includes("spec_draft"), "a migração alcança a base existente");
  const db = drizzle(new Database(path));
  const [row] = db.select().from(projects).where(eq(projects.id, "antigo")).all();
  assert.equal(row?.description, "Sites", "a linha antiga continua lá");
  assert.equal(row?.specDraft, null);
});

test("migrar duas vezes é um no-op", () => {
  const path = tmp();
  migrate(path);
  migrate(path);
  assert.equal(columns(path).filter((c) => c === "spec_draft").length, 1);
});

/**
 * O rascunho é gravado como objeto e lido como objeto. Se o drizzle devolvesse
 * a string crua, a retomada silenciosamente nunca aconteceria: o guard recusa,
 * o compile refaz as duas chamadas e ninguém percebe.
 */
test("o rascunho do compile sobrevive à ida e volta como objeto", () => {
  const path = tmp();
  migrate(path);
  const db = drizzle(new Database(path));

  db.insert(projects).values({ id: "p", name: "P", description: "Sites" }).run();

  const draft = {
    targeting: { cnaePrefixes: ["8513"], probes: [] },
    model: "gemini-flash-lite-latest",
    sourceSha: "abc123",
  };
  db.update(projects).set({ specDraft: draft }).where(eq(projects.id, "p")).run();

  const [row] = db.select().from(projects).where(eq(projects.id, "p")).all();
  assert.deepEqual(row?.specDraft, draft);

  db.update(projects).set({ specDraft: null }).where(eq(projects.id, "p")).run();
  const [cleared] = db.select().from(projects).where(eq(projects.id, "p")).all();
  assert.equal(cleared?.specDraft, null, "compilar com sucesso limpa o rascunho");
});

// ------------------------------------------------- restrições CHECK antigas

/**
 * O `jobs.kind` ganhou 'search', e o SQLite não altera um CHECK.
 *
 * A armadilha: o sentinela de `upgradeJobsKind` pergunta "o tipo mais novo já
 * está aí?". Se ele continuar apontando para um tipo antigo, a resposta é sim em
 * toda base que já existe, a tabela nunca é reconstruída, e o INSERT quebra em
 * produção em vez de na migração. Este teste é o que pega isso.
 */
test("uma base com o CHECK antigo de jobs passa a aceitar kind 'search'", () => {
  const path = tmp();
  const sqlite = new Database(path);
  sqlite.exec(`
    CREATE TABLE jobs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL CHECK (kind IN ('compile','discover','crawl','score','places','pipeline','continuous')),
      project_id  TEXT,
      status      TEXT NOT NULL CHECK (status IN ('running','done','failed','cancelled')),
      progress    TEXT,
      log         TEXT NOT NULL DEFAULT '',
      error       TEXT,
      started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      finished_at TEXT
    );
  `);
  sqlite.close();

  migrate(path);

  const db = new Database(path);
  db.prepare("INSERT INTO jobs (kind, status) VALUES ('search', 'running')").run();
  const row = db.prepare("SELECT kind FROM jobs").get() as { kind: string };
  db.close();
  assert.equal(row.kind, "search");
});

/**
 * O mesmo problema em `crawls.url_source`, com uma diferença que importa: as
 * linhas de crawl valem minutos de rede e são o texto de onde saiu a nota, então
 * aqui a tabela é reconstruída preservando tudo, não derrubada.
 */
test("o CHECK antigo de crawls é reconstruído SEM perder as linhas", () => {
  const path = tmp();
  const sqlite = new Database(path);
  sqlite.exec(`
    CREATE TABLE crawls (
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
    INSERT INTO crawls (cnpj, final_url, url_source, text_excerpt, pages_fetched)
      VALUES ('68464469000115', 'https://x.com.br', 'email', 'texto antigo', 3);
  `);
  sqlite.close();

  migrate(path);

  const db = new Database(path);
  // A linha antiga sobreviveu, com os valores intactos.
  const old = db.prepare("SELECT * FROM crawls WHERE cnpj = '68464469000115'").get() as {
    text_excerpt: string;
    url_source: string;
    pages_fetched: number;
  };
  assert.equal(old.text_excerpt, "texto antigo");
  assert.equal(old.url_source, "email");
  assert.equal(old.pages_fetched, 3);

  // E o valor novo agora entra.
  db.prepare("INSERT INTO crawls (cnpj, url_source) VALUES ('1', 'search')").run();
  const fresh = db.prepare("SELECT url_source FROM crawls WHERE cnpj = '1'").get() as {
    url_source: string;
  };
  db.close();
  assert.equal(fresh.url_source, "search");
});

test("migrar duas vezes seguidas não quebra nem duplica nada", () => {
  const path = tmp();
  migrate(path);
  migrate(path);

  const db = new Database(path);
  db.prepare("INSERT INTO crawls (cnpj, url_source) VALUES ('1', 'search')").run();
  const count = db.prepare("SELECT count(*) AS n FROM crawls").get() as { n: number };
  db.close();
  assert.equal(count.n, 1);
});

test("as tabelas de busca nascem na base nova", () => {
  const path = tmp();
  migrate(path);

  const db = new Database(path);
  db.prepare(
    "INSERT INTO search_lookups (cnpj, provider, query, considered, verified) VALUES (?,?,?,?,?)"
  ).run("68464469000115", "duckduckgo", '"maria raquel" manaus am', 8, 1);
  db.prepare(
    "INSERT INTO search_hits (cnpj, url, title, description, kind, matched_on) VALUES (?,?,?,?,?,?)"
  ).run("68464469000115", "https://instagram.com/x", "Maria", "Cursos", "social", "title");

  // A chave composta é o que impede a mesma URL de entrar duas vezes.
  assert.throws(() =>
    db
      .prepare("INSERT INTO search_hits (cnpj, url) VALUES (?,?)")
      .run("68464469000115", "https://instagram.com/x")
  );

  const hit = db.prepare("SELECT kind, matched_on FROM search_hits").get() as {
    kind: string;
    matched_on: string;
  };
  db.close();
  assert.equal(hit.kind, "social");
  assert.equal(hit.matched_on, "title");
});

/**
 * A coluna `headline` chegou depois que `search_hits` já existia.
 *
 * `CREATE TABLE IF NOT EXISTS` é no-op numa base que já está no disco, então
 * quem faz o trabalho aqui é a entrada em `ADDED_COLUMNS`. Esquecer essa entrada
 * não quebra nada na migração — quebra depois, no INSERT, em produção. É esse o
 * motivo deste teste.
 */
test("search_hits ganha a coluna headline sem perder as linhas", () => {
  const path = tmp();
  const sqlite = new Database(path);
  sqlite.exec(`
    CREATE TABLE search_hits (
      cnpj        TEXT NOT NULL,
      url         TEXT NOT NULL,
      title       TEXT,
      description TEXT,
      kind        TEXT,
      matched_on  TEXT,
      checked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (cnpj, url)
    );
    INSERT INTO search_hits (cnpj, url, title, kind, matched_on)
      VALUES ('68464469000115', 'https://instagram.com/x', 'Maria', 'social', 'title');
  `);
  sqlite.close();

  migrate(path);

  const db = new Database(path);
  const cols = (
    db.prepare("SELECT name FROM pragma_table_info('search_hits')").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  assert.ok(cols.includes("headline"), `headline ausente: ${cols.join(", ")}`);

  // A linha antiga sobreviveu, com headline nulo — que é o correto: ninguém
  // extraiu nada dela, e nulo é diferente de "extraí e estava vazio".
  const old = db.prepare("SELECT title, kind, headline FROM search_hits").get() as {
    title: string;
    kind: string;
    headline: string | null;
  };
  assert.equal(old.title, "Maria");
  assert.equal(old.kind, "social");
  assert.equal(old.headline, null);

  // E o valor novo entra.
  db.prepare("INSERT INTO search_hits (cnpj, url, kind, headline) VALUES (?,?,?,?)").run(
    "1",
    "https://br.linkedin.com/in/x",
    "linkedin",
    "Professora de Matemática"
  );
  const fresh = db.prepare("SELECT headline FROM search_hits WHERE cnpj = '1'").get() as {
    headline: string;
  };
  db.close();
  assert.equal(fresh.headline, "Professora de Matemática");
});

/**
 * As duas raias, e por que isso é um teste e não um comentário.
 *
 * A regra antiga era um job por vez, ponto — e ela bloqueava a única combinação
 * que alguém realmente quer ao mesmo tempo: varrer a internet aberta procurando
 * empresas que não estão no projeto enquanto trabalha as que estão. O índice
 * agora é `(status, lane)`.
 *
 * Duas maneiras de isso quebrar em silêncio, as duas cobertas aqui: o índice
 * antigo sobreviver à migração (e a varredura continuar recusada), ou `lane`
 * virar NULL (e o índice deixar de bloquear qualquer coisa, porque SQLite trata
 * NULLs como distintos num índice único).
 */
test("as duas raias rodam juntas, e cada uma continua bloqueando a si mesma", () => {
  const path = tmp();
  migrate(path);
  const sqlite = new Database(path);
  const start = (kind: string, lane: string) =>
    sqlite
      .prepare("INSERT INTO jobs (kind, lane, status, progress) VALUES (?, ?, 'running', '{}')")
      .run(kind, lane);

  start("continuous", "receita");
  // O pedido: a varredura não espera o processamento das empresas.
  start("openweb", "openweb");
  assert.equal(
    (
      sqlite.prepare("SELECT count(*) n FROM jobs WHERE status = 'running'").get() as {
        n: number;
      }
    ).n,
    2
  );

  // E dentro de cada raia a garantia antiga continua valendo, no banco.
  assert.throws(() => start("crawl", "receita"), /UNIQUE|constraint/);
  assert.throws(() => start("openweb", "openweb"), /UNIQUE|constraint/);
  sqlite.close();
});

/** Uma base anterior às raias tem de perder o índice global, ou nada muda. */
test("uma base antiga troca o índice de um-job-só pelo de uma-raia-só", () => {
  const path = tmp();
  const sqlite = new Database(path);
  sqlite.exec(`
    CREATE TABLE jobs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL CHECK (kind IN ('compile','crawl','score','continuous','search')),
      project_id  TEXT,
      status      TEXT NOT NULL CHECK (status IN ('running','done','failed','cancelled')),
      progress    TEXT,
      log         TEXT NOT NULL DEFAULT '',
      error       TEXT,
      started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      finished_at TEXT
    );
    CREATE UNIQUE INDEX jobs_one_running_idx ON jobs (status) WHERE status = 'running';
  `);
  sqlite.close();

  migrate(path);

  const db = new Database(path);
  const idx = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'jobs_one_running_idx'")
    .get() as {
    sql: string;
  };
  assert.match(idx.sql, /lane/, "o índice global sobreviveu e a varredura seguiria bloqueada");
  const cols = (
    db.prepare("SELECT name FROM pragma_table_info('jobs')").all() as { name: string }[]
  ).map((r) => r.name);
  assert.ok(cols.includes("lane"));
  // NOT NULL é o que faz o índice bloquear de verdade.
  const lane = (
    db.prepare("SELECT * FROM pragma_table_info('jobs')").all() as {
      name: string;
      notnull: number;
    }[]
  ).find((c) => c.name === "lane");
  assert.equal(lane?.notnull, 1);
  db.close();
});

/**
 * As tabelas da internet aberta, e os dois CHECKs que impedem uma linha mentirosa.
 */
test("as tabelas da internet aberta nascem na base nova", () => {
  const path = tmp();
  migrate(path);
  const db = new Database(path);
  const names = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  ).map((r) => r.name);
  for (const t of ["web_queries", "web_leads", "web_lead_scores"]) {
    assert.ok(names.includes(t), `falta ${t}`);
  }
  // Sem coluna de nome: os termos do Google permitem o place_id e nada mais, e
  // o nome exibido vem do nosso próprio crawl.
  const cols = (
    db.prepare("SELECT name FROM pragma_table_info('web_leads')").all() as { name: string }[]
  ).map((r) => r.name);
  assert.ok(!cols.includes("name"), "web_leads não pode guardar o nome vindo do Google");
  assert.ok(!cols.includes("address"), "web_leads não pode guardar o endereço vindo do Google");
  assert.ok(cols.includes("place_id"));
  db.close();
});

test("veredito e CNPJ não podem discordar", () => {
  const path = tmp();
  migrate(path);
  const db = new Database(path);
  db.prepare("INSERT INTO projects (id, name) VALUES ('p', 'P')").run();
  const insert = (verdict: string, cnpj: string | null, via: string | null) =>
    db
      .prepare(
        `INSERT INTO web_leads (project_id, apex, website_url, verdict, matched_cnpj, match_via)
         VALUES ('p', ?, 'https://x', ?, ?, ?)`
      )
      .run(`${verdict}-${cnpj}-${via}`, verdict, cnpj, via);

  // "não achamos o CNPJ" com um CNPJ preenchido é uma contradição, e o banco
  // recusa em vez de deixar a linha existir.
  assert.throws(() => insert("unmatched", "12345678000199", "address"), /CHECK/);
  // E o inverso: dizer que está na base sem dizer qual empresa.
  assert.throws(() => insert("out_of_reach", null, null), /CHECK/);
  // Um CNPJ sem dizer COMO foi casado não é auditável.
  assert.throws(() => insert("in_reach", "12345678000199", null), /CHECK/);
  // As duas formas honestas passam.
  insert("unmatched", null, null);
  insert("out_of_reach", "12345678000199", "address");
  db.close();
});
