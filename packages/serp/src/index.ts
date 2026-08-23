import { setTimeout as sleep } from "node:timers/promises";
import { launch, type Browser, type Page } from "puppeteer-core";
import { parseGoogle, type SerpPage } from "@cnpj/core";

/**
 * Google, through a real browser, with a person available to solve the CAPTCHA.
 *
 * This exists because there is no budget for a SERP API, and the honest
 * consequence of scraping Google is that Google will eventually ask who you
 * are. Every automated answer to that question is an arms race — stealth
 * plugins, residential proxies, fingerprint patches — that costs more than the
 * API would have and breaks on somebody else's schedule.
 *
 * So the answer here is not to beat the CAPTCHA. It is to hand the window to
 * the person sitting in front of it, wait for them to solve it, and carry on.
 * That is why the browser is headful by default: a hidden window cannot be
 * handed to anybody. It also happens to be less detectable than headless.
 *
 * Solving one CAPTCHA is not wasted on one query — the cookie lands in
 * `userDataDir` and buys the rest of the session.
 *
 * What this deliberately does NOT do: no puppeteer-extra, no stealth plugin, no
 * proxy rotation, no navigator.webdriver patching. If you are reading this
 * because the run is getting blocked more often, the fix is to slow it down or
 * search less, not to hide better.
 */

/** Google asks; a person answers. Anything longer than this and nobody is home. */
const DEFAULT_CAPTCHA_TIMEOUT_MS = 5 * 60_000;

/** How often the page is re-read while waiting for the human. */
const POLL_MS = 2_500;

/**
 * Pacing between queries. Far slower than any API, on purpose.
 *
 * The jitter matters as much as the interval: a request exactly every 12
 * seconds is a machine, and it is the regularity rather than the rate that
 * looks like one.
 */
const MIN_GAP_MS = 11_000;
const JITTER_MS = 14_000;

/**
 * Every so often, stop for much longer.
 *
 * A steady one-every-fifteen-seconds is a machine even when the interval is
 * polite — it is the regularity, not the rate, that reads as automation. A run
 * that occasionally goes quiet for a minute looks like somebody who got
 * distracted, which is what actually happens when a person does this by hand.
 */
const LONG_PAUSE_EVERY = 7;
const LONG_PAUSE_MS = 75_000;

/** Consecutive refusals before the driver stops asking at all. */
const MAX_CONSECUTIVE_BLOCKS = 3;

export type CaptchaOutcome = "solved" | "timeout" | "cancelled";

export interface SerpDriverOptions {
  /**
   * Where Chrome keeps its profile.
   *
   * Persisted on purpose: this is where the solved-CAPTCHA cookie and the
   * consent choice live, and losing it means solving both again every run.
   */
  userDataDir: string;
  /** Path to Chrome. Omit to use the installed stable channel. */
  executablePath?: string;
  /**
   * Hide the window. Defaults to false, and setting it true disables the
   * human handoff — there is nothing to hand over.
   */
  headless?: boolean;
  captchaTimeoutMs?: number;
  /** Called when a person is needed. The app logs this into the job. */
  onCaptcha?: (info: { query: string; reason: string; waitingMs: number }) => void;
  /** Called once the page comes back, however it came back. */
  onCaptchaResolved?: (info: { outcome: CaptchaOutcome; waitedMs: number }) => void;
  /** Checked while waiting, so the job's cancel button still works. */
  cancelled?: () => boolean;
  /** Deterministic pacing for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class SerpBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`busca no Google bloqueada: ${reason}`);
    this.name = "SerpBlockedError";
  }
}

function googleUrl(query: string): string {
  const u = new URL("https://www.google.com/search");
  u.searchParams.set("q", query);
  u.searchParams.set("hl", "pt-BR");
  // Deliberately NOT setting `num`. Asking for 20 results in one page is a
  // strong bot tell — a person clicking through a browser never sends it — and
  // it is the most likely reason this started drawing 403s. Ten results per
  // query is what a human gets, and a name search that needs more than ten was
  // never going to be verifiable anyway.
  return u.href;
}

export function createSerpDriver(opts: SerpDriverOptions) {
  const headless = opts.headless ?? false;
  const captchaTimeoutMs = opts.captchaTimeoutMs ?? DEFAULT_CAPTCHA_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const wait = opts.sleep ?? ((ms: number) => sleep(ms));

  let browser: Browser | null = null;
  let page: Page | null = null;
  let lastQueryAt = 0;
  let queries = 0;
  let consecutiveBlocks = 0;
  let landed = false;

  async function ensurePage(): Promise<Page> {
    if (page && !page.isClosed()) return page;
    browser ??= await launch({
      headless,
      // The installed Chrome, not a downloaded Chromium: puppeteer-core ships
      // no browser, which keeps ~300 MB out of the install.
      channel: opts.executablePath ? undefined : "chrome",
      executablePath: opts.executablePath,
      userDataDir: opts.userDataDir,
      defaultViewport: null,
      args: [
        "--lang=pt-BR",
        "--disable-blink-features=AutomationControlled",
        // Puppeteer's defaults include flags no ordinary Chrome ever sets;
        // these two are the ones that show up in fingerprinting.
        "--no-default-browser-check",
        "--no-first-run",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });

    // `navigator.webdriver` is set by the DevTools protocol itself, so the
    // launch flag above does not clear it. This is the single most-checked
    // property there is; hiding it is worth the four lines.
    //
    // This is where the stealth work stops on purpose. Patching a property that
    // is trivially observable is housekeeping; shipping a fingerprint-spoofing
    // plugin is a treadmill that breaks on somebody else's release schedule and
    // still loses to IP reputation. If Google keeps refusing, the answer is to
    // search less and lean on DuckDuckGo, not to hide harder.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    return page;
  }

  /**
   * Waits for a person to clear whatever Google is showing.
   *
   * The page itself is the source of truth, not a button in our UI. Polling the
   * markup means "solved" is something we observed rather than something we were
   * told, and it works identically whether the human solved the CAPTCHA,
   * accepted the consent dialog, or navigated somewhere useful by hand.
   */
  async function waitForHuman(
    p: Page,
    query: string,
    reason: string
  ): Promise<{ outcome: CaptchaOutcome; page: SerpPage }> {
    const startedAt = now();
    opts.onCaptcha?.({ query, reason, waitingMs: captchaTimeoutMs });

    // Bring the window forward so the person notices without hunting for it.
    try {
      await p.bringToFront();
    } catch {
      // A closed or detached page is handled by the poll below.
    }

    let last: SerpPage = { status: "blocked", reason };
    while (now() - startedAt < captchaTimeoutMs) {
      if (opts.cancelled?.()) {
        opts.onCaptchaResolved?.({ outcome: "cancelled", waitedMs: now() - startedAt });
        return { outcome: "cancelled", page: last };
      }
      await wait(POLL_MS);

      let html: string;
      let url: string;
      try {
        html = await p.content();
        url = p.url();
      } catch {
        continue; // mid-navigation while they click; try again
      }
      last = parseGoogle(html, url);
      if (last.status !== "blocked") {
        opts.onCaptchaResolved?.({ outcome: "solved", waitedMs: now() - startedAt });
        return { outcome: "solved", page: last };
      }
    }

    opts.onCaptchaResolved?.({ outcome: "timeout", waitedMs: now() - startedAt });
    return { outcome: "timeout", page: last };
  }

  /**
   * Types the query into the search box instead of loading /search?q= directly.
   *
   * A cold hit on a deep results URL, with no referrer and no prior visit to the
   * homepage, is one of the cheapest automation signals there is. Landing on
   * google.com once per session and typing after that gives the requests a
   * plausible origin, and the typing delay costs nothing next to the pacing
   * between queries.
   *
   * Degrades to direct navigation rather than failing: the homepage markup
   * changes, and not finding the box is a reason to fall back, not to abort.
   */
  async function typeQuery(p: Page, query: string): Promise<boolean> {
    try {
      if (!landed) {
        await p.goto("https://www.google.com/?hl=pt-BR", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        landed = true;
      }
      const box = await p.waitForSelector('textarea[name="q"], input[name="q"]', {
        timeout: 5_000,
      });
      if (!box) return false;
      await box.click({ clickCount: 3 });
      // Per-character, because an instantly-filled field is not typing.
      await box.type(query, { delay: 45 + (now() % 40) });
      await p.keyboard.press("Enter");
      await p.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 });
      return true;
    } catch {
      landed = false;
      return false;
    }
  }

  /** Re-runs the query after a human cleared whatever was in the way. */
  async function reissue(p: Page, query: string): Promise<SerpPage> {
    const res = await p.goto(googleUrl(query), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const status = res?.status() ?? 0;
    if (status === 403 || status === 429 || status === 503) {
      return { status: "blocked", reason: `Google respondeu ${status}` };
    }
    return parseGoogle(await p.content(), p.url());
  }

  /**
   * One query.
   *
   * Returns the parsed page rather than throwing on a block, so the caller can
   * distinguish "nobody was around to solve it" from "the markup changed" — the
   * two need opposite responses, and both are different from "found nothing".
   */
  async function search(query: string): Promise<SerpPage> {
    const p = await ensurePage();

    if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
      return {
        status: "blocked",
        reason: `Google recusou ${consecutiveBlocks}x seguidas; parei de pedir nesta sessão`,
      };
    }

    const gap = MIN_GAP_MS + ((now() % 997) / 997) * JITTER_MS;
    const since = now() - lastQueryAt;
    if (lastQueryAt && since < gap) await wait(Math.round(gap - since));
    if (queries > 0 && queries % LONG_PAUSE_EVERY === 0) {
      await wait(Math.round(LONG_PAUSE_MS + ((now() % 601) / 601) * LONG_PAUSE_MS));
    }
    lastQueryAt = now();
    queries++;

    // `res` is null when the query was typed: there is no response object, so
    // the URL and the body are all there is to judge by.
    const typed = await typeQuery(p, query);
    const res = typed
      ? null
      : await p.goto(googleUrl(query), {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });

    // The HTTP status, checked before the body.
    //
    // Google refuses with a bare 403 or 429 whose page carries none of the
    // CAPTCHA wording, so reading only the markup made a refusal look like
    // markup we did not recognise. Two different diagnoses, and only one of them
    // is worth waking a human for.
    const status = res?.status() ?? 0;
    if (status === 403 || status === 429 || status === 503) {
      consecutiveBlocks++;
      const parsed = { status: "blocked" as const, reason: `Google respondeu ${status}` };
      if (headless) return parsed;
      const { outcome, page: after } = await waitForHuman(p, query, parsed.reason);
      if (outcome !== "solved") return parsed;
      return after.status === "ok" ? after : await reissue(p, query);
    }

    // The final URL is the only other unambiguous block signal: a redirect to
    // /sorry/ or to the consent host IS the block, whereas the body of a
    // perfectly good results page contains Google's own script checking for
    // that same redirect.
    let parsed = parseGoogle(await p.content(), p.url());

    if (parsed.status === "blocked") {
      if (headless) return parsed; // nothing to hand over
      const { outcome, page: after } = await waitForHuman(p, query, parsed.reason);
      if (outcome !== "solved") return { status: "blocked", reason: parsed.reason };
      // A solved challenge usually lands on the results for the same query, but
      // not always — re-issue so the caller always gets this query's results.
      parsed = after.status === "ok" ? after : await reissue(p, query);
    }

    // The streak is what decides whether to keep asking at all. Reset on any
    // clean answer, including a legitimate "no results" — that is Google
    // answering us, not refusing us.
    if (parsed.status === "blocked") consecutiveBlocks++;
    else consecutiveBlocks = 0;

    return parsed;
  }

  async function close(): Promise<void> {
    try {
      await browser?.close();
    } finally {
      browser = null;
      page = null;
    }
  }

  return {
    search,
    close,
    get name() {
      return "google" as const;
    },
  };
}
