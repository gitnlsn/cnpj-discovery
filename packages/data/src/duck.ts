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
  if (existsSync(paths.empresas())) {
    await conn.run(`
      CREATE OR REPLACE VIEW empresas AS
        SELECT * FROM read_parquet('${join(paths.empresas(), "*.parquet")}');
    `);
  }
  if (existsSync(paths.simples())) {
    await conn.run(
      `CREATE OR REPLACE VIEW simples AS SELECT * FROM read_parquet('${paths.simples()}');`
    );
  }
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
  return instance.connect();
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
