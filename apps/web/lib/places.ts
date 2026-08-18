import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { usage, type Db } from "@cnpj/db";
import { Budget, createGooglePlaces, PLACES_SKU, type BudgetCounters } from "@cnpj/core";

/**
 * Places, wired to the spend guard.
 *
 * Absent a key this returns null and the callers say so, rather than failing
 * later with a 401. A port that cannot work should not exist.
 */
export function placesCounters(db: Db): BudgetCounters {
  // The allowance is monthly, so month-to-date is the only figure that matters;
  // the `usage` rows are per-day so the number stays inspectable.
  const monthStart = () => new Date().toISOString().slice(0, 7) + "-01";
  const today = () => new Date().toISOString().slice(0, 10);

  return {
    async usedThisMonth(sku) {
      const [row] = await db
        .select({ total: sql<number>`coalesce(sum(${usage.count}), 0)` })
        .from(usage)
        .where(and(eq(usage.kind, sku), gte(usage.day, monthStart())));
      return Number(row?.total ?? 0);
    },
    async record(sku, n) {
      await db
        .insert(usage)
        .values({ day: today(), kind: sku, count: n })
        .onConflictDoUpdate({
          target: [usage.day, usage.kind],
          set: { count: sql`${usage.count} + ${n}` },
        });
    },
  };
}

export function placesFor(db: Db, maxRequests?: number) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  const budget = new Budget(placesCounters(db), { maxRequests });
  const client = createGooglePlaces({
    apiKey,
    // Checked before the request and recorded after it. Counting spend already
    // committed is bookkeeping, not a budget.
    beforeRequest: () => budget.check(PLACES_SKU),
    afterRequest: () => budget.spent(PLACES_SKU),
  });
  return { client, budget };
}
