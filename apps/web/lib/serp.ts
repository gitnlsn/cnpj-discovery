import "server-only";
import { join } from "node:path";
import { and, gte, inArray, sql } from "drizzle-orm";
import { usage, type Db } from "@cnpj/db";
import { createDdgSearch, DDG_SKU, type PresenceProvider } from "@cnpj/core";
import { createSerpDriver } from "@cnpj/serp";

/**
 * Web search, wired to a self-imposed ceiling.
 *
 * There is no vendor quota here to respect — nobody is selling us these queries
 * — so the `Budget` class would be modelling an allowance that does not exist.
 * What does exist is a limit on how much scraping is reasonable before an engine
 * starts refusing, and that limit is ours to choose. So this follows
 * `llm-budget.ts` instead: a daily count in `usage`, an env override, and a
 * brake a runaway loop hits locally.
 *
 * Gated on `SERP_ENABLED` rather than on a key, because there is no key. Off by
 * default: this scrapes two search engines, and that should be a decision
 * somebody made on purpose.
 */

export const GOOGLE_SKU = "serp.google";

/** Both engines share one ceiling — the point is total volume, not per-engine. */
const SKUS = [DDG_SKU, GOOGLE_SKU];

/**
 * Conservative on purpose.
 *
 * A few hundred queries a day is enough to work through a project over a week
 * and low enough to stay unremarkable. Raising this is the first thing that will
 * get the IP challenged, which is why it is a number in the environment rather
 * than a constant somebody tunes upward in a hurry.
 */
export function dailyLimit(): number {
  const raw = Number(process.env.SERP_DAILY_QUERIES);
  // Default lowered from 200 after both engines refused this IP inside a few
  // dozen queries. 40 is chosen from what actually survived, not from what
  // seemed polite — and it is a per-day figure, so a project is worked through
  // over a week rather than in an afternoon.
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 40;
}

export function serpEnabled(): boolean {
  return process.env.SERP_ENABLED === "1" || process.env.SERP_ENABLED === "true";
}

/**
 * Whether Google is in the chain at all.
 *
 * Opt-IN, not opt-out. Google is the half that needs a browser, draws the
 * CAPTCHAs, and served a hard 403 on this IP; DuckDuckGo answers most companies
 * with a plain fetch. Making the fragile half the thing you have to ask for
 * matches which one actually works.
 */
export function googleEnabled(): boolean {
  return serpEnabled() && process.env.SERP_GOOGLE === "on";
}

/**
 * A cooldown after an engine refuses us.
 *
 * This is the difference between "we got blocked" and "we stayed blocked". A
 * block is reputation attached to the egress IP, and it decays on its own — but
 * only if nothing keeps poking it. Without this, the natural response to a
 * failed run is to press the button again, which is precisely what converts a
 * short rate-limit into a long one.
 *
 * In-process on purpose: the lifetime that matters is this dev server's, and a
 * restart is a deliberate act by somebody who has read the message.
 */
let blockedUntil = 0;
let blockStrikes = 0;

/** Escalating: a quarter of an hour, then an hour, then four. */
const COOLDOWNS_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];

export function noteBlocked(): void {
  const step = Math.min(blockStrikes, COOLDOWNS_MS.length - 1);
  blockedUntil = Date.now() + COOLDOWNS_MS[step]!;
  blockStrikes++;
}

/** Milliseconds left on the cooldown, or 0 when clear. */
export function blockedFor(): number {
  return Math.max(0, blockedUntil - Date.now());
}

export function clearBlock(): void {
  blockedUntil = 0;
  blockStrikes = 0;
}

const today = () => new Date().toISOString().slice(0, 10);

export async function usedToday(db: Db): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usage.count}), 0)` })
    .from(usage)
    .where(and(inArray(usage.kind, SKUS), gte(usage.day, today())));
  return Number(row?.total ?? 0);
}

export async function remainingToday(db: Db): Promise<number> {
  return Math.max(0, dailyLimit() - (await usedToday(db)));
}

/** Records queries already made. After the request, never before. */
export async function recordSerp(db: Db, sku: string, n = 1): Promise<void> {
  await db
    .insert(usage)
    .values({ day: today(), kind: sku, count: n })
    .onConflictDoUpdate({
      target: [usage.day, usage.kind],
      set: { count: sql`${usage.count} + ${n}` },
    });
}

export interface SerpChain {
  providers: PresenceProvider[];
  close(): Promise<void>;
}

/**
 * The ordered chain: DuckDuckGo, then Google.
 *
 * DDG first because it is browserless, unmetered and tolerant — most companies
 * will be answered without Chrome ever starting. Google is the escalation for
 * the ones DDG could not answer, and it is the expensive, fragile, blockable
 * one, so it goes second and only runs when needed.
 *
 * Returns null when the feature is off, following the convention in
 * `places.ts`: a port that cannot work should not exist.
 */
export function serpFor(
  db: Db,
  opts: {
    cancelled?: () => boolean;
    onCaptcha?: (info: { query: string; reason: string; waitingMs: number }) => void;
    onCaptchaResolved?: (info: { outcome: string; waitedMs: number }) => void;
  } = {}
): SerpChain | null {
  if (!serpEnabled()) return null;

  const providers: PresenceProvider[] = [];

  const ddg = createDdgSearch({ afterRequest: () => recordSerp(db, DDG_SKU) });
  providers.push(ddg);

  let closeGoogle: (() => Promise<void>) | null = null;
  if (googleEnabled()) {
    // The profile is persisted so a solved CAPTCHA and the consent choice
    // survive the run — otherwise every session starts by asking a person again.
    const driver = createSerpDriver({
      userDataDir: process.env.SERP_PROFILE_DIR ?? join(process.cwd(), ".serp-profile"),
      executablePath: process.env.SERP_CHROME_PATH,
      // Headful by default: a hidden window cannot be handed to a human when
      // Google asks for a CAPTCHA, and that handoff is the whole strategy.
      headless: process.env.SERP_HEADLESS === "1",
      captchaTimeoutMs: Number(process.env.SERP_CAPTCHA_TIMEOUT_MS) || undefined,
      cancelled: opts.cancelled,
      onCaptcha: opts.onCaptcha,
      onCaptchaResolved: opts.onCaptchaResolved,
    });
    closeGoogle = driver.close;
    providers.push({
      name: driver.name,
      async search(query: string) {
        const page = await driver.search(query);
        // Counted whether or not it matched: a query that returns nothing was
        // still a query Google saw.
        await recordSerp(db, GOOGLE_SKU);
        return page;
      },
    });
  }

  return {
    providers,
    async close() {
      await closeGoogle?.();
    },
  };
}
