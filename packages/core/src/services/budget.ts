/**
 * The spend guard for Google Places.
 *
 * Google retired the pooled $200/month credit in March 2025. Allowances are now
 * per-SKU and do not pool, so "how much is left" only has an answer once you
 * know which SKU you are billing.
 * https://developers.google.com/maps/billing-and-pricing/pricing
 *
 * The check runs BEFORE the request, not after. Counting spend you have already
 * committed is bookkeeping, not a budget.
 */

export const FREE_MONTHLY: Record<string, number> = {
  "textsearch.essentials": 10_000,
  "textsearch.pro": 5_000,
  // The tier that includes websiteUri — the only field this project wants.
  "textsearch.enterprise": 1_000,
  "details.essentials": 10_000,
  "details.pro": 5_000,
  "details.enterprise": 1_000,
};

/** USD per 1,000 requests in the first paid band, for the "what would this cost" line. */
export const PRICE_PER_1K: Record<string, number> = {
  "textsearch.essentials": 1.7,
  "textsearch.pro": 32,
  "textsearch.enterprise": 35,
  "details.essentials": 5,
  "details.pro": 17,
  "details.enterprise": 20,
};

export class BudgetExceededError extends Error {
  constructor(
    readonly sku: string,
    readonly used: number,
    readonly limit: number
  ) {
    super(
      `Cota gratuita do mês esgotada para "${sku}": ${used}/${limit}. ` +
        `Parei em vez de começar a cobrar. Volta no dia 1º.`
    );
    this.name = "BudgetExceededError";
  }
}

export interface BudgetCounters {
  /** Requests already billed this calendar month for this SKU. */
  usedThisMonth(sku: string): Promise<number>;
  record(sku: string, n: number): Promise<void>;
}

export interface BudgetOptions {
  /** Hard ceiling for a single run, on top of the monthly allowance. */
  maxRequests?: number;
}

/**
 * Refuses to spend past the free allowance.
 *
 * There is deliberately no `allowPaid` escape hatch. The previous project had
 * one and had to keep it unreachable from the browser; not building it is
 * simpler than building it and then defending it.
 */
export class Budget {
  private runCount = 0;
  private cachedUsed: { sku: string; value: number } | null = null;

  constructor(
    private readonly counters: BudgetCounters,
    private readonly opts: BudgetOptions = {}
  ) {}

  async remaining(sku: string): Promise<number> {
    const limit = FREE_MONTHLY[sku] ?? 0;
    const used = await this.counters.usedThisMonth(sku);
    return Math.max(0, limit - used);
  }

  /** Throws unless one more request to `sku` is still free. */
  async check(sku: string): Promise<void> {
    if (this.opts.maxRequests !== undefined && this.runCount >= this.opts.maxRequests) {
      throw new BudgetExceededError(sku, this.runCount, this.opts.maxRequests);
    }
    const limit = FREE_MONTHLY[sku] ?? 0;
    // The month-to-date figure is read once and then tracked in memory: one run
    // is the only writer, and re-querying per request would double the work for
    // a number that only this loop can move.
    if (!this.cachedUsed || this.cachedUsed.sku !== sku) {
      this.cachedUsed = { sku, value: await this.counters.usedThisMonth(sku) };
    }
    if (this.cachedUsed.value >= limit) {
      throw new BudgetExceededError(sku, this.cachedUsed.value, limit);
    }
  }

  async spent(sku: string): Promise<void> {
    this.runCount++;
    if (this.cachedUsed?.sku === sku) this.cachedUsed.value++;
    await this.counters.record(sku, 1);
  }

  get requestsThisRun(): number {
    return this.runCount;
  }
}

/** What N more requests would cost if the free allowance were gone. */
export function estimateCost(sku: string, requests: number): number {
  return ((PRICE_PER_1K[sku] ?? 0) * requests) / 1000;
}
