import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { usage, type Db } from "@cnpj/db";

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

export function dailyLimit(): number {
  const raw = Number(process.env.OPENROUTER_DAILY_REQUESTS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50;
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
