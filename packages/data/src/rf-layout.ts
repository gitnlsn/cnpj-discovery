/**
 * Column offsets in the Receita Federal open-data CSVs. Fixed by the official
 * layout document (cnpj-metadados.pdf); the files themselves carry no header.
 *
 * Only the columns this project actually reads are listed. Everything else in
 * the file is skipped at parse time and never reaches disk — that is the whole
 * storage argument for this rewrite.
 */
export const ESTAB = {
  CNPJ_BASICO: 0,
  CNPJ_ORDEM: 1,
  CNPJ_DV: 2,
  MATRIZ_FILIAL: 3,
  NOME_FANTASIA: 4,
  SITUACAO: 5,
  DATA_INICIO: 10,
  CNAE_PRINCIPAL: 11,
  TIPO_LOGRADOURO: 13,
  LOGRADOURO: 14,
  NUMERO: 15,
  COMPLEMENTO: 16,
  BAIRRO: 17,
  CEP: 18,
  UF: 19,
  MUNICIPIO: 20,
  DDD_1: 21,
  TELEFONE_1: 22,
  EMAIL: 27,
} as const;

export const EMPRESA = {
  CNPJ_BASICO: 0,
  RAZAO_SOCIAL: 1,
  NATUREZA_JURIDICA: 2,
  CAPITAL_SOCIAL: 4,
  PORTE: 5,
} as const;

export const SIMPLES = {
  CNPJ_BASICO: 0,
  OPCAO_SIMPLES: 1,
  OPCAO_MEI: 4,
} as const;

/** Situação cadastral "02" — ativa. The only one worth keeping. */
export const SITUACAO_ATIVA = "02";

/**
 * Splits one Receita line. Fields are semicolon-separated and quoted with `"`,
 * and the quoting is not always well-formed, so this is hand-rolled rather than
 * delegated to a CSV parser that would reject the file outright.
 */
export function splitRfLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ";" && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function csvEscape(v: string): string {
  if (v === "") return "";
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function toCsvLine(fields: (string | null)[]): string {
  return fields.map((f) => (f === null ? "" : csvEscape(f))).join(",") + "\n";
}

/** `20240115` -> `2024-01-15`. Receita writes `0` or `00000000` for "unknown". */
export function rfDate(raw: string | undefined): string | null {
  const d = (raw ?? "").trim();
  if (d.length !== 8 || d === "00000000") return null;
  const y = d.slice(0, 4);
  const m = d.slice(4, 6);
  const day = d.slice(6, 8);
  if (y === "0000" || m === "00" || day === "00") return null;
  return `${y}-${m}-${day}`;
}

/** Receita splits the CNPJ across three columns; the app wants the 14 digits. */
export function fullCnpj(basico: string, ordem: string, dv: string): string {
  return `${basico.padStart(8, "0")}${ordem.padStart(4, "0")}${dv.padStart(2, "0")}`;
}

/** Capital social uses a comma as the decimal separator. */
export function rfDecimal(raw: string | undefined): string | null {
  const v = (raw ?? "").trim().replace(",", ".");
  if (!v || !/^-?\d+(\.\d+)?$/.test(v)) return null;
  return v;
}
