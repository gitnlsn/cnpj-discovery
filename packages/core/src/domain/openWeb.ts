import { apexOf } from "./hosts";
import { companyNameTokens, MIN_COMPANY_TOKENS } from "./linkedin";
import { unaccent } from "./probes";
import type { ProjectSpec } from "./spec";

/**
 * The open-internet sweep, decided in pure functions.
 *
 * The direction is the opposite of everything else here. The rest of the project
 * starts from a company the Receita told us about and looks for its website; this
 * starts from a website and asks which company — if any — it belongs to.
 *
 * That inversion breaks the one mechanism the presence search leans on. Every
 * gate in `verifyHits` answers "is this page about the company we already know
 * about", and here there is no such company: `matchStrength`, `isNameMatch`,
 * `titleLeadsWithName` all need a name to check against. So precision has to come
 * from somewhere else, and it costs more — a crawl and a model call instead of a
 * free string comparison. That is the real price of this feature, and the reason
 * the sweep is capped rather than run flat out.
 */

// ---------------------------------------------------------------------------
// Planning the queries
// ---------------------------------------------------------------------------

/** One planned query, with what it was built from, so a sweep can be audited. */
export interface DiscoveryQuery {
  /** Exactly what gets sent to the engine. */
  query: string;
  /** The activity term, as it came from the CNAE label or a probe. */
  term: string;
  /** "Município UF", or a bare UF, or empty when the project has no geography. */
  place: string;
}

/** How long an activity term may be before it stops being a search and becomes a sentence. */
const MAX_TERM_WORDS = 6;

/**
 * A CNAE description reduced to something a person would type.
 *
 * Two shapes arrive here. A leaf description is already close ("Ensino médio"),
 * but `describeCnae` also synthesises a roll-up for a prefix — "3 subclasses —
 * a; b; c" — and searching for that verbatim finds nothing at all. The roll-up is
 * split into its parts rather than dropped, because those parts are exactly the
 * activity names wanted.
 */
export function termsFromCnaeLabel(label: string | null | undefined): string[] {
  if (!label) return [];
  const body = label.includes("—") ? label.slice(label.indexOf("—") + 1) : label;
  return body
    .split(";")
    .map((part) =>
      part
        // Parenthetical qualifiers are legal precision, not search terms:
        // "Cursos preparatórios (exceto ...)" only narrows for a bureaucrat.
        .replace(/\([^)]*\)/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .map((part) => part.split(/\s+/).slice(0, MAX_TERM_WORDS).join(" "))
    .filter((part) => part.split(/\s+/).length >= 1 && part.length >= 4);
}

/**
 * The queries a sweep will spend its budget on.
 *
 * Deterministic, and no model involved. At a dozen queries a day the operator has
 * to be able to read the plan before approving the spend, and a query somebody
 * can inspect beats a cleverer one nobody can predict. The same spec always plans
 * the same sweep, which is also what makes the "we already ran this" record work.
 *
 * Interleaved breadth-first across terms rather than depth-first across places:
 * with a budget of twelve, twelve different activities in the main city tells you
 * far more about where the leads are than one activity in twelve cities.
 */
export function buildDiscoveryQueries(input: {
  spec: ProjectSpec;
  /** Official CNAE descriptions for the chosen codes. */
  cnaeLabels: string[];
  /** "Município UF" strings, most common first. Falls back to the spec's UFs. */
  places: string[];
  max: number;
  /**
   * Drop the geography entirely and ask nationally.
   *
   * Worth having as a deliberate choice because the places passed in come from
   * the project's OWN companies — that is where it has already been looking. Left
   * alone, a sweep can only ever find businesses in the same cities, which is the
   * opposite of what a discovery tab is for.
   *
   * The trade is real and goes both ways: 20 results per call is a hard cap either
   * way, so a national query does not return more, it returns a set Google chose
   * the geography for. Predictable coverage versus reach.
   */
  nationwide?: boolean;
}): DiscoveryQuery[] {
  const { spec, cnaeLabels, places, max } = input;
  if (max <= 0) return [];

  const terms: string[] = [];
  const seenTerm = new Set<string>();
  const addTerm = (raw: string) => {
    const term = raw.replace(/\s+/g, " ").trim();
    if (term.length < 4) return;
    const key = unaccent(term).toLowerCase();
    if (seenTerm.has(key)) return;
    seenTerm.add(key);
    terms.push(term);
  };

  for (const label of cnaeLabels) for (const term of termsFromCnaeLabel(label)) addTerm(term);
  // Only POSITIVE probes. A negative probe describes what disqualifies a
  // prospect, so searching for it would spend the budget finding the businesses
  // the rubric is going to reject.
  for (const probe of spec.probes ?? []) {
    if (probe.meaning !== "positive") continue;
    for (const term of probe.terms ?? []) addTerm(term);
  }

  // `nationwide` skips the UF fallback too: falling back to "SP" would quietly
  // reinstate the constraint the caller just asked to remove.
  const geo = input.nationwide ? [] : places.length ? places : (spec.targeting?.ufs ?? []);
  const out: DiscoveryQuery[] = [];
  const seenQuery = new Set<string>();

  // Breadth-first: every term once at the best place, then every term at the
  // second place, and so on.
  for (let round = 0; round < Math.max(geo.length, 1) && out.length < max; round++) {
    const place = geo[round] ?? "";
    for (const term of terms) {
      if (out.length >= max) break;
      // The term is quoted and the place is not, for the reason `searchQuery`
      // quotes a name: unquoted, the top results are pages that merely contain
      // the words somewhere.
      const query = place ? `"${term}" ${place}` : `"${term}"`;
      if (seenQuery.has(query)) continue;
      seenQuery.add(query);
      out.push({ query, term, place });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * What we concluded about a business found on the open internet.
 *
 * Three facts that must never collapse into each other, which is the same rule
 * `search_lookups` and `crawls` already enforce elsewhere:
 *
 * - `in_reach` — it is in the Receita base AND the project's own CNAE filter
 *   already returns it. The sweep found something you already had. This is the
 *   denominator, not the yield.
 * - `out_of_reach` — it is in the base, and the project's filters do NOT return
 *   it. The prize: a registry-backed business the CNAE query never reaches.
 * - `unmatched` — WE COULD NOT MATCH IT. Not "it has no CNPJ", not "it is
 *   informal", not "it is unregistered". Every label shown to a person has to say
 *   the first thing, because the other three are conclusions nobody verified.
 *
 * There is no fourth value for "blocked": a refused sweep writes no row at all.
 */
export type WebLeadVerdict = "in_reach" | "out_of_reach" | "unmatched";

/** Which filter dimension put an in-base company out of reach. */
export type OutOfReachBy = "cnae" | "uf" | "other";

export interface VerdictInput {
  /** The Receita row we matched, or null when nothing matched. */
  company: { cnae: string; uf: string | null } | null;
  /** The project's own targeting, i.e. what its queries actually return. */
  targeting: { cnaePrefixes: string[]; cnaeExclude: string[]; ufs: string[] };
}

export interface Verdict {
  verdict: WebLeadVerdict;
  by: OutOfReachBy | null;
}

/**
 * Which of the three facts this lead is.
 *
 * "Out of reach" is judged against the project's targeting rather than against
 * the query that happened to find it, because the question the tab answers is
 * "would my own CNAE list have brought me this company" — and that list is the
 * targeting.
 */
export function classifyWebLeadVerdict({ company, targeting }: VerdictInput): Verdict {
  if (!company) return { verdict: "unmatched", by: null };

  const prefixes = targeting.cnaePrefixes ?? [];
  const excluded = (targeting.cnaeExclude ?? []).some((p) => p && company.cnae.startsWith(p));
  // No prefixes at all means the project targets nothing yet, so nothing is in
  // reach — saying otherwise would credit the sweep with a hit the project could
  // never have made.
  const cnaeHits = prefixes.length > 0 && prefixes.some((p) => p && company.cnae.startsWith(p));
  const ufHits =
    !targeting.ufs?.length || (company.uf ? targeting.ufs.includes(company.uf) : false);

  if (cnaeHits && !excluded && ufHits) return { verdict: "in_reach", by: null };
  // Report the dimension that actually missed, most specific first: a company can
  // fail on both, and "cnae" is the one that changes what you target.
  if (!cnaeHits || excluded) return { verdict: "out_of_reach", by: "cnae" };
  if (!ufHits) return { verdict: "out_of_reach", by: "uf" };
  return { verdict: "out_of_reach", by: "other" };
}

// ---------------------------------------------------------------------------
// Believing a mirror page
// ---------------------------------------------------------------------------

/** The apex reduced to its own label, so `padaria-alfa.com.br` yields "padaria alfa". */
export function apexLabel(url: string): string {
  const apex = apexOf(url);
  if (!apex) return "";
  const [label = ""] = apex.split(".");
  return label.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Does this mirror page's CNPJ belong to this website?
 *
 * The trap this exists for: a registry-mirror hit sits on the same results page
 * as the business's own site, and **nothing whatsoever connects them**. The mirror
 * may be about the third result down, or about a company with a similar name.
 * Believing the pairing because both appeared in one search is how a bakery's
 * website gets filed under the auto-parts shop next door — silently, and with a
 * real CNPJ attached, which makes it look verified.
 *
 * So the CNPJ is only believed when the Receita's own name for it corresponds to
 * the candidate. Two ways, because neither alone is enough:
 *
 * - the site's title against the registry names, via `entityTitleMatchesCompany`'s
 *   reasoning — written for exactly this legal-name-versus-trade-name drift; or
 * - the domain's own label, which is often the trade name spelled out
 *   (`padaria-alfa.com.br` against "PADARIA ALFA LTDA").
 *
 * Anything else is not a match. There is no "probable" — a confidence score here
 * would just be a wrong answer with a number beside it.
 */
export function verifyMirrorLink(input: {
  /** The candidate business: its site and whatever the SERP called it. */
  siteUrl: string;
  siteTitle?: string | null;
  /** The authoritative names, from the Receita row for the extracted CNPJ. */
  company: { razaoSocial?: string | null; nomeFantasia?: string | null };
}): boolean {
  const registry = [input.company.razaoSocial, input.company.nomeFantasia]
    .map(companyNameTokens)
    .filter((tokens) => tokens.length >= MIN_COMPANY_TOKENS);
  if (!registry.length) return false;

  const title = companyNameTokens(input.siteTitle);
  const label = companyNameTokens(apexLabel(input.siteUrl));

  for (const name of registry) {
    if (matchesName(title, name)) return true;
    if (matchesName(label, name)) return true;
  }
  return false;
}

/**
 * The distinctiveness a single-word candidate needs before it may match.
 *
 * Brazilian companies very often register the trade name alone as the domain —
 * `zangari.com.br` for "ZANGARI ADMINISTRACAO LTDA" — and rejecting one token
 * outright (the rule `MIN_COMPANY_TOKENS` applies to a *pair* of names) would
 * throw away a large share of the real matches.
 *
 * But one token is a much weaker key, so it has to earn it: five characters or
 * more, and it must EQUAL the registry name's first token rather than merely
 * prefix it. `casa.com.br` is refused on length; `zangari` is accepted; `zang`
 * would not be, because a prefix rule is what lets a short generic word attach
 * itself to an unrelated company.
 */
const MIN_SINGLE_TOKEN_CHARS = 5;

/**
 * Does a candidate name correspond to a registry name?
 *
 * Prefix in either direction for two tokens or more, the same rule
 * `entityTitleMatchesCompany` uses and for the same measured reason: the legal
 * name and the trade name routinely contain one another and neither reliably
 * contains the other. Spaces are also compared away, because a domain drops the
 * ones the registry keeps.
 */
function matchesName(candidate: string[], name: string[]): boolean {
  if (!candidate.length) return false;

  if (candidate.length === 1) {
    const single = candidate[0]!;
    return single.length >= MIN_SINGLE_TOKEN_CHARS && single === name[0];
  }

  const a = candidate.join(" ");
  const b = name.join(" ");
  if (a.startsWith(b) || b.startsWith(a)) return true;
  const ax = a.replace(/ /g, "");
  const bx = b.replace(/ /g, "");
  return ax.startsWith(bx) || bx.startsWith(ax);
}
