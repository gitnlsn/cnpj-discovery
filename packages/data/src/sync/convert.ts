import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";
import type { DuckDBConnection } from "@duckdb/node-api";
import {
  ESTAB,
  EMPRESA,
  SIMPLES,
  SITUACAO_ATIVA,
  splitRfLine,
  toCsvLine,
  rfDate,
  rfDecimal,
  fullCnpj,
} from "../rf-layout";
import { streamZipLines } from "./mirror";

/** Trims and squeezes the space runs the fixed-width source leaves behind. */
function collapse(v: string | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim();
}

export interface FilterStats {
  read: number;
  kept: number;
  withPhone: number;
  withEmail: number;
}

/**
 * Streams a ZIP through a row filter into a staging CSV.
 *
 * Filtering here rather than after loading is the point: a row that fails the
 * predicate never touches disk. `situacao != '02'` alone removes roughly half
 * the national file.
 */
async function filterZipToCsv(
  zipPath: string,
  csvPath: string,
  mapRow: (fields: string[], stats: FilterStats) => (string | null)[] | null,
  onTick?: (stats: FilterStats) => void
): Promise<FilterStats> {
  await mkdir(dirname(csvPath), { recursive: true });
  const stats: FilterStats = { read: 0, kept: 0, withPhone: 0, withEmail: 0 };
  const out = createWriteStream(csvPath, { encoding: "utf8" });
  const lines = streamZipLines(zipPath);

  let lastTick = 0;
  for await (const line of lines as AsyncIterable<string>) {
    stats.read++;
    const row = mapRow(splitRfLine(line), stats);
    if (row) {
      stats.kept++;
      if (!out.write(toCsvLine(row))) await once(out, "drain");
    }
    const now = Date.now();
    if (now - lastTick > 1000) {
      lastTick = now;
      onTick?.(stats);
    }
  }

  out.end();
  await once(out, "finish");
  onTick?.(stats);
  return stats;
}

const ESTAB_COLUMNS = [
  "cnpj",
  "cnpj_basico",
  "matriz",
  "nome_fantasia",
  "cnae_principal",
  "data_inicio_atividade",
  "uf",
  "municipio_rf",
  "tipo_logradouro",
  "logradouro",
  "numero",
  "complemento",
  "bairro",
  "cep",
  "ddd",
  "telefone",
  "email",
] as const;

/**
 * Establishments are partitioned by CNAE division (the first two digits) so a
 * query for one CNAE reads one directory instead of the whole country. Two
 * digits, not seven: seven would produce ~1,300 directories of a few hundred KB
 * each, which costs more in file opens than it saves in skipped bytes.
 */
export async function convertEstabelecimentos(
  conn: DuckDBConnection,
  zipPath: string,
  csvPath: string,
  outDir: string,
  partLabel: string,
  onTick?: (stats: FilterStats) => void
): Promise<FilterStats> {
  const stats = await filterZipToCsv(
    zipPath,
    csvPath,
    (f, s) => {
      if (f[ESTAB.SITUACAO] !== SITUACAO_ATIVA) return null;
      const cnae = (f[ESTAB.CNAE_PRINCIPAL] ?? "").trim();
      if (!cnae) return null;

      const ddd = (f[ESTAB.DDD_1] ?? "").trim();
      const tel = (f[ESTAB.TELEFONE_1] ?? "").trim();
      const email = (f[ESTAB.EMAIL] ?? "").trim().toLowerCase();
      if (ddd && tel) s.withPhone++;
      if (email) s.withEmail++;

      return [
        fullCnpj(f[ESTAB.CNPJ_BASICO] ?? "", f[ESTAB.CNPJ_ORDEM] ?? "", f[ESTAB.CNPJ_DV] ?? ""),
        (f[ESTAB.CNPJ_BASICO] ?? "").padStart(8, "0"),
        (f[ESTAB.MATRIZ_FILIAL] ?? "").trim(),
        (f[ESTAB.NOME_FANTASIA] ?? "").trim(),
        cnae,
        rfDate(f[ESTAB.DATA_INICIO]),
        (f[ESTAB.UF] ?? "").trim(),
        (f[ESTAB.MUNICIPIO] ?? "").trim(),
        // The street columns come out of a fixed-width system: 15,6% of
        // non-empty complementos carry a run of spaces. Squeezed here, once,
        // rather than in every reader.
        collapse(f[ESTAB.TIPO_LOGRADOURO]),
        collapse(f[ESTAB.LOGRADOURO]),
        collapse(f[ESTAB.NUMERO]),
        collapse(f[ESTAB.COMPLEMENTO]),
        (f[ESTAB.BAIRRO] ?? "").trim(),
        (f[ESTAB.CEP] ?? "").trim(),
        ddd,
        tel,
        email,
      ];
    },
    onTick
  );

  await mkdir(outDir, { recursive: true });
  await conn.run(`
    COPY (
      SELECT
        cnpj, cnpj_basico,
        matriz = '1'                       AS is_matriz,
        nullif(nome_fantasia, '')          AS nome_fantasia,
        cnae_principal,
        try_cast(data_inicio_atividade AS DATE) AS data_inicio_atividade,
        uf,
        nullif(municipio_rf, '')           AS municipio_rf,
        nullif(tipo_logradouro, '')        AS tipo_logradouro,
        nullif(logradouro, '')             AS logradouro,
        nullif(numero, '')                 AS numero,
        nullif(complemento, '')            AS complemento,
        nullif(bairro, '')                 AS bairro,
        nullif(cep, '')                    AS cep,
        nullif(ddd, '')                    AS ddd,
        nullif(telefone, '')               AS telefone,
        nullif(email, '')                  AS email,
        substr(cnae_principal, 1, 2)       AS cnae_div
      FROM read_csv(
        '${csvPath}',
        header = false,
        columns = {${ESTAB_COLUMNS.map((c) => `'${c}': 'VARCHAR'`).join(", ")}},
        quote = '"', escape = '"', nullstr = ''
      )
    ) TO '${outDir}' (
      FORMAT parquet, COMPRESSION zstd,
      PARTITION_BY (cnae_div),
      FILENAME_PATTERN '${partLabel}_{uuid}',
      APPEND
    );
  `);

  await rm(csvPath, { force: true });
  return stats;
}

const EMPRESA_COLUMNS = [
  "cnpj_basico",
  "razao_social",
  "natureza_juridica",
  "capital_social",
  "porte",
] as const;

export async function convertEmpresas(
  conn: DuckDBConnection,
  zipPath: string,
  csvPath: string,
  outDir: string,
  partLabel: string,
  onTick?: (stats: FilterStats) => void
): Promise<FilterStats> {
  const stats = await filterZipToCsv(
    zipPath,
    csvPath,
    (f) => [
      (f[EMPRESA.CNPJ_BASICO] ?? "").padStart(8, "0"),
      (f[EMPRESA.RAZAO_SOCIAL] ?? "").trim(),
      (f[EMPRESA.NATUREZA_JURIDICA] ?? "").trim(),
      rfDecimal(f[EMPRESA.CAPITAL_SOCIAL]),
      (f[EMPRESA.PORTE] ?? "").trim(),
    ],
    onTick
  );

  await mkdir(outDir, { recursive: true });
  await conn.run(`
    COPY (
      SELECT
        cnpj_basico,
        nullif(razao_social, '')       AS razao_social,
        nullif(natureza_juridica, '')  AS natureza_juridica,
        try_cast(capital_social AS DOUBLE) AS capital_social,
        nullif(porte, '')              AS porte
      FROM read_csv(
        '${csvPath}',
        header = false,
        columns = {${EMPRESA_COLUMNS.map((c) => `'${c}': 'VARCHAR'`).join(", ")}},
        quote = '"', escape = '"', nullstr = ''
      )
    ) TO '${outDir}/${partLabel}.parquet' (FORMAT parquet, COMPRESSION zstd);
  `);

  await rm(csvPath, { force: true });
  return stats;
}

export async function convertSimples(
  conn: DuckDBConnection,
  zipPath: string,
  csvPath: string,
  outFile: string,
  onTick?: (stats: FilterStats) => void
): Promise<FilterStats> {
  // Only the two flags survive. The dates and the rest of the file are read and
  // discarded — the whole table exists to answer "is this a MEI?".
  const stats = await filterZipToCsv(
    zipPath,
    csvPath,
    (f) => {
      const simples = (f[SIMPLES.OPCAO_SIMPLES] ?? "").trim();
      const mei = (f[SIMPLES.OPCAO_MEI] ?? "").trim();
      if (simples !== "S" && mei !== "S") return null;
      return [(f[SIMPLES.CNPJ_BASICO] ?? "").padStart(8, "0"), simples, mei];
    },
    onTick
  );

  await mkdir(dirname(outFile), { recursive: true });
  await conn.run(`
    COPY (
      SELECT cnpj_basico, opcao_simples = 'S' AS simples, opcao_mei = 'S' AS mei
      FROM read_csv(
        '${csvPath}', header = false,
        columns = {'cnpj_basico': 'VARCHAR', 'opcao_simples': 'VARCHAR', 'opcao_mei': 'VARCHAR'},
        quote = '"', escape = '"', nullstr = ''
      )
    ) TO '${outFile}' (FORMAT parquet, COMPRESSION zstd);
  `);

  await rm(csvPath, { force: true });
  return stats;
}

/** Reference tables: CNAE dictionary and RF município codes. Both tiny. */
export async function convertRef(
  conn: DuckDBConnection,
  zipPath: string,
  csvPath: string,
  outFile: string,
  columns: readonly string[]
): Promise<FilterStats> {
  const stats = await filterZipToCsv(zipPath, csvPath, (f) =>
    columns.map((_, i) => (f[i] ?? "").trim())
  );
  await mkdir(dirname(outFile), { recursive: true });
  await conn.run(`
    COPY (
      SELECT * FROM read_csv(
        '${csvPath}', header = false,
        columns = {${columns.map((c) => `'${c}': 'VARCHAR'`).join(", ")}},
        quote = '"', escape = '"', nullstr = ''
      )
    ) TO '${outFile}' (FORMAT parquet, COMPRESSION zstd);
  `);
  await rm(csvPath, { force: true });
  return stats;
}
