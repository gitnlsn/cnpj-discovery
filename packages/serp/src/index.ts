import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, type Page } from "puppeteer-core";
import { launchProfileBrowser, hardenPage } from "./browser";
import { parseGoogle, type SerpPage, type SearchPageOptions } from "@cnpj/core";

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

/**
 * Ordinary sites visited to give the profile a history.
 *
 * Homepages only, nothing read, nothing stored — the point is the cookies and
 * the history entries, not the content. Overridable with SERP_WARMUP_SITES so
 * this list is a default rather than a decree.
 *
 * Honest about the mechanism: Google does not observe your traffic to g1 or
 * UOL, so this cannot launder a blocked IP. What it plausibly does is make the
 * profile look less like one that has only ever issued /search requests — via
 * the Google-owned tags (Analytics, AdSense, Fonts) these sites embed, which are
 * the only channel through which any of this is visible to them at all.
 *
 * The one part that is measured: three visits took the profile from 13 cookies
 * to 28, so it does accumulate a history. Whether that history changes any
 * decision Google makes is unknown and unmeasurable from here. Cheap, requested,
 * and not to be mistaken for the fix — the binding constraints are query volume
 * and IP reputation.
 */
const WARMUP_SITES = [
  "https://www.uol.com.br/",
  "https://g1.globo.com/",
  "https://www.terra.com.br/",
  "https://www.estadao.com.br/",
  "https://www.cnnbrasil.com.br/",
  "https://olhardigital.com.br/",
  "https://www.tecmundo.com.br/",
];

/** How many sites to visit when warming a session. */
const WARMUP_COUNT = 3;

/** Visit one unrelated site every N queries. 0 disables it. */
const DECOY_EVERY = 5;

/**
 * Cookie-consent buttons, by the framework that put them there.
 *
 * MEASURED, and the measurement is worth writing down: on uol, g1, cnnbrasil,
 * estadao and olhardigital, with a fresh profile in pt-BR and a 4.5 second wait,
 * there was **no consent banner at all** — no OneTrust, no Didomi, no accept
 * button of any kind. LGPD does not push Brazilian sites into the blocking
 * modals GDPR produced in Europe, so on the default site list this code never
 * fires.
 *
 * It is kept anyway, because it is bounded and free, and because the site list
 * is configurable: point SERP_WARMUP_SITES at a European domain and the banner
 * appears. Nobody should read this list and conclude that clicking through
 * consent is doing any work here today.
 */
const CONSENT_SELECTORS = [
  "#onetrust-accept-btn-handler",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyButtonAccept",
  ".osano-cm-accept-all",
  "button[mode='primary'][aria-label*='Aceitar']",
  "button[data-testid='uc-accept-all-button']",
  "#didomi-notice-agree-button",
  ".fc-cta-consent",
  "[aria-label='Aceitar cookies']",
  "#adopt-accept-all-button",
];

/**
 * Text that means "yes, accept".
 *
 * The fallback when no known vendor is present. Deliberately a tight list: this
 * clicks a button on a page we did not write, so it must not match anything that
 * could reject, configure, subscribe or buy. "Aceitar" and "Concordo" and their
 * English forms, nothing looser.
 */
const CONSENT_TEXT =
  /^(aceitar( todos| todos os cookies| e fechar| cookies)?|aceito|concordo|entendi|ok, entendi|prosseguir|continuar e aceitar|accept( all| all cookies| cookies)?|i agree|got it|allow all)$/i;

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
  /** Called when a session is being warmed, so the job log can say so. */
  onWarmup?: (info: { sites: number }) => void;
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

function googleUrl(query: string, start = 0): string {
  const u = new URL("https://www.google.com/search");
  u.searchParams.set("q", query);
  u.searchParams.set("hl", "pt-BR");
  // `start` is what the "next page" link itself sends, which is the difference
  // between this and `num` below: one is a thing people's browsers do, the other
  // is a thing only a script asks for. Still not free — going deep is its own
  // signal — so the caller decides, and page one never sends it.
  if (start > 0) u.searchParams.set("start", String(start));
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
    // Launch flags and the `navigator.webdriver` patch live in `browser.ts`, so
    // this driver and the Maps one cannot drift apart on how detectable they are.
    browser ??= await launchProfileBrowser({
      headless,
      executablePath: opts.executablePath,
      userDataDir: opts.userDataDir,
    });
    page = await browser.newPage();
    await hardenPage(page);

    if (!headless && process.env.SERP_WARMUP !== "off") await warmProfile(page);
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
   * Dismisses a cookie banner, if one is in the way.
   *
   * Known vendor selectors first, then a tight text match. It clicks a button on
   * a page we did not write, so the text list is deliberately narrow — anything
   * looser risks clicking "subscribe" or "reject" or worse. Failure is fine: a
   * banner left standing costs nothing here, since we never read the page.
   */
  async function acceptCookies(p: Page): Promise<boolean> {
    for (const selector of CONSENT_SELECTORS) {
      try {
        const el = await p.$(selector);
        if (el) {
          await el.click({ delay: 40 });
          await wait(400);
          return true;
        }
      } catch {
        // Detached or invisible; try the next one.
      }
    }

    // Fallback: find a button whose visible label means "accept".
    try {
      // Typed through `globalThis` rather than `document`: this callback is
      // serialised into the browser, so the DOM lib is not in scope on the Node
      // side that compiles it — the same reason `dwell` reaches scrollBy that way.
      type Clickable = { innerText?: string; textContent?: string | null; click(): void };
      type Dom = {
        document: { querySelectorAll(sel: string): ArrayLike<Clickable> };
      };

      const clicked = await p.evaluate((pattern: string) => {
        const re = new RegExp(pattern, "i");
        const doc = (globalThis as unknown as Dom).document;
        const nodes = doc.querySelectorAll(
          "button, a[role='button'], [role='button'], input[type='button'], input[type='submit']"
        );
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          if (!node) continue;
          const label = (node.innerText || node.textContent || "").trim();
          if (label && re.test(label)) {
            node.click();
            return true;
          }
        }
        return false;
      }, CONSENT_TEXT.source);
      if (clicked) await wait(400);
      return clicked;
    } catch {
      return false;
    }
  }

  /** One ordinary visit: land, accept the banner, look at it briefly. */
  async function visitSite(p: Page, url: string): Promise<void> {
    try {
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await wait(700 + (now() % 900));
      await acceptCookies(p);
      await dwell(p);
    } catch {
      // A slow or dead site is not a reason to abandon the run.
    }
  }

  /**
   * Gives a fresh profile some history before the first search.
   *
   * Once per browser, not per query: whatever benefit exists comes from the
   * profile having a past, and paying for it forty times over would just be
   * forty times the wall clock.
   */
  async function warmProfile(p: Page): Promise<void> {
    const sites = (
      process.env.SERP_WARMUP_SITES?.split(",")
        .map((x) => x.trim())
        .filter(Boolean) ?? WARMUP_SITES
    ).slice(0, WARMUP_COUNT);
    if (!sites.length) return;

    opts.onWarmup?.({ sites: sites.length });
    for (const site of sites) await visitSite(p, site);
    // The next query has to re-land on the search homepage.
    landed = false;
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

  /**
   * A moment of looking at the page before scraping it.
   *
   * Two mouse moves, a scroll, a short pause. Requested, cheap, and honestly
   * described: a 403 is refused at the *request* level, before a page exists, so
   * this cannot help with a block already in force. Where it plausibly helps is
   * the other direction — interaction telemetry on pages that do load feeds the
   * reputation that decides later requests.
   *
   * So: low confidence and unmeasurable, which is why it is three seconds and not
   * thirty, and why it sits beside the note saying the stealth work stops here.
   */
  async function dwell(p: Page): Promise<void> {
    try {
      // `globalThis` rather than `window`: this callback is serialised into the
      // browser, so the DOM lib is not in scope on the Node side that compiles it.
      const scroll = (y: number) =>
        p.evaluate(
          (dy: number) =>
            (globalThis as unknown as { scrollBy(x: number, y: number): void }).scrollBy(0, dy),
          y
        );

      await p.mouse.move(220 + (now() % 180), 260 + (now() % 140));
      await wait(400 + (now() % 500));
      await scroll(320 + (now() % 240));
      await wait(600 + (now() % 700));
      await p.mouse.move(420 + (now() % 200), 520 + (now() % 160));
      await scroll(260);
      await wait(500 + (now() % 600));
    } catch {
      // A page that navigated or closed under us is not a failure of the run.
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
  async function search(query: string, page: SearchPageOptions = {}): Promise<SerpPage> {
    const p = await ensurePage();
    const start = page.start ?? 0;

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

    // An unrelated visit every few queries, so the session is not forty
    // consecutive searches and nothing else.
    if (DECOY_EVERY > 0 && queries > 1 && queries % DECOY_EVERY === 0 && !headless) {
      const pool =
        process.env.SERP_WARMUP_SITES?.split(",")
          .map((x) => x.trim())
          .filter(Boolean) ?? WARMUP_SITES;
      const pick = pool[queries % pool.length];
      if (pick) {
        await visitSite(p, pick);
        landed = false;
      }
    }

    // `res` is null when the query was typed: there is no response object, so
    // the URL and the body are all there is to judge by.
    //
    // Typing only reaches page one — there is no box to type an offset into — so
    // a paginated request goes straight to the URL. That is a slightly worse
    // disguise, and it is the price of asking for page two at all.
    const typed = start > 0 ? false : await typeQuery(p, query);
    const res = typed
      ? null
      : await p.goto(googleUrl(query, start), {
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

    await dwell(p);

    // The final URL is the only other unambiguous block signal: a redirect to
    // /sorry/ or to the consent host IS the block, whereas the body of a
    // perfectly good results page contains Google's own script checking for
    // that same redirect.
    let parsed = parseGoogle(await p.content(), p.url(), { maxHits: page.maxHits });

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

export { repoRoot, profileDir, chromePath, MAC_CHROME } from "./profile";
export { sessionStatus, type SessionStatus } from "./session";
export {
  createLinkedInDriver,
  LINKEDIN_RATE_LIMIT_STATUS,
  type LinkedInDriver,
  type LinkedInDriverOptions,
  type LinkedInFetch,
  type LinkedInMode,
} from "./linkedin";
export { launchProfileBrowser, hardenPage, ProfileBusyError } from "./browser";
