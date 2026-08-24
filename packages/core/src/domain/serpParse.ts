/**
 * Turning a results page into results.
 *
 * This is the only fragile part of the search stage, so it is also the only
 * part that is a pure function. The markup belongs to somebody else and will
 * change without notice; keeping the parsing here means a change shows up as a
 * failing fixture test rather than as silence.
 *
 * The return type is the point of the file. A parser that returns an empty
 * array on unfamiliar markup is indistinguishable from one that searched
 * properly and found nothing — and downstream that difference is everything,
 * because "no results" gets recorded as "this company has no web presence" and
 * reaches the model as evidence. So there are four outcomes, and two of them
 * are errors the caller must not treat as absence:
 *
 * - `ok`           — results parsed.
 * - `empty`        — the page said, in its own words, that it found nothing.
 * - `blocked`      — a CAPTCHA, a consent wall, or a rate-limit page.
 * - `unrecognized` — neither results nor a no-results marker. The markup moved.
 *
 * String and regex work only, no DOM parser. Same reasoning as the crawler: the
 * fields wanted are in the markup, and a real parser is a dependency plus a
 * performance cost for a job three regexes do.
 */

import { isNonResult } from "./searchNoise";

export interface SearchHit {
  url: string;
  title: string;
  description: string;
}

export type SerpPage =
  | { status: "ok"; hits: SearchHit[] }
  | { status: "empty" }
  | { status: "blocked"; reason: string }
  | { status: "unrecognized" };

/**
 * Hits above this are dropped; nothing useful is on page two of a name search.
 *
 * A default rather than a law, because it was chosen for one caller. Verifying
 * that a company exists needs a handful of results and no more. Sweeping the open
 * internet for businesses wants everything a page will give, and the page has
 * already been fetched and paid for — so discarding results there is throwing away
 * the only free part of the exchange.
 */
const MAX_HITS = 12;

export interface ParseOptions {
  /** Keep up to this many hits. Defaults to `MAX_HITS`. */
  maxHits?: number;
}

/**
 * Asking an engine for one page of results.
 *
 * Lives here rather than with the provider interface because both the adapters
 * that build the request and the parsers that read the response need it, and
 * neither should have to import from a use case to describe a search.
 */
export interface SearchPageOptions extends ParseOptions {
  /** Result offset. 0 (or absent) is page one. */
  start?: number;
}

const FIELD_CHARS = 400;

/** Entities that show up inside a result title or snippet. */
export function decodeHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#0*(\d{2,5});/g, (_, d: string) => {
      const code = Number(d);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&#x([0-9a-f]{2,5});/gi, (_, h: string) => {
      const code = parseInt(h, 16);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&amp;/gi, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const clip = (s: string) => s.slice(0, FIELD_CHARS);

/**
 * Both engines wrap outbound links in a redirector, and the wrapper host is not
 * the result. Unwrapping has to happen before anything classifies or name-checks
 * the URL, or every hit would look like it came from the search engine itself.
 */
export function unwrapRedirect(raw: string): string | null {
  let url = raw.trim();
  if (!url) return null;
  if (url.startsWith("//")) url = `https:${url}`;

  // A relative href is only a destination if it is the engine's own
  // redirector. Anything else — "#", "/settings", "javascript:" — resolves
  // against the base into a perfectly valid URL *for the search engine*, which
  // would then be recorded as this company's website.
  const isRedirectPath = /^\/(?:url|l\/?)\?/.test(url);
  if (!/^https?:\/\//i.test(url) && !isRedirectPath) return null;

  for (let i = 0; i < 3; i++) {
    let parsed: URL;
    try {
      parsed = new URL(url, "https://duckduckgo.com");
    } catch {
      return null;
    }
    // DDG uses ?uddg=, Google uses ?q= or ?url= on /url paths.
    const inner =
      parsed.searchParams.get("uddg") ??
      (/^\/url$/.test(parsed.pathname) || /\/l\/?$/.test(parsed.pathname)
        ? (parsed.searchParams.get("q") ?? parsed.searchParams.get("url"))
        : null);
    if (!inner) {
      return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
    }
    url = inner;
  }
  return null;
}

function pushHit(
  out: SearchHit[],
  url: string | null,
  title: string,
  description: string,
  maxHits = MAX_HITS
) {
  if (!url || out.length >= maxHits) return;
  if (isNonResult(url)) return;
  if (out.some((h) => h.url === url)) return;
  const t = clip(decodeHtml(title));
  if (!t) return;
  out.push({ url, title: t, description: clip(decodeHtml(description)) });
}

// ------------------------------------------------------------ DuckDuckGo HTML

const DDG_BLOCKED =
  /(anomaly[_-]?modal|challenge-form|If this error persists|unusual traffic|blocked)/i;
const DDG_EMPTY = /(no-results|No results\.|Nenhum resultado)/i;

/**
 * The `html.duckduckgo.com/html/` layout.
 *
 * Server-rendered, which is why DDG needs no browser at all. Results are
 * `<div class="result…">` blocks carrying `result__a`, `result__snippet`.
 */
export function parseDuckDuckGo(html: string, opts: ParseOptions = {}): SerpPage {
  const maxHits = opts.maxHits ?? MAX_HITS;
  if (!html.trim()) return { status: "unrecognized" };
  if (DDG_BLOCKED.test(html))
    return { status: "blocked", reason: "DuckDuckGo bloqueou a busca" };

  const hits: SearchHit[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);

  for (const block of blocks) {
    const a = block.match(
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
    );
    if (!a?.[1]) continue;
    const snippet =
      block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ??
      block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    pushHit(hits, unwrapRedirect(a[1]), a[2] ?? "", snippet?.[1] ?? "", maxHits);
  }

  if (hits.length) return { status: "ok", hits };
  if (DDG_EMPTY.test(html)) return { status: "empty" };
  // A page that came back but yielded nothing and never said "no results" is
  // the case that must not be reported as absence.
  return { status: "unrecognized" };
}

// ----------------------------------------------------------------- Google

/**
 * Markers that only appear on a real interstitial.
 *
 * Tightened after a live test: matching `/sorry/index` anywhere in the document
 * flagged a perfectly good results page as blocked, because Google's own client
 * code contains `l.indexOf("/sorry/index")` — it is their script *checking*
 * whether it was redirected. A bare `recaptcha` has the same problem. So these
 * are full phrases and form attributes, never path fragments a script might
 * mention.
 */
const GOOGLE_BLOCKED =
  /(Our systems have detected unusual traffic|tráfego incomum|nossos sistemas detectaram|id="captcha-form"|action="\/sorry\/index"|\bunusual traffic from your computer\b)/i;
/**
 * The consent interstitial.
 *
 * Both Portuguese phrasings are accepted because Google has shipped "antes de
 * continuar no Google" and "antes de continuar para o Google" at different
 * times, and guessing one would make the other parse as `unrecognized`. Still
 * anchored on "Google" following the phrase, so an unrelated page saying
 * "antes de continuar" is not mistaken for a wall.
 */
const GOOGLE_CONSENT =
  /(id="?consent-bump|antes de continuar (?:no|para o) Google|Before you continue to Google)/i;
const GOOGLE_EMPTY =
  /(did not match any documents|não encontrou nenhum documento|Nenhum documento|No results found)/i;

/**
 * Google's results markup.
 *
 * Class names are generated and rotate, so this deliberately anchors on the one
 * structure that has stayed put for years: an `<a href="/url?q=…">` or a direct
 * outbound `<a>` wrapping an `<h3>`. Anything keyed to a class like `.yuRUbf`
 * would break monthly.
 *
 * Consent and CAPTCHA are `blocked`, not `empty`. They are the expected outcome
 * of scraping at any volume, and the caller stops the run on them.
 */
/**
 * The snippet belonging to the result whose title ends at `from`.
 *
 * Assembled out of text nodes rather than pulled from a container, because
 * Google fragments the snippet: search terms are wrapped in `<em>`, so the
 * sentence arrives as several pieces with markup between them and no single
 * element holds it. Measured on a live page, it also sits well past the
 * breadcrumb block, which is why the window is generous.
 *
 * The window stops at the next `<h3>` so one result's snippet can never absorb
 * the next result's text.
 */
function googleSnippet(html: string, from: number): string {
  const nextTitle = html.indexOf("<h3", from);
  const end = Math.min(nextTitle === -1 ? html.length : nextTitle, from + 6000);
  const window = html
    .slice(from, end)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  const pieces: string[] = [];
  for (const m of window.matchAll(/>([^<]+)</g)) {
    const raw = decodeHtml(m[1] ?? "");
    if (raw.length < 3) continue;
    // Chrome that sits between the title and the snippet: the source name, the
    // cite URL and its breadcrumb arrows, plus any inline script that survived.
    if (/^https?:\/\//i.test(raw) || raw.includes("›")) continue;
    if (/function\s*\(|document\.|getElementById|var\s+\w+=/.test(raw)) continue;
    // Google renders some snippets twice (a visible and a hidden copy), which
    // arrives here as the same text node repeated back-to-back.
    if (pieces[pieces.length - 1] === raw) continue;
    pieces.push(raw);
  }

  // The snippet is the run of prose, so short fragments only count once
  // something substantial has started — that is what keeps "Tripadvisor" and a
  // star rating out of the front of it.
  const startAt = pieces.findIndex((piece) => piece.length >= 25);
  if (startAt === -1) return "";

  const text = pieces.slice(startAt).join(" ").replace(/\s+/g, " ").trim();

  // The duplicate copy can also arrive as one long string that is the same
  // sentence twice; keep the first half when that is exactly what it is.
  const half = Math.floor(text.length / 2);
  if (half > 30 && text.slice(0, half).trim() === text.slice(half).trim()) {
    return text.slice(0, half).trim();
  }
  return text;
}

export function parseGoogle(
  html: string,
  finalUrl?: string,
  opts: ParseOptions = {}
): SerpPage {
  const maxHits = opts.maxHits ?? MAX_HITS;
  if (!html.trim()) return { status: "unrecognized" };

  // The URL is the only definitive signal, so it is checked first and on its
  // own: a redirect to /sorry/ or to the consent host IS the block, whatever
  // the body happens to contain.
  if (finalUrl && /\/sorry\/|consent\.google\.com/i.test(finalUrl)) {
    return { status: "blocked", reason: "Google redirecionou para a tela de bloqueio" };
  }

  const hits: SearchHit[] = [];

  // Pair each <h3> with the nearest href BEFORE it, rather than requiring the
  // h3 to sit inside the anchor.
  //
  // This is what the real markup looks like, measured rather than assumed: on a
  // live results page the href ends 220-245 characters before its <h3>, with
  // divs and a <cite> in between. A containment regex matches none of it, and an
  // earlier version of this function returned zero hits on a perfectly good
  // page for exactly that reason. Class names are avoided on purpose — they are
  // generated and rotate.
  for (const m of html.matchAll(/<h3[^>]*>([\s\S]{0,300}?)<\/h3>/gi)) {
    const at = m.index ?? 0;
    const before = html.slice(Math.max(0, at - 600), at);
    const href = [...before.matchAll(/href="([^"]+)"/g)].pop();
    if (!href?.[1]) continue;

    const url = unwrapRedirect(href[1]);
    if (!url) continue;

    pushHit(hits, url, m[1] ?? "", googleSnippet(html, at + m[0].length), maxHits);
  }

  // Results first, markers second. A page carrying organic results is not a
  // block no matter what strings its scripts contain — checking the markers
  // before parsing is what produced a false "blocked" on a live results page,
  // and a false block is worse than a missed one: it summons a human for
  // nothing and, at volume, trips the circuit breaker on a working run.
  if (hits.length) return { status: "ok", hits };

  if (GOOGLE_BLOCKED.test(html)) {
    return { status: "blocked", reason: "Google pediu CAPTCHA (tráfego incomum)" };
  }
  if (GOOGLE_CONSENT.test(html)) {
    return { status: "blocked", reason: "Google mostrou a tela de consentimento" };
  }
  if (GOOGLE_EMPTY.test(html)) return { status: "empty" };
  return { status: "unrecognized" };
}
