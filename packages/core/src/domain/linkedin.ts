import { unaccent } from "./probes";
import { normalizeName, MIN_NAME_TOKENS } from "./nameMatch";

/**
 * Reading a LinkedIn profile out of a search-result title.
 *
 * We never fetch linkedin.com. Its robots.txt is `User-agent: *` → `Disallow: /`
 * — a blanket prohibition, restated in prose at the top of the file — and
 * `crawlSite` honours robots, so it would refuse. That is not an obstacle to
 * work around: the search engine already fetched the page, and the title it
 * gives back carries the one field worth having.
 *
 * The field is the headline. For a MEI it is frequently the only place the
 * business is stated in words — "Professora de Matemática | Fundadora do
 * Cursinho Alfa".
 *
 * ## Why identity is the hard part here, and not elsewhere
 *
 * On Instagram the bio did two jobs at once: "preparatório para concursos em
 * Manaus" corroborated *who* this is and *what they sell* in the same sentence.
 * LinkedIn decouples them, and every field it gives us is derived from the name:
 *
 * - the URL slug is generated from the display name, so a slug match proves
 *   spelling and nothing else;
 * - the snippet frequently contains LinkedIn's own "Outras pessoas chamadas
 *   Maria Silva" block, so a name can match inside a namesake list printed on a
 *   *different person's* profile.
 *
 * `Silva` is Brazil's most common surname. So a name match against a LinkedIn
 * result is close to no information, and the position of the name is the only
 * usable signal: on a real profile the person's name leads the title. That is
 * what `titleLeadsWithName` checks, and it replaces rather than supplements the
 * generic name gate for this host.
 *
 * Every function below fails to `null`/`false` rather than guessing. A title we
 * cannot parse yields no headline, and a hit with no headline is recorded but
 * never reaches the model.
 */

/** Segments that are LinkedIn's furniture rather than anything about a person. */
const CHROME =
  /^\s*(linkedin|linkedin brasil|perfil profissional|professional profile|profile|perfil)\s*$/i;

/** Hyphen, en dash, em dash and middle dot, spaced. */
const DASH = /\s+[-–—·]\s+/;

/** A trailing "- LinkedIn" the engine did not put behind a pipe. */
const TRAILING_BRAND = /\s*[-–—|·]\s*linkedin(\s+brasil)?\s*$/i;

/**
 * Roles that say nothing about a business.
 *
 * Not dishonest headlines — honest ones carrying no information about what
 * somebody sells. A MEI whose headline is "Autônomo" has told us only what the
 * Receita already told us.
 *
 * Deliberately no length threshold: "Confeiteira" is eleven characters and is
 * exactly the substance we are looking for.
 */
const GENERIC = new Set([
  "ESTUDANTE",
  "AUTONOMO",
  "AUTONOMA",
  "PROFISSIONAL",
  "PROFISSIONAL LIBERAL",
  "EMPREENDEDOR",
  "EMPREENDEDORA",
  "EMPRESARIO",
  "EMPRESARIA",
  "FREELANCER",
  "MICROEMPREENDEDOR INDIVIDUAL",
  "MEI",
  "APOSENTADO",
  "APOSENTADA",
  "DESEMPREGADO",
  "DESEMPREGADA",
  "COLABORADOR",
  "CEO",
  "OPEN TO WORK",
  "DISPONIVEL PARA TRABALHAR",
  "DISPONIVEL PARA O MERCADO",
  "BUSCANDO OPORTUNIDADES",
  "EM BUSCA DE OPORTUNIDADES",
  "NA",
  "NAO INFORMADO",
]);

/** A place, not a job: "São Paulo, São Paulo, Brasil", "Região de Manaus". */
const LOCATION_SHAPE = /(,\s*(brasil|brazil)\s*$)|^(regiao|região|grande)\s+/i;

/**
 * LinkedIn's own marketing copy, which both engines lift into snippets.
 *
 * "Ver o perfil de X no LinkedIn, a maior comunidade profissional do mundo" is
 * filler that would otherwise reach the model as though it were a description of
 * the business — and `renderCandidate` prints the description prominently. It
 * has to be rejected even when no headline was parsed at all.
 */
const BOILERPLATE =
  /(maior comunidade profissional|world'?s largest professional|comunidade profissional do mundo|bilh(ão|ao|ões|oes) de membros|billion members|ver o perfil de|view .{0,40}profile on linkedin)/i;

export interface LinkedInTitle {
  /** The leading segment — the display name on a real profile. */
  leading: string | null;
  headline: string | null;
}

/**
 * Splits a result title into its leading segment and everything after it.
 *
 * Handles both layouts LinkedIn has shipped, because which one arrives depends
 * on the engine and the locale: the headline may follow a dash inside the first
 * pipe-segment ("Name - Headline | LinkedIn") or occupy its own segment
 * ("Name | Headline | LinkedIn").
 *
 * The brand suffix is stripped when present but never *required*: Google
 * rewrites and truncates titles, so demanding "| LinkedIn" would throw away
 * every result it shortened.
 */
export function parseLinkedInTitle(title: string | null | undefined): LinkedInTitle {
  const raw = (title ?? "").replace(/\s+/g, " ").replace(TRAILING_BRAND, "").trim();
  if (!raw) return { leading: null, headline: null };

  const segments = raw
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s && !CHROME.test(s));
  if (!segments.length) return { leading: null, headline: null };

  const [first, ...rest] = segments as [string, ...string[]];
  const dashed = first
    .split(DASH)
    .map((s) => s.trim())
    .filter(Boolean);

  const parts = [...dashed.slice(1), ...rest].filter(Boolean);
  return {
    leading: dashed[0] ?? null,
    headline: parts.length ? parts.join(" - ") : null,
  };
}

/**
 * Does the person's name lead the title?
 *
 * This is the identity gate for LinkedIn, and it exists because the generic one
 * cannot work here — see the file docblock. Requiring the name at the *front*
 * rejects the two dangerous shapes at once: a namesake list quoted in a snippet,
 * and an article or post whose title mentions the person somewhere in the middle.
 *
 * Tolerates the decoration people put after their names — ", MBA", " (Ela/Dela)",
 * emoji, connection degrees — by asking whether the leading segment *starts with*
 * the name rather than equals it.
 */
export function titleLeadsWithName(
  title: string | null | undefined,
  name: string | null
): boolean {
  // The same floor `isNameMatch` enforces, and for a stronger reason: if three
  // tokens are the minimum to identify somebody on the open web, they cannot be
  // fewer on the one host where every field is generated from the name.
  const tokens = normalizeName(name);
  if (tokens.length < MIN_NAME_TOKENS) return false;

  const { leading } = parseLinkedInTitle(title);
  if (!leading) return false;

  const normalizedLeading = unaccent(leading)
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

  return normalizedLeading.startsWith(tokens.join(" "));
}

/** Is this the site's own marketing copy rather than anything about a business? */
export function isLinkedInBoilerplate(text: string | null | undefined): boolean {
  return Boolean(text && BOILERPLATE.test(text));
}

/**
 * Does this headline say anything about a business?
 *
 * Conservative on purpose: when in doubt it answers no, because the cost of a
 * false yes is a stranger's job history attached to somebody's CNPJ and shown to
 * the model as verified.
 *
 * Note what this does NOT decide: whether the activity is *this* company's.
 * "Vendedor na Casas Bahia" has substance and is evidence the person has a job
 * rather than a business — judging that is the model's work, and the prompt is
 * told to. A keyword rule here would have to guess at every trade in Brazil.
 */
export function headlineHasSubstance(headline: string | null | undefined): boolean {
  const raw = (headline ?? "").replace(/\s+/g, " ").trim();
  if (raw.length < 3) return false;
  if (LOCATION_SHAPE.test(raw)) return false;
  if (isLinkedInBoilerplate(raw)) return false;

  const normalized = unaccent(raw)
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  if (!normalized) return false;
  if (GENERIC.has(normalized)) return false;

  const words = normalized.split(" ").filter((w) => w.length > 1);
  if (!words.length) return false;
  return !(words.length === 1 && GENERIC.has(words[0]!));
}

/**
 * A headline that only repeats what we already knew.
 *
 * Same failure mode `looksLikeRegistryMirror` exists for: a headline that is
 * just the person's own name adds nothing, and one that is the razão social is
 * our own database read back to us.
 */
export function headlineRepeatsName(
  headline: string | null | undefined,
  name: string | null
): boolean {
  const h = normalizeName(headline).join(" ");
  const n = normalizeName(name).join(" ");
  return Boolean(h && n && (h === n || n.startsWith(h) || h.startsWith(n)));
}

/**
 * Is this a LinkedIn URL that is somebody's profile?
 *
 * Only `/in/` and the legacy `/pub/<slug>`. Everything else on the host is a
 * different kind of document whose title does not follow the profile shape:
 * `/company/`, `/school/` and `/showcase/` are entities, `/jobs/view/` is a
 * vacancy, and `/posts/` and `/pulse/` are articles that print the author's name
 * in the middle of the title — exactly the position this module refuses to trust.
 *
 * `/pub/dir/` is excluded deliberately even though it lives under `/pub/`: it is
 * LinkedIn's namesake directory, a page whose entire purpose is listing different
 * people who share a name.
 */
export function isLinkedInProfileUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.startsWith("/pub/dir")) return false;
    return /^\/(?:[a-z]{2}\/)?(in|pub)\/[^/]+/.test(path);
  } catch {
    return false;
  }
}

/**
 * Does this LinkedIn hit earn its way to the model?
 *
 * Three mechanical questions, and deliberately not a fourth. It must have a
 * headline with substance, the name must not have been ambiguous across several
 * profiles, and the headline must not merely repeat what we already knew.
 *
 * What this does NOT ask is whether the activity belongs to *this* company.
 * "Vendedor na Casas Bahia" passes every check here and is evidence the person
 * has an employer rather than a business — which is exactly the judgement the
 * original `RESUME` exclusion was making. That judgement is now the model's,
 * because a keyword rule would have to enumerate every trade in Brazil and would
 * reject "Confeiteira" for want of a match. The prompt is told to make it.
 */
export function linkedInIsEvidence(
  hit: { headline?: string | null; ambiguous?: boolean },
  name: string | null
): boolean {
  if (hit.ambiguous) return false;
  if (!headlineHasSubstance(hit.headline)) return false;
  return !headlineRepeatsName(hit.headline, name);
}
