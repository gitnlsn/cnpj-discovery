import {
  classifyReceitaPhone,
  buildWaMeLink,
  FREE_MAIL,
  FREE_MAIL_ANY_TLD,
  TYPO_MAIL,
  INSTITUTIONAL,
  ACCOUNTANT,
  ACCOUNTANT_WORD,
  deriveAddress,
  type DerivedAddress,
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
  /**
   * Also match `cnae` against the company's SECONDARY activities.
   *
   * Off by default, and that default is load-bearing twice over.
   *
   * It changes what the number means. A company whose *principal* activity is
   * what you sell to is not the same prospect as one that lists it third among
   * nine — so the two are counted separately everywhere (see `Reach.principal`
   * and `Reach.secundaria`) and every row says which way it matched.
   *
   * And it changes what the query costs. `cnae_div` is derived from the primary
   * CNAE and is the Parquet partition key, so a secondary match cannot be
   * pruned: measured on part 0, a page of 100 goes from ~52 ms to 485–1117 ms
   * because all 87 partitions have to be opened. That is the right price for a
   * checkbox someone ticked on purpose — it buys +76% to +295% more companies,
   * measured across five real target CNAEs — and the wrong price to charge every
   * query by default.
   */
  includeCnaeSecundaria?: boolean;
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
   * The domain of the registered e-mail, matched exactly.
   *
   * The other reverse bridge from a website back to a CNPJ, and the only one that
   * works for a business found by organic search — where there is no address to
   * match on, unlike a Places result.
   *
   * Recall is low by construction and that is not a defect to fix: by the
   * `ownDomainEmail` comment below, roughly nine in ten micro-businesses
   * registered a free-mail address, so most companies simply cannot be found this
   * way. It is a cheap extra route, not a replacement for the address one.
   */
  emailDomain?: string[];
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
   * CEP prefixes — the territory filter the address columns exist for.
   *
   * A Brazilian CEP narrows geographically from the left: "01" is central São
   * Paulo, "013" narrows further, "01310" is one stretch of Avenida Paulista.
   * Any length works, so the same field serves "this region" and "this street".
   */
  cepPrefix?: string[];
  /** Substring match on the neighbourhood, for a within-city territory. */
  bairro?: string;
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
  /**
   * How this row satisfied the CNAE filter.
   *
   * Always "principal" when `includeCnaeSecundaria` was off, because then it is
   * the only way a row could have matched. When a row matches both ways,
   * "principal" wins: it is the stronger claim about the company, and it is what
   * keeps `principal + secundaria = total` from double-counting.
   */
  cnaeMatch: "principal" | "secundaria";
  /**
   * Which of the company's secondary codes matched the filter.
   *
   * Populated whenever any did — including on a row that also matched as
   * "principal", because a company can genuinely hold the target code both ways
   * and hiding that would be discarding a fact to satisfy a tidier rule. Empty
   * when the filter did not ask about secondary activities at all.
   *
   * The screen shows it next to the badge, where it answers the question the row
   * otherwise raises: `cnae` displays the activity the company registered as
   * PRIMARY, so a secondary match looks like it does not belong until you can
   * see which code brought it in.
   */
  cnaeSecundariaMatch: string[];
  uf: string;
  municipio: string | null;
  bairro: string | null;
  /** The four street columns, verbatim as the Receita writes them. */
  tipoLogradouro: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  cep: string | null;
  /** Derived on read, never stored — same arrangement as `phone`. */
  endereco: DerivedAddress | null;
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
 * A DuckDB LIST as a plain array.
 *
 * The node API hands lists back as `{ items: [...] }`, not as an array, so
 * `Array.isArray` on the raw value is false and a naive cast produces an object
 * that JSON-serialises as `{"items":[…]}` and renders as nothing in the UI.
 */
function listOfStrings(v: unknown): string[] {
  if (v == null) return [];
  const raw = Array.isArray(v) ? v : (v as { items?: unknown[] }).items;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Builds the WHERE clause. Every value is bound, never interpolated — these
 * filters arrive from the browser, and a CNAE is a user-supplied string.
 */
function principalMatchSql(codes: string[], params: unknown[]): string {
  return `(${codes.map((c) => (params.push(`${c}%`), "e.cnae_principal LIKE ?")).join(" OR ")})`;
}

/**
 * The same codes, matched against the secondary-activity list.
 *
 * Split by length on purpose. Every code the Receita writes in this field is
 * exactly 7 digits (measured: 100% of 1.022.785 occurrences), so a 7-digit
 * target is set membership — `list_has_any`, ~90 ms — while a 2-to-6-digit
 * prefix needs a per-element `starts_with`, ~240 ms. Sending everything down the
 * slow path would be paying the prefix price for exact codes.
 *
 * The `::VARCHAR[]` cast is load-bearing: `list_has_any(col, ?)` with an array
 * parameter fails with "Cannot create values of type ANY".
 */
function secundariaMatchSql(codes: string[], params: unknown[]): string {
  const parts: string[] = [];
  const exact = codes.filter((c) => c.length === 7);
  const prefixes = codes.filter((c) => c.length < 7);

  if (exact.length) {
    const list = exact.map((c) => (params.push(c), "?")).join(", ");
    parts.push(`list_has_any(e.cnae_secundaria, [${list}]::VARCHAR[])`);
  }
  if (prefixes.length) {
    const lambda = prefixes.map((c) => (params.push(c), "starts_with(x, ?)")).join(" OR ");
    parts.push(`len(list_filter(e.cnae_secundaria, x -> ${lambda})) > 0`);
  }
  // No codes cannot happen (the caller checks), but an empty OR-list would be a
  // syntax error rather than a no-match, so say "false" out loud.
  return parts.length ? `(${parts.join(" OR ")})` : "false";
}

function where(f: CompanyFilters, params: unknown[]): string {
  const parts: string[] = [];

  if (f.cnae?.length) {
    // Constrain the partition column explicitly. A CNAE prefix always implies
    // its division, and naming it lets DuckDB skip whole directories instead of
    // opening every file to discover the LIKE cannot match.
    const divs = [...new Set(f.cnae.map((c) => c.slice(0, 2)))];
    const pruned =
      `e.cnae_div IN (${divs.map((d) => (params.push(d), "?")).join(", ")})` +
      ` AND ${principalMatchSql(f.cnae, params)}`;

    if (f.includeCnaeSecundaria) {
      // The pruning stays inside its own branch, where it is still a correct
      // predicate, but it stops being a *partition* filter: the secondary branch
      // has no cnae_div to constrain, so every directory is opened either way.
      // That is the cost documented on `includeCnaeSecundaria`, and there is no
      // cleverness available — a two-phase version (narrow scan for ids, then a
      // pruned fetch) was measured at 903–1010 ms against 951–1117 ms for this
      // one, because `cnpj` is unsorted so the second phase prunes nothing.
      parts.push(`((${pruned}) OR ${secundariaMatchSql(f.cnae, params)})`);
    } else {
      parts.push(pruned);
    }
  }
  if (f.emailDomain?.length) {
    // The same expression `ownDomainEmail` already computes below — kept
    // identical so the two filters cannot disagree about what a domain is.
    const domain = `split_part(lower(e.email), '@', 2)`;
    parts.push(
      `${domain} IN (${f.emailDomain.map((d) => (params.push(d.toLowerCase()), "?")).join(", ")})`
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
  // Redundant since the sync started dropping rows with no e-mail: every row in
  // the base has one. Kept so the tRPC input schemas stay stable and an old
  // caller does not start erroring.
  if (f.hasEmail) parts.push(`e.email IS NOT NULL`);
  if (f.matrizOnly) parts.push(`e.is_matriz`);
  if (f.mei === true) parts.push(`e.mei`);
  if (f.mei === false) parts.push(`NOT e.mei`);
  if (f.q) {
    params.push(`%${f.q.toLowerCase()}%`, `%${f.q.toLowerCase()}%`);
    parts.push(`(lower(e.nome_fantasia) LIKE ? OR lower(e.razao_social) LIKE ?)`);
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
    parts.push(`e.porte IN (${f.porte.map((p) => (params.push(p), "?")).join(", ")})`);
  }
  if (f.naturezaPrefix?.length) {
    parts.push(
      `(${f.naturezaPrefix.map((n) => (params.push(`${n}%`), "e.natureza_juridica LIKE ?")).join(" OR ")})`
    );
  }
  if (f.minCapitalSocial !== undefined) {
    params.push(f.minCapitalSocial);
    parts.push(`e.capital_social >= ?`);
  }
  if (f.cepPrefix?.length) {
    // Digits only on both sides: 3,2% of rows hold a CEP that is not eight
    // digits, and the operator may well type "01310-100".
    const clean = `regexp_replace(e.cep, '[^0-9]', '', 'g')`;
    parts.push(
      `(${f.cepPrefix
        .map((c) => (params.push(`${c.replace(/\D/g, "")}%`), `${clean} LIKE ?`))
        .join(" OR ")})`
    );
  }
  if (f.bairro) {
    params.push(`%${f.bairro.toLowerCase()}%`);
    parts.push(`lower(strip_accents(e.bairro)) LIKE lower(strip_accents(?))`);
  }

  return parts.length ? `WHERE ${parts.join("\n    AND ")}` : "";
}

const ORDER_SQL: Record<CompanyOrder, string> = {
  // NULLS LAST matters: a missing start date must not outrank a real one.
  "founded-desc": "e.data_inicio_atividade DESC NULLS LAST",
  "founded-asc": "e.data_inicio_atividade ASC NULLS LAST",
  name: "coalesce(e.nome_fantasia, e.razao_social) ASC NULLS LAST",
  "capital-desc": "e.capital_social DESC NULLS LAST",
};

// No joins. Razão social, porte, capital, natureza, simples and MEI are folded
// into each establishments row by the sync, which is why `emp.`/`s.` prefixes are
// gone from this file: `empresas` was unpartitioned, so every discovery query
// used to scan all 47 M of it to decorate at most a page of results.
const FROM = `
  FROM estabelecimentos e
`;

/**
 * The two match-origin columns, and the reason they are built rather than fixed.
 *
 * DuckDB binds `?` by position in the SQL *text*, and these sit in the SELECT
 * list — before the WHERE clause. So whoever assembles a query has to push these
 * parameters FIRST. Getting that backwards does not fail loudly: it silently
 * shifts every parameter by two and the filter starts answering a different
 * question. Hence one function that owns both the SQL and its parameters.
 */
function cnaeMatchColumns(f: CompanyFilters, params: unknown[]): string {
  if (!f.cnae?.length || !f.includeCnaeSecundaria) {
    // Nothing to decide: without the flag, matching by primary CNAE is the only
    // way a row could be here at all.
    return `'principal' AS cnae_match, NULL AS cnae_secundaria_match`;
  }
  const principal = principalMatchSql(f.cnae, params);
  // `starts_with` covers both cases uniformly: for a 7-digit code it is
  // equality, for a prefix it is the prefix test.
  const lambda = f.cnae.map((c) => (params.push(c), "starts_with(x, ?)")).join(" OR ");
  return (
    `CASE WHEN ${principal} THEN 'principal' ELSE 'secundaria' END AS cnae_match,\n` +
    `      list_filter(e.cnae_secundaria, x -> ${lambda}) AS cnae_secundaria_match`
  );
}

const SELECT_COLUMNS = `
      e.cnpj, e.nome_fantasia, e.cnae_principal, e.uf, e.bairro,
      e.tipo_logradouro, e.logradouro, e.numero, e.complemento, e.cep,
      e.data_inicio_atividade, e.ddd, e.telefone, e.email,
      e.razao_social, e.porte, e.capital_social, e.natureza_juridica,
      e.mei, e.simples,
      c.descricao AS cnae_descricao,
      m.descricao AS municipio
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
  const raw = {
    tipoLogradouro: r.tipo_logradouro as string | null,
    logradouro: r.logradouro as string | null,
    numero: r.numero as string | null,
    complemento: r.complemento as string | null,
    bairro: r.bairro as string | null,
    municipio: r.municipio as string | null,
    uf: r.uf as string | null,
    cep: r.cep as string | null,
  };
  return {
    cnpj: String(r.cnpj),
    razaoSocial: (r.razao_social as string) ?? null,
    nomeFantasia: (r.nome_fantasia as string) ?? null,
    cnae: String(r.cnae_principal),
    cnaeDescricao: (r.cnae_descricao as string) ?? null,
    cnaeMatch: r.cnae_match === "secundaria" ? "secundaria" : "principal",
    cnaeSecundariaMatch: listOfStrings(r.cnae_secundaria_match),
    uf: String(r.uf),
    municipio: (r.municipio as string) ?? null,
    bairro: (r.bairro as string) ?? null,
    tipoLogradouro: (r.tipo_logradouro as string) ?? null,
    logradouro: (r.logradouro as string) ?? null,
    numero: (r.numero as string) ?? null,
    complemento: (r.complemento as string) ?? null,
    cep: (r.cep as string) ?? null,
    endereco: deriveAddress(raw),
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
  // Order matters and is not obvious: these appear earlier in the SQL text than
  // the WHERE clause, so their parameters have to be pushed first.
  const matchColumns = cnaeMatchColumns(opts.filters, params);
  const clause = where(opts.filters, params);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);

  const rows = await query<Record<string, unknown>>(
    `
    SELECT ${SELECT_COLUMNS},
      ${matchColumns}
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
  /** Always equal to `total`: the sync drops establishments with no e-mail. */
  withEmail: number;
  /** Opened in the last 24 months — the segment worth approaching first. */
  recent: number;
  /**
   * The split behind `total`, and it is a split rather than two overlapping
   * numbers: `principal + secundaria === total`, always.
   *
   * A row matching both ways counts as principal, so "63 principal + 412
   * secundário" can be read as a sum without either number containing the other.
   * With `includeCnaeSecundaria` off, `secundaria` is 0 — not because nobody has
   * secondary activities, but because nobody was asked about them.
   */
  principal: number;
  secundaria: number;
}

/**
 * The `principal`/`secundaria` halves of a count, disjoint by construction.
 *
 * `e.cnae_principal` is never NULL — the sync drops rows with an empty primary
 * CNAE — so `NOT (...)` is a real complement here and not a three-valued trap.
 */
function reachSplitColumns(f: CompanyFilters, params: unknown[]): string {
  if (!f.cnae?.length || !f.includeCnaeSecundaria) {
    return `count(*) AS principal, 0 AS secundaria`;
  }
  const principal = principalMatchSql(f.cnae, params);
  // Built twice rather than aliased: DuckDB has no LATERAL alias usable inside
  // FILTER here, and duplicating the predicate costs a second cheap LIKE per row
  // against the ~1 s the surrounding scan already costs.
  const principalAgain = principalMatchSql(f.cnae, params);
  return (
    `count(*) FILTER (WHERE ${principal}) AS principal,\n` +
    `      count(*) FILTER (WHERE NOT ${principalAgain}) AS secundaria`
  );
}

/** How many companies a filter actually reaches. One scan, no rows returned. */
export async function countReach(filters: CompanyFilters): Promise<Reach> {
  const params: unknown[] = [];
  // Again: earlier in the text than the WHERE clause, so pushed first.
  const split = reachSplitColumns(filters, params);
  const clause = where(filters, params);
  const [row] = await query<Record<string, unknown>>(
    `
    SELECT
      count(*)                                                        AS total,
      ${split},
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
    principal: num(row?.principal),
    secundaria: num(row?.secundaria),
  };
}

export interface CnaeReach {
  codigo: string;
  descricao: string | null;
  /**
   * Companies whose PRIMARY activity is this code. Unchanged in meaning.
   *
   * Deliberately not widened to include secondary matches: these three numbers
   * decide `cnae_picks.status === 'empty'` and are what every stored
   * `reach_total` already means. Inflating them would rewrite history — a pick
   * saved last week would silently start claiming a different reach.
   */
  total: number;
  withPhone: number;
  recent: number;
  /**
   * Companies that hold this code as a SECONDARY activity and NOT as primary.
   *
   * Disjoint from `total` for the same reason as `Reach.secundaria`, so the two
   * can be shown side by side and added. Zero when the caller did not ask for
   * secondary matching — which is not the same as "nobody holds it", and the UI
   * has to render those two differently.
   */
  secundaria: number;
  secundariaWithPhone: number;
  secundariaRecent: number;
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

  // The primary numbers stay one pruned query per code — 5–13 ms each, so a
  // picker with twenty codes is still imperceptible, and the numbers are
  // byte-for-byte what they were before this feature existed.
  for (const code of codes) {
    const reach = await countReach({ ...filters, cnae: [code], includeCnaeSecundaria: false });
    out.push({
      codigo: code,
      descricao: await describeCnae(code),
      total: reach.total,
      withPhone: reach.withPhone,
      recent: reach.recent,
      secundaria: 0,
      secundariaWithPhone: 0,
      secundariaRecent: 0,
    });
  }

  if (!filters.includeCnaeSecundaria) return out;

  // The secondary numbers do NOT get the same treatment. Per-code they would be
  // one unprunable scan each — twenty of them measured 1,3 s of scan alone — so
  // they are computed for every code at once, in a query whose cost does not
  // grow with the number of codes. One pass per distinct code length, which in
  // practice is one or two.
  const byLength = new Map<number, string[]>();
  for (const code of codes) {
    const group = byLength.get(code.length);
    if (group) group.push(code);
    else byLength.set(code.length, [code]);
  }

  const index = new Map(out.map((r) => [r.codigo, r]));
  for (const [length, group] of byLength) {
    for (const row of await secundariaReach(group, length, filters)) {
      const target = index.get(row.codigo);
      if (!target) continue;
      target.secundaria = row.total;
      target.secundariaWithPhone = row.withPhone;
      target.secundariaRecent = row.recent;
    }
  }

  return out;
}

/**
 * Secondary reach for a set of same-length codes, in one pass.
 *
 * Each row's secondary list is truncated to the target length and unnested, so a
 * company holding both 8599604 and 8599605 is counted ONCE under "8599" —
 * `list_distinct` on the truncated codes is what makes this count companies
 * rather than code occurrences.
 *
 * `NOT starts_with(cnae_principal, pfx)` is what keeps the result disjoint from
 * the primary count, so the two add up instead of overlapping.
 */
async function secundariaReach(
  codes: string[],
  length: number,
  filters: CompanyFilters
): Promise<{ codigo: string; total: number; withPhone: number; recent: number }[]> {
  // Interpolated, not bound — a slice bound cannot be a parameter in DuckDB. So
  // it is clamped to the range a CNAE code can actually have rather than
  // trusted: this file's own rule is that a CNAE arrives as a user-supplied
  // string, and the only safe interpolation is one that cannot carry text.
  const slice = Math.min(Math.max(Math.trunc(length), 2), 7);
  const params: unknown[] = [];
  // The CNAE filter is deliberately dropped from the inner clause: this query
  // groups BY the code, so constraining to one would defeat the whole point.
  const clause = where({ ...filters, cnae: undefined, includeCnaeSecundaria: false }, params);
  const inner = clause
    ? `${clause} AND e.cnae_secundaria IS NOT NULL`
    : `WHERE e.cnae_secundaria IS NOT NULL`;
  const wanted = codes.map((c) => (params.push(c), "?")).join(", ");

  const rows = await query<Record<string, unknown>>(
    `
    SELECT
      pfx AS codigo,
      count(*) FILTER (WHERE NOT starts_with(e.cnae_principal, pfx)) AS total,
      count(*) FILTER (
        WHERE NOT starts_with(e.cnae_principal, pfx)
          AND e.ddd IS NOT NULL AND e.telefone IS NOT NULL
      ) AS with_phone,
      count(*) FILTER (
        WHERE NOT starts_with(e.cnae_principal, pfx)
          AND e.data_inicio_atividade >= current_date - INTERVAL 24 MONTH
      ) AS recent
    FROM (
      SELECT
        e.cnae_principal, e.ddd, e.telefone, e.data_inicio_atividade,
        unnest(list_distinct(list_transform(e.cnae_secundaria, x -> x[1:${slice}]))) AS pfx
      FROM estabelecimentos e
      ${inner}
    ) e
    WHERE pfx IN (${wanted})
    GROUP BY pfx
    `,
    params
  );

  return rows.map((r) => ({
    codigo: String(r.codigo),
    total: num(r.total),
    withPhone: num(r.with_phone),
    recent: num(r.recent),
  }));
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

/** One business we found on the open internet, in the form a lookup can use. */
export interface AddressProbe {
  /** Caller's own key, echoed back so a hit can be attached to the right lead. */
  ref: string;
  /** Street name WITHOUT the type, unaccented upper case. See `parseMapsAddress`. */
  logradouro: string;
  /** Street number. Compared digits-only, so "1890 B" is fine. */
  numero: string | null;
  /** Two-letter UF. Required: without it this is a national scan per probe. */
  uf?: string | null;
}

export interface AddressLookup {
  ref: string;
  /** Companies registered at that street and number. */
  companies: Company[];
  /**
   * More companies share this address than could identify a business.
   *
   * Measured, and it is not a rare edge case: one sampled address had **1.985**
   * active establishments on it. An office tower is one address and hundreds of
   * companies, so past a handful the address has stopped being evidence and the
   * caller must not pick one.
   */
  ambiguous: boolean;
  /** Why no lookup was attempted. Absent when one was. */
  skipped?: "sem-numero" | "rua-curta" | "sem-uf";
}

/**
 * Past this many companies at one address, the address identifies a building
 * rather than a business.
 */
const ADDRESS_AMBIGUOUS_AT = 12;

/** Below this, a street name is too generic to be a key ("B", "A", "DAS FLORES"). */
const MIN_STREET_TOKEN_CHARS = 4;

/**
 * Companies at a given street and number, for a whole batch in ONE scan.
 *
 * This is the bridge the open-internet sweep needs and the Receita almost does not
 * offer. There is no website column, and the e-mail domain — the only other
 * reverse route — is a free-mail address for roughly nine in ten
 * micro-businesses. A street plus a number is the one identifier a Google Maps
 * card and a Receita row reliably share.
 *
 * **The key is the number, the UF, and the LAST token of the street** — not the
 * street as written. That choice is measured, not stylistic: Maps writes
 * "Av. Pres. Kennedy" where the Receita stores "PRESIDENTE KENNEDY", so exact
 * matching misses and prefix matching misses too ("PRES KENNEDY" does not prefix
 * "PRESIDENTE KENNEDY"). The last token is the distinctive proper name and it
 * survives every abbreviation of the honorific in front of it. On the three real
 * addresses this was checked against it returned 1, 3 and 2 companies in about
 * 200 ms, against 1.985 for the prefix version that was here first.
 *
 * Batched deliberately, and that is load-bearing. There is no CNAE here to
 * constrain, so `cnae_div` cannot prune and all 87 partitions are opened. Once
 * per sweep that is fine; once per business it would make the job unusable.
 * Measured on 40 probes in one scan: 1.491 ms total, ~37 ms amortised each.
 *
 * Recall on the same run, using real Receita addresses as probes, was 33 of 40 —
 * and the seven that missed were all `ambiguous` or `skipped`, i.e. they said so.
 * That is the property worth having: this function loses matches, but it never
 * loses them quietly.
 *
 * Precision is finished by the caller ON PURPOSE. This answers "which companies
 * are registered there", which is not "which one is this business" — that needs
 * the name, and it lives in `verifyMirrorLink` where it can be tested without a
 * database.
 */
export async function findByAddress(probes: AddressProbe[]): Promise<AddressLookup[]> {
  if (probes.length === 0) return [];

  const out = new Map<string, AddressLookup>();
  const usable: { probe: AddressProbe; digits: string; lastToken: string; uf: string }[] = [];

  for (const probe of probes) {
    const digits = (probe.numero ?? "").replace(/\D/g, "");
    const tokens = probe.logradouro.split(/\s+/).filter(Boolean);
    const lastToken = tokens.at(-1) ?? "";
    const uf = probe.uf?.toUpperCase() ?? "";

    // Every skip is named. "We could not look" must never reach the caller
    // wearing the same clothes as "we looked and found nobody".
    const skipped: AddressLookup["skipped"] | undefined = !digits
      ? "sem-numero"
      : lastToken.length < MIN_STREET_TOKEN_CHARS
        ? "rua-curta"
        : !uf
          ? "sem-uf"
          : undefined;

    if (skipped) {
      out.set(probe.ref, { ref: probe.ref, companies: [], ambiguous: false, skipped });
      continue;
    }
    out.set(probe.ref, { ref: probe.ref, companies: [], ambiguous: false });
    usable.push({ probe, digits, lastToken, uf });
  }

  if (!usable.length) return [...out.values()];

  const params: unknown[] = [];
  const branches = usable.map(({ digits, lastToken, uf }) => {
    params.push(digits, uf, lastToken);
    return `(regexp_replace(e.numero, '[^0-9]', '', 'g') = ? AND e.uf = ? AND ends_with(e.logradouro, ?))`;
  });

  const rows = await query<Record<string, unknown>>(
    `
    SELECT ${SELECT_COLUMNS},
      'principal' AS cnae_match, NULL AS cnae_secundaria_match
    ${FROM}
    ${JOIN_LABELS}
    WHERE ${branches.join(" OR ")}
    `,
    params
  );

  // One scan cannot label its own OR branches, so each row is attributed here
  // using the same three normalised fields the SQL matched on.
  for (const row of rows) {
    const company = toCompany(row);
    const numero = (company.numero ?? "").replace(/\D/g, "");
    const logradouro = company.logradouro ?? "";
    for (const { probe, digits, lastToken, uf } of usable) {
      if (numero !== digits) continue;
      if (company.uf !== uf) continue;
      if (!logradouro.endsWith(lastToken)) continue;
      const entry = out.get(probe.ref)!;
      // Counting past the cap would mean holding a tower's worth of rows to
      // conclude "too many"; the flag is the answer, so stop collecting.
      if (entry.companies.length >= ADDRESS_AMBIGUOUS_AT) entry.ambiguous = true;
      else entry.companies.push(company);
    }
  }

  return [...out.values()];
}

/**
 * Companies whose registered e-mail is on one of these domains, in ONE scan.
 *
 * Batched for the same reason `findByAddress` is: no CNAE means no partition
 * pruning, so this opens all 87 directories. Once per sweep is fine; once per
 * business would not be.
 */
export async function findByEmailDomain(domains: string[]): Promise<Company[]> {
  const clean = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) return [];
  return listCompanies({ filters: { emailDomain: clean }, limit: 1000 });
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
