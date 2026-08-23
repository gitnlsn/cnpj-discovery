import {
  classifyReceitaPhone,
  buildWaMeLink,
  FREE_MAIL,
  FREE_MAIL_ANY_TLD,
  TYPO_MAIL,
  INSTITUTIONAL,
  ACCOUNTANT,
  ACCOUNTANT_WORD,
} from "@cnpj/core/domain";
import { query } from "./duck";

/**
 * The Receita base, queried like an API.
 *
 * There is no paid search-by-CNAE endpoint in existence that is free, so this
 * is the substitute: the monthly bulk files, filtered on the way in and read
 * back with DuckDB. Filters and ordering are real SQL, not a vendor's idea of
 * what you might want to sort by.
 */

export interface CompanyFilters {
  /** CNAE codes or prefixes. "8599" matches every 8599xxx. */
  cnae?: string[];
  uf?: string[];
  municipioRf?: string[];
  /** Only companies whose activity started on or after this ISO date. */
  foundedFrom?: string;
  foundedTo?: string;
  hasPhone?: boolean;
  hasEmail?: boolean;
  /** Exclude MEIs, or keep only them. */
  mei?: boolean;
  /** Headquarters only — filiais repeat the parent's phone and site. */
  matrizOnly?: boolean;
  /** Substring match on nome fantasia / razão social. */
  q?: string;
  /**
   * E-mail on a domain the company plausibly owns.
   *
   * The single best predictor of whether a website can be found for free: the
   * Receita has no website column, and an own-domain address IS the domain.
   * A gmail address tells you nothing, and roughly nine in ten micro-businesses
   * registered one.
   */
  ownDomainEmail?: boolean;
  /**
   * Mobile line, using the same nono-dígito repair the display uses.
   *
   * Approximate on one point: this does not validate the area code, so a row
   * with a bogus DDD can pass here and still render as "no phone".
   */
  isMobile?: boolean;
  /** Company size band: 01 não informado · 02 micro · 03 pequena · 05 demais. */
  porte?: string[];
  /** Legal-nature prefixes, e.g. "2" for private companies, "3" nonprofits. */
  naturezaPrefix?: string[];
  minCapitalSocial?: number;
  /**
   * CNPJs to leave out — the ones already in the project.
   *
   * Without it the "add" list keeps offering companies that are already there,
   * and re-adding one is a no-op that looks like a bug.
   */
  excludeCnpjs?: string[];
}

export type CompanyOrder = "founded-desc" | "founded-asc" | "name" | "capital-desc";

export interface Company {
  cnpj: string;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  cnae: string;
  cnaeDescricao: string | null;
  uf: string;
  municipio: string | null;
  bairro: string | null;
  dataInicioAtividade: string | null;
  porte: string | null;
  capitalSocial: number | null;
  naturezaJuridica: string | null;
  mei: boolean;
  simples: boolean;
  email: string | null;
  /** Derived, never stored in the Parquet: E.164 + line type + wa.me link. */
  phone: { e164: string; isMobile: boolean; waMe: string } | null;
}

/**
 * DuckDB hands dates back as a day count and integers as BigInt. Both have to
 * be converted before they cross into tRPC, which cannot serialise BigInt.
 */
function isoDate(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "object" && v !== null && "days" in v) {
    const days = Number((v as { days: number | bigint }).days);
    return new Date(days * 86_400_000).toISOString().slice(0, 10);
  }
  return String(v);
}

const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));

/**
 * Builds the WHERE clause. Every value is bound, never interpolated — these
 * filters arrive from the browser, and a CNAE is a user-supplied string.
 */
function where(f: CompanyFilters, params: unknown[]): string {
  const parts: string[] = [];

  if (f.cnae?.length) {
    // Constrain the partition column explicitly. A CNAE prefix always implies
    // its division, and naming it lets DuckDB skip whole directories instead of
    // opening every file to discover the LIKE cannot match.
    const divs = [...new Set(f.cnae.map((c) => c.slice(0, 2)))];
    parts.push(`e.cnae_div IN (${divs.map((d) => (params.push(d), "?")).join(", ")})`);
    parts.push(
      `(${f.cnae.map((c) => (params.push(`${c}%`), "e.cnae_principal LIKE ?")).join(" OR ")})`
    );
  }
  if (f.uf?.length) {
    parts.push(`e.uf IN (${f.uf.map((u) => (params.push(u), "?")).join(", ")})`);
  }
  if (f.municipioRf?.length) {
    parts.push(`e.municipio_rf IN (${f.municipioRf.map((m) => (params.push(m), "?")).join(", ")})`);
  }
  if (f.foundedFrom) {
    params.push(f.foundedFrom);
    parts.push(`e.data_inicio_atividade >= CAST(? AS DATE)`);
  }
  if (f.foundedTo) {
    params.push(f.foundedTo);
    parts.push(`e.data_inicio_atividade <= CAST(? AS DATE)`);
  }
  if (f.hasPhone) parts.push(`e.ddd IS NOT NULL AND e.telefone IS NOT NULL`);
  if (f.hasEmail) parts.push(`e.email IS NOT NULL`);
  if (f.matrizOnly) parts.push(`e.is_matriz`);
  if (f.mei === true) parts.push(`coalesce(s.mei, false)`);
  if (f.mei === false) parts.push(`NOT coalesce(s.mei, false)`);
  if (f.q) {
    params.push(`%${f.q.toLowerCase()}%`, `%${f.q.toLowerCase()}%`);
    parts.push(`(lower(e.nome_fantasia) LIKE ? OR lower(emp.razao_social) LIKE ?)`);
  }

  if (f.excludeCnpjs?.length) {
    parts.push(
      `e.cnpj NOT IN (${f.excludeCnpjs.map((c) => (params.push(c), "?")).join(", ")})`
    );
  }
  if (f.ownDomainEmail) {
    // Must agree with `websiteFromEmail`, which is what actually decides whether
    // a URL gets visited. Filtering on free-mail alone was not enough: measured
    // on CNAE 8599, 43% of the rows it passed were accounting-office domains
    // (contabilizei.com.br, contabilidademattos.com.br…) that the crawler then
    // refused, so the filter promised a reachable site and delivered the
    // accountant's. The patterns come from the same module the crawler uses, so
    // the two cannot drift apart.
    const domain = `split_part(lower(e.email), '@', 2)`;
    const domains = [...FREE_MAIL];
    parts.push(
      [
        `e.email IS NOT NULL`,
        `${domain} LIKE '%.%'`,
        `length(${domain}) >= 5`,
        `${domain} NOT IN (${domains.map((d) => (params.push(d), "?")).join(", ")})`,
        `NOT regexp_matches(${domain}, ?)`,
        `${domain} NOT LIKE '%.gov.br'`,
        `${domain} NOT LIKE '%.cnt.br'`,
        // A consumer provider on any suffix, and an institution's own domain.
        // Both were added after the crawler learned to refuse them and this
        // filter did not — which is precisely the drift the test in
        // `test/receita.ts` exists to catch, and did.
        `NOT regexp_matches(${domain}, ?)`,
        `NOT regexp_matches(${domain}, ?)`,
        `NOT regexp_matches(${domain}, ?)`,
        `NOT regexp_matches(${domain}, ?)`,
      ].join(" AND ")
    );
    params.push(
      TYPO_MAIL.source,
      FREE_MAIL_ANY_TLD.source,
      INSTITUTIONAL.source,
      ACCOUNTANT.source,
      ACCOUNTANT_WORD.source
    );
  }
  if (f.isMobile) {
    // Same rule as normalizeBrazilianLocal: nine digits starting 9, or the
    // pre-2016 eight-digit form starting 6-9.
    parts.push(
      `((length(e.telefone) = 9 AND e.telefone LIKE '9%') OR ` +
        `(length(e.telefone) = 8 AND regexp_matches(e.telefone, '^[6-9]')))`
    );
  }
  if (f.porte?.length) {
    parts.push(`emp.porte IN (${f.porte.map((p) => (params.push(p), "?")).join(", ")})`);
  }
  if (f.naturezaPrefix?.length) {
    parts.push(
      `(${f.naturezaPrefix.map((n) => (params.push(`${n}%`), "emp.natureza_juridica LIKE ?")).join(" OR ")})`
    );
  }
  if (f.minCapitalSocial !== undefined) {
    params.push(f.minCapitalSocial);
    parts.push(`emp.capital_social >= ?`);
  }

  return parts.length ? `WHERE ${parts.join("\n    AND ")}` : "";
}

const ORDER_SQL: Record<CompanyOrder, string> = {
  // NULLS LAST matters: a missing start date must not outrank a real one.
  "founded-desc": "e.data_inicio_atividade DESC NULLS LAST",
  "founded-asc": "e.data_inicio_atividade ASC NULLS LAST",
  name: "coalesce(e.nome_fantasia, emp.razao_social) ASC NULLS LAST",
  "capital-desc": "emp.capital_social DESC NULLS LAST",
};

const FROM = `
  FROM estabelecimentos e
  LEFT JOIN empresas emp ON emp.cnpj_basico = e.cnpj_basico
  LEFT JOIN simples  s   ON s.cnpj_basico   = e.cnpj_basico
`;

const SELECT_COLUMNS = `
      e.cnpj, e.nome_fantasia, e.cnae_principal, e.uf, e.bairro,
      e.data_inicio_atividade, e.ddd, e.telefone, e.email,
      emp.razao_social, emp.porte, emp.capital_social, emp.natureza_juridica,
      coalesce(s.mei, false)     AS mei,
      coalesce(s.simples, false) AS simples,
      c.descricao                AS cnae_descricao,
      m.descricao                AS municipio
`;

const JOIN_LABELS = `
  LEFT JOIN cnaes c      ON c.codigo = e.cnae_principal
  LEFT JOIN municipios m ON m.codigo = e.municipio_rf
`;

function toCompany(r: Record<string, unknown>): Company {
  const ddd = r.ddd as string | null;
  const tel = r.telefone as string | null;
  // The phone is classified on read, not stored. `classifyReceitaPhone` repairs
  // the pre-2016 eight-digit format first; without that, ~70% of the mobiles in
  // this base read as landlines.
  const classified = ddd && tel ? classifyReceitaPhone(ddd, tel) : null;
  return {
    cnpj: String(r.cnpj),
    razaoSocial: (r.razao_social as string) ?? null,
    nomeFantasia: (r.nome_fantasia as string) ?? null,
    cnae: String(r.cnae_principal),
    cnaeDescricao: (r.cnae_descricao as string) ?? null,
    uf: String(r.uf),
    municipio: (r.municipio as string) ?? null,
    bairro: (r.bairro as string) ?? null,
    dataInicioAtividade: isoDate(r.data_inicio_atividade),
    porte: (r.porte as string) ?? null,
    capitalSocial: r.capital_social == null ? null : Number(r.capital_social),
    naturezaJuridica: (r.natureza_juridica as string) ?? null,
    mei: Boolean(r.mei),
    simples: Boolean(r.simples),
    email: (r.email as string) ?? null,
    phone: classified ? { ...classified, waMe: buildWaMeLink(classified.e164) } : null,
  };
}

export async function listCompanies(opts: {
  filters: CompanyFilters;
  order?: CompanyOrder;
  limit?: number;
  offset?: number;
}): Promise<Company[]> {
  const params: unknown[] = [];
  const clause = where(opts.filters, params);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);

  const rows = await query<Record<string, unknown>>(
    `
    SELECT ${SELECT_COLUMNS}
    ${FROM}
    ${JOIN_LABELS}
    ${clause}
    ORDER BY ${ORDER_SQL[opts.order ?? "founded-desc"]}
    LIMIT ${limit} OFFSET ${offset}
    `,
    params
  );

  return rows.map(toCompany);
}

export interface Reach {
  total: number;
  withPhone: number;
  withEmail: number;
  /** Opened in the last 24 months — the segment worth approaching first. */
  recent: number;
}

/** How many companies a filter actually reaches. One scan, no rows returned. */
export async function countReach(filters: CompanyFilters): Promise<Reach> {
  const params: unknown[] = [];
  const clause = where(filters, params);
  const [row] = await query<Record<string, unknown>>(
    `
    SELECT
      count(*)                                                        AS total,
      count(*) FILTER (WHERE e.ddd IS NOT NULL AND e.telefone IS NOT NULL) AS with_phone,
      count(*) FILTER (WHERE e.email IS NOT NULL)                     AS with_email,
      count(*) FILTER (
        WHERE e.data_inicio_atividade >= current_date - INTERVAL 24 MONTH
      )                                                               AS recent
    ${FROM}
    ${clause}
    `,
    params
  );
  return {
    total: num(row?.total),
    withPhone: num(row?.with_phone),
    withEmail: num(row?.with_email),
    recent: num(row?.recent),
  };
}

export interface CnaeReach {
  codigo: string;
  descricao: string | null;
  total: number;
  withPhone: number;
  recent: number;
}

/**
 * Reach for a set of CNAE codes at once, for the discovery tab.
 *
 * A code the model invented comes back with `descricao: null` and `total: 0`,
 * which is exactly the distinction the UI has to draw — a CNAE that does not
 * exist is a different fact from a CNAE with no companies in it.
 */
export async function cnaeReach(codes: string[], filters: CompanyFilters = {}): Promise<CnaeReach[]> {
  if (codes.length === 0) return [];
  const out: CnaeReach[] = [];
  for (const code of codes) {
    const reach = await countReach({ ...filters, cnae: [code] });
    out.push({
      codigo: code,
      descricao: await describeCnae(code),
      total: reach.total,
      withPhone: reach.withPhone,
      recent: reach.recent,
    });
  }
  return out;
}

/**
 * Resolves a CNAE code OR prefix to an official description.
 *
 * The dictionary holds only 7-digit leaf codes, but the model legitimately
 * answers with 4-digit groups like "8599". Treating those as unknown accuses a
 * valid prefix of being invented — the exact opposite of the error this check
 * exists to catch — so a prefix is described by rolling up the subclasses under
 * it. Only a code with no exact row AND no subclasses is genuinely made up.
 */
export async function describeCnae(code: string): Promise<string | null> {
  const [exact] = await query<{ descricao: string }>(
    `SELECT descricao FROM cnaes WHERE codigo = ? LIMIT 1`,
    [code]
  );
  if (exact?.descricao) return exact.descricao;

  const children = await query<{ descricao: string }>(
    `SELECT descricao FROM cnaes WHERE codigo LIKE ? ORDER BY codigo LIMIT 6`,
    [`${code}%`]
  );
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!.descricao;

  const shown = children.slice(0, 3).map((c) => c.descricao).join("; ");
  return `${children.length}${children.length >= 6 ? "+" : ""} subclasses — ${shown}${
    children.length > 3 ? "; …" : ""
  }`;
}

/**
 * The official CNAE dictionary — what the model's suggestions get checked
 * against, and what the "add a CNAE" box searches.
 *
 * Accent-insensitive on purpose: nobody types "Educação" into a search box, and
 * matching only the accented form makes the whole dictionary feel empty. The
 * ordering puts code matches first so typing digits behaves like a code lookup
 * and typing words behaves like a search.
 */
export async function searchCnaes(
  q: string,
  limit = 25
): Promise<{ codigo: string; descricao: string }[]> {
  const term = q.trim();
  if (!term) return [];
  return query<{ codigo: string; descricao: string }>(
    `SELECT codigo, descricao
     FROM cnaes
     WHERE codigo LIKE ?
        OR lower(strip_accents(descricao)) LIKE lower(strip_accents(?))
     ORDER BY (codigo LIKE ?) DESC, codigo
     LIMIT ${Math.min(Math.max(limit, 1), 200)}`,
    [`${term}%`, `%${term}%`, `${term}%`]
  );
}

export async function listCompaniesByCnpj(cnpjs: string[]): Promise<Company[]> {
  if (cnpjs.length === 0) return [];
  const params: unknown[] = [];
  const placeholders = cnpjs.map((c) => (params.push(c), "?")).join(", ");
  const rows = await query<Record<string, unknown>>(
    `
    SELECT ${SELECT_COLUMNS}
    ${FROM}
    ${JOIN_LABELS}
    WHERE e.cnpj IN (${placeholders})
    `,
    params
  );
  return rows.map(toCompany);
}

export async function getCompany(cnpj: string): Promise<Company | null> {
  const [row] = await listCompaniesByCnpj([cnpj]);
  return row ?? null;
}
