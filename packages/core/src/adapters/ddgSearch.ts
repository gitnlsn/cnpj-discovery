import type { HttpPort } from "../ports/index";
import { nodeHttp } from "../ports/index";
import { parseDuckDuckGo, type SerpPage, type SearchPageOptions } from "../domain/serpParse";

/**
 * DuckDuckGo, without a browser.
 *
 * `html.duckduckgo.com/html/` is the no-JavaScript version of their results
 * page, server-rendered and complete. That single fact is why this adapter is
 * forty lines and its Google counterpart is a separate package with a Chrome
 * dependency — and it is why DDG goes first in the chain even though its index
 * is smaller. It is free, it is tolerant, and it is testable with a stubbed
 * `HttpPort` like everything else here.
 *
 * On robots.txt: DuckDuckGo disallows `/html`. This bypasses that, knowingly,
 * which is why it does not route through `crawlSite` — that function honours
 * robots and must keep doing so. The compensating controls are the pacing in
 * this file and the daily ceiling the app puts in front of it. Sites found
 * *through* this are still crawled politely.
 */

const URL_ = "https://html.duckduckgo.com/html/";

/** The SKU this adapter counts against. Local ceiling, not a vendor quota. */
export const DDG_SKU = "serp.ddg";

export class DdgError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "DdgError";
  }
}

export interface DdgSearchOptions {
  http?: HttpPort;
  /** Called before each request; throwing here stops the run. */
  beforeRequest?: () => Promise<void> | void;
  afterRequest?: () => Promise<void> | void;
  timeoutMs?: number;
  retries?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Slow on purpose.
 *
 * There is no published rate limit to read, so this is chosen to be obviously
 * below anything that would look like scraping volume. It is the reason the
 * search stage is a job with a progress bar rather than a mutation someone
 * waits on.
 */
const MIN_INTERVAL_MS = 4_000;

/** A browser UA, because the HTML endpoint serves a different page without one. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function createDdgSearch(opts: DdgSearchOptions = {}) {
  const http = opts.http ?? nodeHttp;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 2;
  let lastCallAt = 0;

  /**
   * One query.
   *
   * Returns a `SerpPage`, so "no results", "blocked" and "the markup moved" stay
   * three different answers all the way to the caller. Only a transport failure
   * throws.
   */
  // `page`, not `opts`: the factory closure already owns that name, and shadowing
  // it here silently detaches the budget hooks below.
  async function search(query: string, page: SearchPageOptions = {}): Promise<SerpPage> {
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(Math.min(2_000 * 2 ** (attempt - 1), 20_000));

      await opts.beforeRequest?.();
      const gap = lastCallAt + MIN_INTERVAL_MS - Date.now();
      if (gap > 0) await sleep(gap);
      lastCallAt = Date.now();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await http.fetch(URL_, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": UA,
            "Accept-Language": "pt-BR,pt;q=0.9",
            Accept: "text/html,application/xhtml+xml",
          },
          // `s` is the result offset — what DuckDuckGo's own "next page" sends.
          // Absent for page one, so the request a presence check makes is
          // byte-for-byte the one it always made.
          body: new URLSearchParams(
            page.start
              ? { q: query, kl: "br-pt", s: String(page.start) }
              : { q: query, kl: "br-pt" }
          ).toString(),
        });
      } catch (err) {
        lastErr = new DdgError(`erro de rede na busca: ${(err as Error).message}`);
        continue;
      } finally {
        clearTimeout(timer);
      }

      await opts.afterRequest?.();

      // 429 and 5xx are worth another attempt; other 4xx will not improve.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new DdgError(
          `DuckDuckGo ${res.status}: ${(await res.text()).slice(0, 300)}`,
          res.status
        );
        continue;
      }
      if (!res.ok) {
        throw new DdgError(
          `DuckDuckGo ${res.status}: ${(await res.text()).slice(0, 500)}`,
          res.status
        );
      }

      return parseDuckDuckGo(await res.text(), { maxHits: page.maxHits });
    }

    throw lastErr ?? new DdgError("busca no DuckDuckGo falhou");
  }

  return { search, name: "duckduckgo" as const };
}
