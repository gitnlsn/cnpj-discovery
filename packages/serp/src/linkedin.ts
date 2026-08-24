import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, type Page } from "puppeteer-core";
import {
  detectWall,
  parseEntityAbout,
  parseProfile,
  type LinkedInPageResult,
} from "@cnpj/core";
import { profileDir } from "./profile";
import { launchProfileBrowser, hardenPage } from "./browser";

/**
 * Fetching LinkedIn pages through the signed-in browser.
 *
 * ## Read this before turning it on
 *
 * This deliberately reverses a decision the codebase used to state in prose.
 * `domain/linkedin.ts` opened by saying we never fetch linkedin.com, because its
 * robots.txt is `User-agent: *` → `Disallow: /` — a blanket prohibition — and
 * `crawlSite` honours robots and would refuse. All of that is still true. This
 * module does not go through `crawlSite`; it drives a browser, and a browser does
 * not consult robots.txt. So the override is not a flag being flipped, it is a
 * choice being made, and it is written here in full rather than left implicit:
 *
 * **We are fetching pages the site's robots.txt asks us not to fetch.**
 *
 * The consequences, honestly stated, because they are not symmetrical with the
 * Google driver's:
 *
 * - Google refuses by IP, and the refusal decays on its own. LinkedIn refuses by
 *   *account*, and its restrictions are frequently permanent. The cooldown ladder
 *   that protects a Google run cannot undo an account restriction.
 * - Every request here is attributable to one identity, because it is signed in.
 *   Signing in is what makes the pages readable at all, and it is also what
 *   converts "some IP scraped us" into "this member scraped us".
 * - Viewing a *person's* profile while signed in is visible to that person, in
 *   their "quem viu seu perfil". Fetching a hundred profiles means a hundred
 *   strangers can see the account that did it. Entity pages carry no such
 *   footprint, which is the main reason `entity` is the cheaper mode.
 *
 * Which is why: off unless `LINKEDIN_ENABLED=1`, a small daily ceiling, pacing
 * far slower than the Google driver's, and a hard stop the first time LinkedIn
 * shows a checkpoint rather than a retry loop. Use a throwaway account —
 * `pnpm serp:login` says so every time it runs.
 *
 * ## What this does not do
 *
 * No stealth plugin, no fingerprint patching, no proxy rotation, no retry after a
 * checkpoint. Same position as the Google driver, and for a stronger reason: on
 * LinkedIn the thing an arms race puts at risk is not a day of throughput, it is
 * the account.
 */

/** LinkedIn's own rate-limit status, which is not in any RFC. */
export const LINKEDIN_RATE_LIMIT_STATUS = 999;

/**
 * Pacing, far slower than the Google driver's 11–25 s.
 *
 * A signed-in member who opens a company page every forty seconds for an hour is
 * already unusual; one who does it every eight seconds is a script and will be
 * treated as one. This is the single most important number in the file, which is
 * why it is not configurable downward — `LINKEDIN_MIN_GAP_MS` can only raise it.
 */
const MIN_GAP_MS = 40_000;
const JITTER_MS = 35_000;

/** Every so often, stop for much longer — the same reasoning as the SERP driver. */
const LONG_PAUSE_EVERY = 5;
const LONG_PAUSE_MS = 180_000;

/** How long to wait for a person to clear a sign-in wall. */
const DEFAULT_WALL_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 3_000;

export type LinkedInMode = "entity" | "profile";

/**
 * What one fetch produced.
 *
 * An alias rather than its own shape: the type is declared in `@cnpj/core`
 * beside the parsers so the enrichment loop can name it without depending on
 * Puppeteer. See `LinkedInPageResult` for why it has three arms and not two.
 */
export type LinkedInFetch = LinkedInPageResult;

export interface LinkedInDriverOptions {
  /** Defaults to the shared crawler profile — the one `pnpm serp:login` opens. */
  userDataDir?: string;
  executablePath?: string;
  /**
   * Hide the window. Defaults to false for the same reason the SERP driver does:
   * a hidden window cannot be handed to a person when LinkedIn asks who they are.
   */
  headless?: boolean;
  wallTimeoutMs?: number;
  minGapMs?: number;
  /** Called when a person is needed. */
  onWall?: (info: { url: string; wall: string; waitingMs: number }) => void;
  onWallResolved?: (info: {
    outcome: "solved" | "timeout" | "cancelled";
    waitedMs: number;
  }) => void;
  /** Called before each pause, so a job log can explain the silence. */
  onPacing?: (info: { ms: number; reason: "gap" | "long-pause" }) => void;
  cancelled?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createLinkedInDriver(opts: LinkedInDriverOptions = {}) {
  const headless = opts.headless ?? false;
  const wallTimeoutMs = opts.wallTimeoutMs ?? DEFAULT_WALL_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const wait = opts.sleep ?? ((ms: number) => sleep(ms));
  // Raise-only: see MIN_GAP_MS. A caller that wants to go faster than this is
  // asking for the account to be restricted, and the answer is no.
  const minGap = Math.max(MIN_GAP_MS, opts.minGapMs ?? 0);

  let browser: Browser | null = null;
  let page: Page | null = null;
  let lastFetchAt = 0;
  let fetches = 0;
  /**
   * Set the first time LinkedIn shows a challenge, and never cleared.
   *
   * One-way on purpose. A checkpoint is LinkedIn saying it has noticed; carrying
   * on after one — even slowly, even after a person clears it — is what turns a
   * warning into a restriction. The run ends and somebody decides whether to
   * start another one.
   */
  let stopped: string | null = null;

  async function ensurePage(): Promise<Page> {
    if (page && !page.isClosed()) return page;
    browser ??= await launchProfileBrowser({
      headless,
      executablePath: opts.executablePath,
      // The same profile the SERP driver uses and `pnpm serp:login` signs into.
      // Sharing it is the point: one login serves both.
      userDataDir: opts.userDataDir ?? profileDir(),
    });
    page = await browser.newPage();
    await hardenPage(page);
    return page;
  }

  /** The pause before a fetch. Long, jittered, and occasionally much longer. */
  async function pace(): Promise<void> {
    const gap = minGap + ((now() % 997) / 997) * JITTER_MS;
    const since = now() - lastFetchAt;
    if (lastFetchAt && since < gap) {
      const ms = Math.round(gap - since);
      opts.onPacing?.({ ms, reason: "gap" });
      await wait(ms);
    }
    if (fetches > 0 && fetches % LONG_PAUSE_EVERY === 0) {
      const ms = Math.round(LONG_PAUSE_MS + ((now() % 601) / 601) * LONG_PAUSE_MS);
      opts.onPacing?.({ ms, reason: "long-pause" });
      await wait(ms);
    }
  }

  /**
   * Waits for a person to sign in, then re-reads the page.
   *
   * Only for `auth`. A checkpoint is not waited on: a person *can* clear it, but
   * the run stops regardless, so waiting would only delay the stop.
   */
  async function waitForLogin(p: Page, url: string): Promise<boolean> {
    const startedAt = now();
    opts.onWall?.({ url, wall: "auth", waitingMs: wallTimeoutMs });
    try {
      await p.bringToFront();
    } catch {
      // Handled by the poll below.
    }

    while (now() - startedAt < wallTimeoutMs) {
      if (opts.cancelled?.()) {
        opts.onWallResolved?.({ outcome: "cancelled", waitedMs: now() - startedAt });
        return false;
      }
      await wait(POLL_MS);
      try {
        if (detectWall(await p.content(), p.url()) === null) {
          opts.onWallResolved?.({ outcome: "solved", waitedMs: now() - startedAt });
          return true;
        }
      } catch {
        continue; // mid-navigation while they click
      }
    }
    opts.onWallResolved?.({ outcome: "timeout", waitedMs: now() - startedAt });
    return false;
  }

  /**
   * One page.
   *
   * Returns a discriminated result rather than throwing, for the same reason
   * `findPresence` does: "the page is gone", "we were refused" and "we read it"
   * need three different responses, and collapsing any two of them into an
   * exception is how a blocked run gets recorded as an empty one.
   */
  async function fetch(url: string, mode: LinkedInMode): Promise<LinkedInFetch> {
    if (stopped) {
      return { status: "blocked", url, wall: "checkpoint", reason: stopped };
    }
    if (opts.cancelled?.()) {
      return { status: "blocked", url, wall: "checkpoint", reason: "cancelado" };
    }

    const p = await ensurePage();
    await pace();
    lastFetchAt = now();
    fetches++;

    let res;
    try {
      res = await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (err) {
      // A timeout is not a block and must not set `stopped` — LinkedIn pages are
      // heavy and a slow one is just slow.
      return {
        status: "blocked",
        url,
        wall: "auth",
        reason: `não carregou: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const status = res?.status() ?? null;
    let html = await p.content();
    let wall = detectWall(html, p.url(), status);

    if (wall === "auth" && !headless) {
      if (await waitForLogin(p, url)) {
        html = await p.content();
        wall = detectWall(html, p.url(), null);
      }
    }

    if (wall === "checkpoint") {
      stopped =
        `o LinkedIn pediu verificação de segurança. Parei a rodada inteira: insistir depois ` +
        `de um checkpoint é o que transforma um aviso em restrição de conta, e a restrição ` +
        `dele não passa sozinha como o bloqueio do Google.`;
      return { status: "blocked", url, wall, reason: stopped };
    }
    if (wall === "gone") return { status: "gone", url };
    if (wall === "auth") {
      return {
        status: "blocked",
        url,
        wall,
        reason: "o LinkedIn pediu login e ninguém entrou. Rode `pnpm serp:login`.",
      };
    }

    return mode === "entity"
      ? { status: "ok", url: p.url(), mode: "entity", facts: parseEntityAbout(html) }
      : { status: "ok", url: p.url(), mode: "profile", facts: parseProfile(html) };
  }

  return {
    fetch,
    /** Set once LinkedIn has shown a challenge. The caller must stop asking. */
    get stopped(): string | null {
      return stopped;
    },
    async close(): Promise<void> {
      try {
        await browser?.close();
      } finally {
        browser = null;
        page = null;
      }
    },
  };
}

export type LinkedInDriver = ReturnType<typeof createLinkedInDriver>;
