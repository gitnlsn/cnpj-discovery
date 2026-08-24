import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * The Receita base is a set of Parquet files on disk, opened read-only. There
 * is no server and no import step: DuckDB reads the files in place and uses
 * row-group statistics plus Hive partitioning to skip what the query doesn't
 * touch.
 *
 * The connection is cached on `globalThis` because Next re-evaluates modules on
 * every edit in dev, and a fresh DuckDB instance per edit leaks file handles.
 */
declare global {
  var __cnpjDuck: Promise<DuckDBConnection> | undefined;
}

/**
 * Walks up to the workspace root. Next runs with `apps/web` as the cwd, so a
 * plain `process.cwd()` would look for the dataset inside the web app.
 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function dataRoot(): string {
  return process.env.CNPJ_DATA_DIR ?? join(repoRoot(), "data");
}

export const paths = {
  estabelecimentos: () => join(dataRoot(), "parquet", "estabelecimentos"),
  empresas: () => join(dataRoot(), "parquet", "empresas"),
  simples: () => join(dataRoot(), "parquet", "simples.parquet"),
  cnaes: () => join(dataRoot(), "ref", "cnaes.parquet"),
  municipios: () => join(dataRoot(), "ref", "municipios.parquet"),
  downloads: () => join(dataRoot(), "downloads"),
};

/** Thrown when the Parquet dataset hasn't been built yet. */
export class DatasetMissingError extends Error {
  constructor(what: string) {
    super(
      `A base da Receita ainda não foi gerada (${what} não existe). ` +
        `Rode: pnpm data:sync`
    );
    this.name = "DatasetMissingError";
  }
}

export function assertDataset(): void {
  if (!existsSync(paths.estabelecimentos())) {
    throw new DatasetMissingError("data/parquet/estabelecimentos");
  }
}

/** Thrown when the Parquet on disk was built by an older layout. */
export class DatasetStaleError extends Error {
  constructor(missing: string[]) {
    super(
      `A base da Receita foi gerada por uma versão anterior do layout e não tem ` +
        `${missing.join(", ")}. Reconverta:\n\n` +
        `  pnpm data:sync --only empresas --parts 0,1,2,3,4,5,6,7,8,9\n` +
        `  pnpm data:sync --only simples\n` +
        `  pnpm data:sync --only estabelecimentos --fresh --parts 0\n\n` +
        `Nada é baixado de novo se o tamanho já bater. As partes de Empresas vêm ` +
        `primeiro e completas de propósito: a razão social agora é gravada dentro ` +
        `de cada estabelecimento, então o que faltar aqui só sai no próximo --fresh.`
    );
    this.name = "DatasetStaleError";
  }
}

/**
 * Refuses a dataset that predates a column this code reads.
 *
 * Loudly, on purpose. The alternative — selecting the column only when it
 * happens to exist — would hand back a null address for every company and make
 * "the base is old" indistinguishable from "this company has no address". That
 * is the one confusion this project spends the most effort avoiding.
 */
async function assertEstabSchema(conn: DuckDBConnection): Promise<void> {
  const reader = await conn.runAndReadAll(`SELECT * FROM estabelecimentos LIMIT 0`);
  const present = new Set(reader.columnNames());
  const missing = [
    "tipo_logradouro",
    "logradouro",
    "numero",
    "complemento",
    // Folded in from `empresas` and `simples` at sync time. Listed here for the
    // same reason as the address: a base built before the fold would answer a
    // null razão social for the whole country, and "the base is old" has to stay
    // distinguishable from "this company has no name".
    "razao_social",
    "natureza_juridica",
    "capital_social",
    "porte",
    "simples",
    "mei",
    // Same argument again, and the reason it is not optional: a base built
    // before this column would answer "nenhuma empresa tem CNAE secundário" for
    // the whole country. That is the "não li" × "não existe" confusion this
    // project spends the most effort avoiding, and here it would look like a
    // legitimate answer instead of a missing column.
    "cnae_secundaria",
  ].filter((c) => !present.has(c));
  if (missing.length) throw new DatasetStaleError(missing);
}

async function open(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  // Views, not tables: nothing is copied into DuckDB's own storage. Re-running
  // data:sync changes the answers without touching this code.
  const estab = join(paths.estabelecimentos(), "**", "*.parquet");
  // `hive_types` is not optional. Left to infer, DuckDB reads the directory
  // name `cnae_div=05` as the integer 5, and every CNAE division below 10
  // silently stops matching its zero-padded string.
  await conn.run(`
    CREATE OR REPLACE VIEW estabelecimentos AS
      SELECT * FROM read_parquet(
        '${estab}',
        hive_partitioning = true,
        hive_types = {'cnae_div': 'VARCHAR'}
      );
  `);
  await assertEstabSchema(conn);
  // No `empresas` or `simples` views: both are folded into every establishments
  // row by the sync, so there is nothing left to join against. They stay on disk
  // only as inputs to the next sync, and `--drop-intermediates` removes them.
  if (existsSync(paths.cnaes())) {
    await conn.run(
      `CREATE OR REPLACE VIEW cnaes AS SELECT * FROM read_parquet('${paths.cnaes()}');`
    );
  }
  if (existsSync(paths.municipios())) {
    await conn.run(
      `CREATE OR REPLACE VIEW municipios AS SELECT * FROM read_parquet('${paths.municipios()}');`
    );
  }
  return conn;
}

export function connection(): Promise<DuckDBConnection> {
  assertDataset();
  globalThis.__cnpjDuck ??= open();
  return globalThis.__cnpjDuck;
}

/** A one-off connection with no views and no caching — for the sync script. */
export async function scratchConnection(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  // The establishments conversion hash-joins a part against the whole of
  // `empresas` — 47 M rows carrying razão social. In an `:memory:` database with
  // no temp directory that join has nowhere to spill and dies; pointing it at
  // the data directory is what lets a national sync finish on a laptop.
  await conn.run(`SET temp_directory = '${join(dataRoot(), "tmp")}'`);
  // Nothing downstream depends on row order, and holding it costs memory the
  // join wants.
  await conn.run(`SET preserve_insertion_order = false`);
  return conn;
}

/** Runs a parameterised query and returns plain JS objects. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const conn = await connection();
  const reader = params.length
    ? await conn.runAndReadAll(sql, params as never[])
    : await conn.runAndReadAll(sql);
  return reader.getRowObjects() as T[];
}
