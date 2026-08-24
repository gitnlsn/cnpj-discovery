import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  /**
   * Equal to `kept` for establishments, which now require an e-mail to be kept
   * at all. Counted anyway: the day the filter is relaxed this is the number
   * that says by how much.
   */
  withEmail: number;
  /** Rows carrying at least one secondary CNAE. Measured at 56,7% on part 0. */
  withCnaeSecundaria: number;
  /** Total secondary codes seen, so the report can print an average per row. */
  cnaeSecundariaCodes: number;
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
  const stats: FilterStats = {
    read: 0,
    kept: 0,
    withPhone: 0,
    withEmail: 0,
    withCnaeSecundaria: 0,
    cnaeSecundariaCodes: 0,
  };
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
  "cnae_secundaria",
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
 * Thrown when the establishments conversion is asked to run before the tables it
 * folds in exist.
 *
 * Loud on purpose. The join is baked into the Parquet, so a missing `empresas`
 * would not produce a recoverable empty join — it would write a null razão
 * social for every company in the country and leave no trace of why. That is the
 * "I did not look" vs "there is nothing there" confusion this project spends the
 * most effort avoiding, made permanent on disk.
 */
export class MissingJoinInputError extends Error {
  constructor(missing: string[]) {
    super(
      `Estabelecimentos são desnormalizados: razão social, porte, capital, natureza, ` +
        `simples e MEI são gravados junto de cada linha. Faltam ${missing.join(", ")}, ` +
        `então o join sairia vazio e a base ficaria sem esses campos.\n\n` +
        `Converta as tabelas de apoio primeiro:\n\n` +
        `  pnpm data:sync --only empresas --parts 0,1,2,3,4,5,6,7,8,9\n` +
        `  pnpm data:sync --only simples\n`
    );
    this.name = "MissingJoinInputError";
  }
}

/**
 * Establishments are partitioned by CNAE division (the first two digits) so a
 * query for one CNAE reads one directory instead of the whole country. Two
 * digits, not seven: seven would produce ~1,300 directories of a few hundred KB
 * each, which costs more in file opens than it saves in skipped bytes.
 *
 * `empresas` and `simples` are folded in here rather than joined at query time.
 * They were two of the four LEFT JOINs every discovery query paid for, and
 * neither is partitioned, so each one scanned its whole file. Folding costs 8,4%
 * on the establishments files (measured on cnae_div=62) and lets both inputs be
 * deleted afterwards: `razao_social` alone is 602 MB for 47,0 M company rows, of
 * which only 13,3 M are reachable from an active establishment.
 */
export async function convertEstabelecimentos(
  conn: DuckDBConnection,
  zipPath: string,
  csvPath: string,
  outDir: string,
  partLabel: string,
  joins: { empresasDir: string; simplesFile: string },
  onTick?: (stats: FilterStats) => void
): Promise<FilterStats> {
  const missing: string[] = [];
  if (!existsSync(joins.empresasDir)) missing.push("empresas");
  if (!existsSync(joins.simplesFile)) missing.push("simples");
  if (missing.length) throw new MissingJoinInputError(missing);

  const stats = await filterZipToCsv(
    zipPath,
    csvPath,
    (f, s) => {
      if (f[ESTAB.SITUACAO] !== SITUACAO_ATIVA) return null;
      const cnae = (f[ESTAB.CNAE_PRINCIPAL] ?? "").trim();
      if (!cnae) return null;

      const email = (f[ESTAB.EMAIL] ?? "").trim().toLowerCase();
      // No e-mail, no start: the Receita publishes no website column, so the
      // registered domain is the only thing a crawl can be aimed at. Costs 10,7%
      // of the active base, and almost all of it is old — 56,9% of the companies
      // opened in 1990 have no e-mail against 0,2% of those opened in 2025, so
      // this filter is very nearly "opened before 2021". Deliberate.
      if (!email) return null;

      const ddd = (f[ESTAB.DDD_1] ?? "").trim();
      const tel = (f[ESTAB.TELEFONE_1] ?? "").trim();
      if (ddd && tel) s.withPhone++;
      s.withEmail++;

      // Written raw, split into a list by the COPY below. Counted here because
      // this is the only place that sees the field before DuckDB does, and the
      // sync report is where "how much did this column buy" gets answered.
      const cnaeSec = (f[ESTAB.CNAE_SECUNDARIA] ?? "").trim();
      if (cnaeSec) {
        s.withCnaeSecundaria++;
        s.cnaeSecundariaCodes += cnaeSec.split(",").length;
      }

      return [
        fullCnpj(f[ESTAB.CNPJ_BASICO] ?? "", f[ESTAB.CNPJ_ORDEM] ?? "", f[ESTAB.CNPJ_DV] ?? ""),
        (f[ESTAB.CNPJ_BASICO] ?? "").padStart(8, "0"),
        (f[ESTAB.MATRIZ_FILIAL] ?? "").trim(),
        (f[ESTAB.NOME_FANTASIA] ?? "").trim(),
        cnae,
        cnaeSec,
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
  // `cnpj_basico` is read from the staging CSV as the join key and deliberately
  // NOT written out: it only ever existed to serve these two joins, and it is
  // the first eight digits of `cnpj` anyway (see `fullCnpj`). 75 MB of the
  // national base, recoverable as substr(cnpj, 1, 8) if anything ever needs it.
  await conn.run(`
    COPY (
      SELECT
        e.cnpj,
        e.matriz = '1'                       AS is_matriz,
        nullif(e.nome_fantasia, '')          AS nome_fantasia,
        e.cnae_principal,
        -- As atividades secundárias como LISTA, não como string.
        --
        -- Os códigos têm todos 7 dígitos (medido: 100% de 1.022.785 no
        -- amostrado), então casar prefixo numa lista é starts_with por
        -- elemento — exato. Numa string serializada não é: LIKE '%8599%'
        -- casaria 18599xx no meio da lista, o que é simplesmente errado.
        --
        -- O nullif é a armadilha: str_split('', ',') devolve [''], não NULL, e
        -- essa lista com uma string vazia casaria qualquer prefixo vazio. NULL
        -- propaga certo — list_has_any(NULL, ...) não é TRUE, então a linha sai
        -- do WHERE e conta como falso dentro de count(*) FILTER, sem precisar de
        -- coalesce em leitor nenhum.
        --
        -- list_distinct normaliza uma vez aqui em vez de em cada leitura, e
        -- mantém a contagem exata se a Receita repetir um código na mesma lista.
        list_distinct(str_split(nullif(e.cnae_secundaria, ''), ',')) AS cnae_secundaria,
        try_cast(e.data_inicio_atividade AS DATE) AS data_inicio_atividade,
        e.uf,
        nullif(e.municipio_rf, '')           AS municipio_rf,
        nullif(e.tipo_logradouro, '')        AS tipo_logradouro,
        nullif(e.logradouro, '')             AS logradouro,
        nullif(e.numero, '')                 AS numero,
        nullif(e.complemento, '')            AS complemento,
        nullif(e.bairro, '')                 AS bairro,
        nullif(e.cep, '')                    AS cep,
        nullif(e.ddd, '')                    AS ddd,
        nullif(e.telefone, '')               AS telefone,
        nullif(e.email, '')                  AS email,
        emp.razao_social,
        emp.natureza_juridica,
        emp.capital_social,
        emp.porte,
        coalesce(s.simples, false)           AS simples,
        coalesce(s.mei, false)               AS mei,
        -- A chave de partição continua vindo SÓ do CNAE principal, de propósito.
        -- Particionar (ou indexar) pelo secundário foi medido e rejeitado: as
        -- empresas que casam um CNAE alvo pelo secundário se espalham por 42 a
        -- 78 das 87 divisões (78 no 8599, o CNAE de referência do projeto), então
        -- a poda economizaria ~10% de uma varredura que custa ~1 s, ao preço de
        -- ~26 M linhas a mais e +26% de disco. Ver o README.
        substr(e.cnae_principal, 1, 2)       AS cnae_div
      FROM read_csv(
        '${csvPath}',
        header = false,
        columns = {${ESTAB_COLUMNS.map((c) => `'${c}': 'VARCHAR'`).join(", ")}},
        quote = '"', escape = '"', nullstr = ''
      ) e
      LEFT JOIN read_parquet('${join(joins.empresasDir, "*.parquet")}') emp
        ON emp.cnpj_basico = e.cnpj_basico
      LEFT JOIN read_parquet('${joins.simplesFile}') s
        ON s.cnpj_basico = e.cnpj_basico
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
