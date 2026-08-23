/**
 * Deciding whether a search result is actually about this company.
 *
 * This exists because of what a MEI is. For a MEI the razão social is the
 * owner's civil name — "MARIA RAQUEL RIBEIRO MARQUES" is a person, not a
 * business — so a name is the only handle we have, and a name is a far weaker
 * key than a CNPJ.
 *
 * The failure mode being defended against is not "we miss someone". It is a
 * confident wrong match: a result attributed to the wrong person becomes a
 * `websiteUrl`, gets crawled, and arrives at the scorer as evidence. Google
 * Places already showed how that goes — it returns its best guess with no way
 * to check the name, and an unverifiable match is worse than no match, because
 * a `—` is honest and a wrong site is not.
 *
 * So the bias here is precision over recall throughout.
 */

import { unaccent } from "./probes";

/**
 * Connectives that carry no identifying information.
 *
 * Dropped rather than matched, because Receita spelling is inconsistent about
 * them: the same person is "MARIA DA SILVA" in one record and "MARIA SILVA" in
 * another, and neither spelling should fail against the other.
 */
const STOPWORDS = new Set(["DE", "DA", "DO", "DAS", "DOS", "E", "DI", "DU", "Y"]);

/**
 * Below this many identifying tokens, a name is not evidence.
 *
 * Two tokens is where this stops working. "ANA SOUZA" has thousands of bearers
 * in any Brazilian state, so an exact match on it says almost nothing; three
 * given/family names together is where a hit starts being about one person.
 */
export const MIN_NAME_TOKENS = 3;

/**
 * The CNPJ the Receita staples onto a MEI's razão social.
 *
 * Measured, not guessed: every MEI row in this base looks like
 * "68.464.349 MICAEL ADRIANO BARBOSA DE SOUZA" — the CNPJ básico, formatted,
 * then the person's name. It is not a suffix and it is not optional.
 *
 * Leaving it in was catastrophic rather than merely untidy. A quoted search for
 * "68.464.349 MICAEL ADRIANO BARBOSA DE SOUZA" matches exactly one kind of page
 * — a CNPJ mirror site, because nothing else on the web pairs that number with
 * that name. So every result was a mirror, every mirror was correctly discarded,
 * and the feature could never have found the Instagram profile it was built to
 * find. It also reads to a search engine like somebody enumerating CNPJs, which
 * is a good way to be served a 403.
 */
const LEADING_CNPJ = /^\s*\d{2}[.\s]?\d{3}[.\s]?\d{3}(?:[/\s]?\d{4})?(?:[-\s]?\d{2})?\s+/;

/** A trailing sequence number or bare CNPJ, which some rows carry instead. */
const TRAILING_DIGITS = /\s+[\d.\-/]{2,}\s*$/;

/** The name with the registry's numbering stripped off both ends. */
export function stripRegistryNumbers(raw: string): string {
  return raw.replace(LEADING_CNPJ, "").replace(TRAILING_DIGITS, "").trim();
}

/**
 * A name reduced to its identifying tokens: unaccented, uppercased, stopwords
 * gone.
 *
 * `unaccent` is the same one the probes use, so "JOSÉ" and "JOSE" normalize
 * identically here and in a probe haystack — one definition of "same string"
 * across the project rather than two that drift.
 */
export function normalizeName(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return unaccent(stripRegistryNumbers(raw))
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** The same normalization for arbitrary text — a page title, a snippet. */
function normalizeHaystack(raw: string): string {
  return ` ${unaccent(raw)
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => !STOPWORDS.has(t))
    .join(" ")} `;
}

/**
 * Does this text contain the person's full name, contiguously?
 *
 * Contiguity is the whole test. Requiring only that every token appear
 * somewhere would match a page listing thirty unrelated names that happen to
 * cover the set, and requiring substrings would be worse still — "ANA VALERIA
 * PIOVESAN" is a substring hit inside "MARIANA VALERIA PIOVESANI". Tokens are
 * padded with spaces on both sides so only whole words count.
 *
 * Returns false rather than throwing on a name too short to be evidence: a
 * two-token razão social is a real thing that simply cannot be verified this
 * way, and the caller records "searched, nothing verified".
 */
export function isNameMatch(
  haystack: string | null | undefined,
  name: string | null | undefined
) {
  const tokens = normalizeName(name);
  if (tokens.length < MIN_NAME_TOKENS || !haystack) return false;
  return normalizeHaystack(haystack).includes(` ${tokens.join(" ")} `);
}

/**
 * The strongest match across a result's fields.
 *
 * Title, snippet and URL are all checked because which one carries the name
 * depends on the kind of page: an Instagram profile puts it in the title, a
 * directory listing in the snippet, and a personal site in the path.
 *
 * The URL needs its separators turned into spaces first — an Instagram handle
 * is `maria.raquel.marques`, which is the name with the spaces spelled
 * differently.
 */
export function matchStrength(
  hit: { url: string; title: string; description: string },
  name: string | null | undefined
): { matched: boolean; where: "title" | "description" | "url" | null } {
  if (isNameMatch(hit.title, name)) return { matched: true, where: "title" };
  if (isNameMatch(hit.description, name)) return { matched: true, where: "description" };
  const urlWords = hit.url.replace(/[/._\-+?=&:]+/g, " ");
  if (isNameMatch(urlWords, name)) return { matched: true, where: "url" };
  return { matched: false, where: null };
}

/**
 * The search string: full name plus city and state.
 *
 * The location is not optional. A bare person's name is ambiguous nationally in
 * a way a company name is not, and the Receita always has município and UF —
 * this is the same reasoning as `placesQuery`, with more at stake because the
 * name identifies a person rather than a business.
 *
 * Quoted so the engine treats the name as a phrase. Without the quotes the
 * top results are pages that merely contain the words.
 */
export function searchQuery(input: {
  razaoSocial: string | null;
  nomeFantasia: string | null;
  municipio: string | null;
  uf: string | null;
}): string | null {
  // Razão social first here, the reverse of `placesQuery`: for a MEI the civil
  // name is the searchable identity, and a fantasia name — when one exists at
  // all — is frequently a generic word that drowns in unrelated results.
  const name = stripRegistryNumbers((input.razaoSocial ?? input.nomeFantasia ?? "").trim());
  if (normalizeName(name).length < MIN_NAME_TOKENS) return null;

  const where = [input.municipio, input.uf].filter(Boolean).join(" ");
  return `"${name}"${where ? ` ${where}` : ""}`;
}
