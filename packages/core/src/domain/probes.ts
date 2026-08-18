import type { Probe } from "./spec";

/**
 * Runs an offer's keyword probes over stored homepage text.
 *
 * Two properties make this cheap enough to be worth having. `enrich` already
 * holds the full HTML in memory, so extracting the text costs no extra request.
 * And because the text is stored, a probe written months later can be evaluated
 * against pages fetched long ago — an offer authored today does not mean
 * re-crawling anyone.
 *
 * Terms are literal strings, escaped here. An LLM-authored regex stored in a
 * database and run over arbitrary page content is a ReDoS primitive for no
 * benefit whatsoever.
 */

/** Strips accents so "prático" matches "pratico". */
export function unaccent(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Tag-stripped, collapsed page text, capped.
 *
 * The cap is what keeps `enrichment` from becoming a copy of the Brazilian web:
 * 8 KB is far more than enough for the vocabulary a probe looks for, and the
 * signal is overwhelmingly in the first screenful anyway.
 */
export function extractText(html: string, maxChars = 8000): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  return withoutNoise
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Evaluates probes against page text.
 *
 * Returns only booleans for probes that were actually testable. When there is
 * no text — the page was dead, or was a link hub we deliberately never fetched
 * — the result is an empty object rather than a set of `false`s, because "we
 * did not look" is not the same as "it is not there". That distinction is the
 * same one the scoring rubric insists on.
 */
export function runProbes(probes: Probe[], text: string | null): Record<string, boolean> {
  if (!text || !text.trim() || probes.length === 0) return {};

  const haystack = unaccent(text).toLowerCase();
  const out: Record<string, boolean> = {};

  for (const probe of probes) {
    const terms = probe.terms.map((t: string) => escapeRe(unaccent(t).toLowerCase())).filter(Boolean);
    if (!terms.length) continue;
    // Word-bounded so "ia" does not match inside "familia".
    const re = new RegExp(`(?:^|[^a-z0-9])(?:${terms.join("|")})(?:[^a-z0-9]|$)`, "i");
    out[probe.key] = re.test(haystack);
  }

  return out;
}
