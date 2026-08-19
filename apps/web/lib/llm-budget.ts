import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { usage, type Db } from "@cnpj/db";
import { provider } from "./llm";

/**
 * A daily ceiling on model requests.
 *
 * Free OpenRouter models allow 50 requests a day, or 1,000 once the account has
 * ever bought credits. Nothing enforced that before, which was survivable while
 * every run was a button press with a number on it — a loop that never stops on
 * its own is a different proposition.
 *
 * Counted in the same `usage` table as the Google quota, so "what did today
 * cost" has one place to look.
 */
export const LLM_KIND = "llm.requests";

/**
 * A local ceiling, defaulted to whatever the chosen provider actually gives.
 *
 * OpenRouter's free models allow 50 a day; Gemini's free tier is several
 * hundred per model. Defaulting both to 50 would have stopped a Gemini run
 * eight times earlier than necessary. The provider still enforces its own
 * limit — this is only so a runaway loop has a local brake as well.
 */
export function dailyLimit(): number {
  const raw = Number(process.env.LLM_DAILY_REQUESTS ?? process.env.OPENROUTER_DAILY_REQUESTS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return provider() === "gemini" ? 1000 : 50;
}

const today = () => new Date().toISOString().slice(0, 10);

export async function usedToday(db: Db): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usage.count}), 0)` })
    .from(usage)
    .where(and(eq(usage.kind, LLM_KIND), gte(usage.day, today())));
  return Number(row?.total ?? 0);
}

export async function remainingToday(db: Db): Promise<number> {
  return Math.max(0, dailyLimit() - (await usedToday(db)));
}

/** Records requests already made. Called after the call, never before. */
export async function recordLlm(db: Db, n = 1): Promise<void> {
  await db
    .insert(usage)
    .values({ day: today(), kind: LLM_KIND, count: n })
    .onConflictDoUpdate({
      target: [usage.day, usage.kind],
      set: { count: sql`${usage.count} + ${n}` },
    });
}
