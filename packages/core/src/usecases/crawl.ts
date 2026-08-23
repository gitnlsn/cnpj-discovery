import { extractText, runProbes } from "../domain/probes";
import {
  extractJsonLd,
  extractMetaDescription,
  structuredText,
  type JsonLdFacts,
} from "../domain/structured";
import type { Probe } from "../domain/spec";
import { describeFetchError } from "../domain/netError";
import type { HttpPort } from "../ports/index";
import {
  FREE_MAIL,
  FREE_MAIL_ANY_TLD,
  TYPO_MAIL,
  INSTITUTIONAL,
  ACCOUNTANT,
  ACCOUNTANT_WORD,
} from "../domain/mail";
import { hostOf, isHub, isBuilder } from "../domain/hosts";

/**
 * Fetches a company site and turns it into signals.
 *
 * Plain fetch plus regexes. No Puppeteer and no Cheerio: the signals that
 * matter here live in the markup, not behind JavaScript, and a headless
 * browser per company would make the crawl three orders of magnitude slower
 * for signals it would not improve.
 *
 * Two things this adds over the version it was ported from: robots.txt is
 * honoured, and requests to the same host are spaced out. Those were
 * defensible omissions when the crawl was one homepage per company; a deep
 * crawl that follows links makes them obligatory.
 */

/**
 * Receita Federal publishes no website column, so a lead with no site recorded
 * is "unknown", not "has none". The registered e-mail domain closes most of
 * that gap for free: a business that registered contato@suapadaria.com.br owns
 * suapadaria.com.br. Consumer-provider addresses are ignored.
 */

export function websiteFromEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;

  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!domain || !domain.includes(".") || domain.length < 5) return null;
  if (FREE_MAIL.has(domain) || TYPO_MAIL.test(domain)) return null;
  // A consumer provider on any country suffix. yahoo.es and yahoo.fr were each
  // crawled as a Brazilian company's homepage before this line existed.
  if (FREE_MAIL_ANY_TLD.test(domain)) return null;
  if (domain.endsWith(".gov.br")) return null;
  // The domain belongs to the institution, not the person who has an address
  // there. A MEI with a university address is a student or a lecturer, and
  // guessing from it hands the scorer 8 KB of the university's homepage.
  if (INSTITUTIONAL.test(domain)) return null;

  // .cnt.br is Brazil's reserved TLD for accountants, and an accounting office
  // registering the CNPJ puts its own address in the record.
  if (domain.endsWith(".cnt.br") || ACCOUNTANT.test(domain) || ACCOUNTANT_WORD.test(domain)) {
    return null;
  }

  return `https://${domain}`;
}

function detectPlatform(html: string, generator: string | null): string | null {
  const h = html.toLowerCase();
  if (generator) {
    const g = generator.toLowerCase();
    if (g.includes("wordpress")) return "wordpress";
    if (g.includes("wix")) return "wix";
    if (g.includes("joomla")) return "joomla";
    if (g.includes("drupal")) return "drupal";
  }
  if (h.includes("/wp-content/") || h.includes("/wp-includes/")) return "wordpress";
  if (h.includes("static.parastorage.com") || h.includes("wix.com")) return "wix";
  if (h.includes("squarespace")) return "squarespace";
  if (h.includes("shopify")) return "shopify";
  if (h.includes("cdn.jsdelivr.net/npm/vue") || h.includes("__nuxt")) return "vue";
  if (h.includes("__next")) return "nextjs";
  return null;
}

// ------------------------------------------------------------------ signals

export interface SiteSignals {
  websiteUrl: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  error: string | null;
  hasWebsite: boolean;
  isDead: boolean;
  isHttps: boolean;
  isLinkHub: boolean;
  isFreeBuilder: boolean;
  /**
   * `null` means we never fetched the page, so this is unknown rather than
   * false. A link hub is short-circuited on purpose, and a default of `false`
   * would be read downstream as observed evidence ("not mobile-friendly").
   */
  hasViewport: boolean | null;
  hasContactPath: boolean | null;
  hasWaLink: boolean | null;
  hasForm: boolean | null;
  generator: string | null;
  platform: string | null;
  footerYear: number | null;
  title: string | null;
  igHandle: string | null;
  /** A number found in a wa.me / tel: href — often better than the RF one. */
  sitePhone: string | null;
  textExcerpt: string | null;
  /**
   * What the page declares about itself — meta description and JSON-LD.
   *
   * Kept apart from `textExcerpt` on purpose. Downstream reads that field's
   * length as "how much prose did we read", and declared metadata is not prose.
   * See domain/structured.ts.
   */
  metaDescription: string | null;
  jsonLd: JsonLdFacts | null;
  /** meta + JSON-LD as one haystack, which probes also search. */
  structuredText: string | null;
  /**
   * A page that returned 200 and rendered nothing without JavaScript.
   *
   * `null` means we never fetched it, same as the signals above. The point of
   * the flag is that an empty shell is "we could not read it", not "there is
   * nothing there" — without it, a nav bar's worth of text produces a full set
   * of `false` probe results that read downstream as observed absence.
   */
  isJsShell: boolean | null;
  pagesFetched: number;
  probes: Record<string, boolean>;
}

function emptySignals(url: string | null): SiteSignals {
  return {
    websiteUrl: url,
    finalUrl: null,
    httpStatus: null,
    error: null,
    hasWebsite: Boolean(url),
    isDead: false,
    isHttps: false,
    isLinkHub: false,
    isFreeBuilder: false,
    hasViewport: null,
    hasContactPath: null,
    hasWaLink: null,
    hasForm: null,
    generator: null,
    platform: null,
    footerYear: null,
    title: null,
    igHandle: null,
    sitePhone: null,
    textExcerpt: null,
    metaDescription: null,
    jsonLd: null,
    structuredText: null,
    isJsShell: null,
    pagesFetched: 0,
    probes: {},
  };
}

/**
 * Below this much rendered text, a page with a JS mount point is a shell.
 *
 * Deliberately well under `CONCLUSIVE_TEXT_CHARS` (1500, in scoreCompanies):
 * that threshold answers "is a probe miss meaningful", this one answers the
 * narrower "did this page render at all". A real homepage clears both easily;
 * the pages this catches render a header and a spinner.
 */
const SHELL_TEXT_CHARS = 400;

/**
 * Markers for a client-rendered app that served us an empty container.
 *
 * The mount point is the evidence, not the framework: `detectPlatform` already
 * reports nextjs/vue, but plenty of shells are plain React or Angular with no
 * generator tag at all.
 */
const MOUNT_POINTS =
  /(__NEXT_DATA__|id=["'](?:__next|root|app|__nuxt|q-app)["']|data-reactroot|ng-version=)/i;

/** Analyzes already-fetched HTML. Pure, so it is testable without a network. */
export function analyzeHtml(html: string, finalUrl: string): Partial<SiteSignals> {
  const head = html.slice(0, 200_000); // enough for meta tags on any real page
  const lower = head.toLowerCase();

  const generatorMatch = head.match(
    /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i
  );
  const titleMatch = head.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);

  // Copyright years across the whole document; take the most recent.
  const years = [...html.matchAll(/(?:©|&copy;|copyright)[^0-9]{0,20}(20\d{2})/gi)]
    .map((m) => Number(m[1]))
    .filter((y) => y >= 2000 && y <= 2100);

  const igMatch = html.match(/(?:instagram\.com\/)([A-Za-z0-9_.]{2,30})(?:[/?"'\s]|$)/i);
  const generator = generatorMatch?.[1]?.trim() ?? null;

  const text = extractText(html);
  const metaDescription = extractMetaDescription(html);
  const jsonLd = extractJsonLd(html);

  return {
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(head),
    hasWaLink: /(?:wa\.me\/|api\.whatsapp\.com\/send|whatsapp:\/\/send)/i.test(html),
    hasContactPath:
      /href=["']tel:/i.test(html) ||
      /(?:wa\.me\/|api\.whatsapp\.com\/send)/i.test(html) ||
      /href=["']mailto:/i.test(html) ||
      /\b(agendar|agendamento|marcar hor[áa]rio|reservar|fale conosco|contato)\b/i.test(lower),
    hasForm: /<form[\s>]/i.test(html),
    generator,
    platform: detectPlatform(html, generator),
    footerYear: years.length ? Math.max(...years) : null,
    title: titleMatch?.[1]?.replace(/\s+/g, " ").trim().slice(0, 200) ?? null,
    igHandle:
      igMatch?.[1] && !["p", "reel", "explore"].includes(igMatch[1]) ? igMatch[1] : null,
    sitePhone: phoneFromHtml(html),
    isHttps: finalUrl.startsWith("https://"),
    textExcerpt: text,
    metaDescription,
    jsonLd,
    structuredText: structuredText(jsonLd, metaDescription),
    isJsShell: text.length < SHELL_TEXT_CHARS && MOUNT_POINTS.test(html),
  };
}

/**
 * Pulls a phone number out of the page's own links.
 *
 * The Receita number is whatever was filed with the registration, which for a
 * great many micro-businesses is the accountant's line. A `wa.me` href on the
 * company's own site is the number they actually answer.
 */
export function phoneFromHtml(html: string): string | null {
  const wa = html.match(/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?55\d{10,11})/i);
  if (wa?.[1]) return wa[1].replace(/^\+?/, "+");
  const tel = html.match(/href=["']tel:(\+?[\d\s().-]{10,20})["']/i);
  if (tel?.[1]) {
    const digits = tel[1].replace(/\D/g, "");
    if (digits.length >= 10 && digits.length <= 13) {
      return digits.startsWith("55") ? `+${digits}` : `+55${digits}`;
    }
  }
  return null;
}

// -------------------------------------------------------------- politeness

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal robots.txt: the Disallow list for `*` (or for us specifically).
 *
 * Deliberately not a full RFC implementation — no wildcards beyond a prefix
 * match, no Allow overrides. It errs toward not fetching, which is the correct
 * direction to err when the alternative is hammering somebody's shared host.
 */
export interface Robots {
  disallow: string[];
  crawlDelayMs: number;
}

export function parseRobots(text: string): Robots {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  let applies = false;
  const disallow: string[] = [];
  let crawlDelayMs = 0;

  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      applies = value === "*" || value.toLowerCase().includes("cnpj-discovery");
    } else if (applies && key === "disallow" && value) {
      disallow.push(value);
    } else if (applies && key === "crawl-delay") {
      const secs = Number(value);
      if (Number.isFinite(secs) && secs > 0) crawlDelayMs = Math.min(secs * 1000, 30_000);
    }
  }
  return { disallow, crawlDelayMs };
}

export function robotsAllows(robots: Robots, pathname: string): boolean {
  // "Disallow: /" blocks everything; an empty Disallow blocks nothing.
  return !robots.disallow.some((rule) => rule === "/" || pathname.startsWith(rule));
}

/**
 * Per-host courtesy: never two requests to the same host inside the delay
 * window, and never more than the site's own Crawl-delay asks for.
 */
export class HostThrottle {
  private lastAt = new Map<string, number>();
  constructor(private readonly minIntervalMs = 1000) {}

  async wait(host: string, crawlDelayMs = 0): Promise<void> {
    const gap = Math.max(this.minIntervalMs, crawlDelayMs);
    const last = this.lastAt.get(host) ?? 0;
    const remaining = last + gap - Date.now();
    if (remaining > 0) await sleep(remaining);
    this.lastAt.set(host, Date.now());
  }
}

// ------------------------------------------------------------------- crawl

export interface CrawlOptions {
  http?: HttpPort;
  timeoutMs?: number;
  /** How many pages beyond the homepage to follow. 0 = homepage only. */
  depth?: number;
  probes?: Probe[];
  throttle?: HostThrottle;
  /** Ignoring robots is possible but must be explicit and deliberate. */
  ignoreRobots?: boolean;
}

async function fetchRobots(http: HttpPort, origin: string, timeoutMs: number): Promise<Robots> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await http.fetch(`${origin}/robots.txt`, {
      signal: controller.signal,
      headers: { "User-Agent": UA },
    });
    clearTimeout(timer);
    // No robots.txt means no restrictions. A 5xx is ambiguous, and the polite
    // reading of an ambiguous answer is to stay out.
    if (res.status >= 500) return { disallow: ["/"], crawlDelayMs: 0 };
    if (!res.ok) return { disallow: [], crawlDelayMs: 0 };
    return parseRobots((await res.text()).slice(0, 100_000));
  } catch {
    return { disallow: [], crawlDelayMs: 0 };
  }
}

/** Internal links worth a second look, in priority order. */
const INTERESTING =
  /(contato|fale-conosco|sobre|quem-somos|servicos|serviços|produtos|planos|precos|preços)/i;

function internalLinks(html: string, base: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const baseHost = hostOf(base);
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    if (out.length >= limit) break;
    const raw = m[1];
    if (!raw || raw.startsWith("mailto:") || raw.startsWith("tel:")) continue;
    let abs: URL;
    try {
      abs = new URL(raw, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(abs.protocol)) continue;
    if (hostOf(abs.href) !== baseHost) continue;
    const key = abs.origin + abs.pathname;
    if (seen.has(key) || abs.pathname === "/" || abs.pathname === "") continue;
    if (!INTERESTING.test(abs.pathname)) continue;
    seen.add(key);
    out.push(abs.origin + abs.pathname);
  }
  return out;
}

/**
 * Fetches a site and returns what could be observed about it.
 *
 * Never throws: a dead site is data, not an exception. Failures land in
 * `error` with the page-level signals left `null`, so "we looked and it was
 * not there" stays distinguishable from "we never looked".
 */
export async function crawlSite(
  rawUrl: string | null,
  opts: CrawlOptions = {}
): Promise<SiteSignals> {
  const http = opts.http ?? { fetch: (u: string, i?: RequestInit) => fetch(u, i) };
  const timeoutMs = opts.timeoutMs ?? 8000;
  const throttle = opts.throttle ?? new HostThrottle();
  const signals = emptySignals(rawUrl);
  if (!rawUrl) return signals;

  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  const host = hostOf(url);
  signals.isLinkHub = isHub(host);
  signals.isFreeBuilder = isBuilder(host);

  // A link hub is already a conclusive answer — no need to fetch Instagram.
  // Page-level signals stay null: we did not look.
  if (signals.isLinkHub) {
    signals.finalUrl = url;
    signals.hasWebsite = true;
    const m = url.match(/instagram\.com\/([A-Za-z0-9_.]{2,30})/i);
    if (m?.[1]) signals.igHandle = m[1];
    return signals;
  }

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    signals.error = "URL inválida";
    return signals;
  }

  const robots = opts.ignoreRobots
    ? { disallow: [], crawlDelayMs: 0 }
    : await fetchRobots(http, origin, timeoutMs);

  const get = async (target: string): Promise<{ html: string; res: Response } | null> => {
    const path = (() => {
      try {
        return new URL(target).pathname;
      } catch {
        return "/";
      }
    })();
    if (!opts.ignoreRobots && !robotsAllows(robots, path)) return null;

    await throttle.wait(hostOf(target), robots.crawlDelayMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await http.fetch(target, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "pt-BR,pt;q=0.9",
        },
      });
      const html = res.ok ? await res.text() : "";
      return { html, res };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const first = await get(url);
    if (!first) {
      signals.error = "bloqueado por robots.txt";
      signals.finalUrl = url;
      return signals;
    }

    const { html, res } = first;
    signals.httpStatus = res.status;
    signals.finalUrl = res.url || url;
    signals.isDead = res.status >= 400;
    signals.pagesFetched = 1;

    // The redirect target may itself be a link hub — very common in Brazil.
    const finalHost = hostOf(signals.finalUrl);
    if (isHub(finalHost)) signals.isLinkHub = true;
    if (isBuilder(finalHost)) signals.isFreeBuilder = true;

    if (res.ok) {
      Object.assign(signals, analyzeHtml(html, signals.finalUrl));

      let text = signals.textExcerpt ?? "";
      const depth = Math.max(0, Math.min(opts.depth ?? 0, 5));
      if (depth > 0 && !signals.isLinkHub) {
        for (const link of internalLinks(html, signals.finalUrl, depth)) {
          const page = await get(link);
          if (!page?.res.ok) continue;
          signals.pagesFetched++;
          // Contact pages are where the real phone usually lives.
          signals.sitePhone ??= phoneFromHtml(page.html);
          text = `${text} ${extractText(page.html)}`;
        }
        // Re-cap after concatenation; the 8 KB ceiling is what keeps this table
        // from becoming a copy of the Brazilian web.
        signals.textExcerpt = text.slice(0, 8000);
      }

      // Probes search the rendered text AND what the page declares about
      // itself, because probe vocabulary genuinely lives in a meta description
      // — often the only place it lives, on a thin page.
      //
      // A shell with nothing declared is the case that must NOT be probed: its
      // few characters of nav text would produce a full set of `false`s, and
      // `runProbes` returning {} for null input is exactly how "we did not
      // look" stays distinct from "it is not there".
      const declared = signals.structuredText;
      const haystack =
        signals.isJsShell && !declared
          ? null
          : [signals.textExcerpt, declared].filter(Boolean).join(" ") || null;
      signals.probes = runProbes(opts.probes ?? [], haystack);
    } else {
      signals.isHttps = signals.finalUrl.startsWith("https://");
    }
  } catch (err) {
    signals.error = describeFetchError(err, timeoutMs);
    signals.isDead = true;
  }

  return signals;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight.
 *
 * Results keep the input order, which matters because the caller writes them
 * back against a list it already has. A rejection propagates: `crawlSite` never
 * throws, so anything that gets here is a bug, not a dead website.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }
  );
  await Promise.all(workers);
  return out;
}
