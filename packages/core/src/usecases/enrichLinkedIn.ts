import {
  isLinkedInEntityUrl,
  isLinkedInProfileUrl,
  linkedInAboutUrl,
  entityTitleMatchesCompany,
  titleLeadsWithName,
} from "../domain/linkedin";
import type { LinkedInPageResult } from "../domain/linkedinPage";

/**
 * Deciding which LinkedIn pages to fetch, and stopping at the right moment.
 *
 * The fetching itself is in `@cnpj/serp`, which needs Chrome, a signed-in
 * profile and a person on standby. Everything that decides *whether* to fetch is
 * here, with the I/O behind two small ports — which is what lets the stopping
 * rules be tested, and they are the rules worth testing. A crawler that fetches
 * the right page is ordinary; one that knows when to stop is the whole feature.
 *
 * ## The order of the gates, and why
 *
 * 1. The URL must already be in `search_hits`, verified against this company by
 *    `verifyHits`. Nothing here guesses a slug: a guessed slug that happens to
 *    resolve attaches another company's employee count to this CNPJ, and it does
 *    it silently, which is the worst kind of wrong.
 * 2. The identity gate is re-applied, against the stored title. Belt and braces
 *    on purpose — rows predate the gates that would reject them today, and the
 *    cost of re-checking is a string comparison against the cost of a permanent
 *    wrong fact.
 * 3. The budget. A ceiling on fetches per run, because the pacing means a large
 *    run is measured in hours and a person has to be around for it.
 * 4. The stop conditions, checked before every fetch: cancelled, ceiling
 *    reached, or the fetcher has seen a checkpoint.
 */

/** A row from `search_hits` that might be worth fetching. */
export interface LinkedInCandidate {
  cnpj: string;
  url: string;
  /** `classifyHit`'s answer, as stored. */
  kind: string | null;
  title: string | null;
  razaoSocial: string | null;
  nomeFantasia: string | null;
}

/** A page we decided to fetch, and how to read it. */
export interface LinkedInPlan {
  cnpj: string;
  /** The canonical URL — normalised for entities, as-stored for profiles. */
  url: string;
  mode: "entity" | "profile";
}

/**
 * Turns a stored hit into a plan, or refuses it.
 *
 * Returns null rather than throwing on anything unusable, because "this row is
 * not worth fetching" is the common case and not an error: most rows in
 * `search_hits` are ordinary websites.
 */
export function planFetch(row: LinkedInCandidate): LinkedInPlan | null {
  if (row.kind === "linkedin_company" && isLinkedInEntityUrl(row.url)) {
    // Re-checked against the stored title — see gate 2 in the docblock.
    if (!entityTitleMatchesCompany(row.title, row)) return null;
    const url = linkedInAboutUrl(row.url);
    return url ? { cnpj: row.cnpj, url, mode: "entity" } : null;
  }

  if (row.kind === "linkedin" && isLinkedInProfileUrl(row.url)) {
    if (!titleLeadsWithName(row.title, row.razaoSocial ?? row.nomeFantasia)) return null;
    return { cnpj: row.cnpj, url: row.url, mode: "profile" };
  }

  return null;
}

/**
 * Orders the work so the cheap, footprint-free half goes first.
 *
 * Entity pages before profiles, and it is not an optimisation. Viewing a
 * person's profile while signed in shows up in that person's "quem viu seu
 * perfil"; an entity page leaves no such trace. So when a run is cut short — by
 * the ceiling, by a checkpoint, by somebody closing the laptop — what got
 * fetched should be the half that did not put the account in front of strangers.
 */
export function orderPlans(plans: LinkedInPlan[]): LinkedInPlan[] {
  return [...plans].sort((a, b) => {
    if (a.mode !== b.mode) return a.mode === "entity" ? -1 : 1;
    return a.cnpj.localeCompare(b.cnpj);
  });
}

/** What the loop needs from the browser. One method, so a test can stub it. */
export interface LinkedInFetcher {
  fetch(url: string, mode: "entity" | "profile"): Promise<LinkedInPageResult>;
  /** Non-null once LinkedIn has shown a challenge. The loop must then stop. */
  readonly stopped: string | null;
}

/** What the loop needs from the database. */
export interface LinkedInStore {
  /** Records an outcome — a page, an absence, or a refusal. Never nothing. */
  save(cnpj: string, result: LinkedInPageResult): Promise<void>;
}

export type LinkedInStop = "cancelled" | "budget" | "checkpoint";

export interface LinkedInEnrichStats {
  fetched: number;
  gone: number;
  blocked: number;
  /** CNPJs that gained facts, so the caller knows what to re-score. */
  improved: string[];
  stoppedBecause: LinkedInStop | null;
}

export interface EnrichOptions {
  /** Hard ceiling on fetches this run. */
  budget: number;
  cancelled?: () => boolean;
  onProgress?: (info: { done: number; total: number; url: string }) => void;
  onStop?: (info: { because: LinkedInStop; reason: string }) => void;
}

/**
 * Fetches the planned pages, in order, until something says stop.
 *
 * Every outcome is written, including the refusals — see `LinkedInPageResult` and
 * the `linkedin_pages` docblock for why a refusal must leave a row saying so
 * rather than no row at all.
 *
 * The one asymmetry worth noting: a `blocked` result ends the run, while a `gone`
 * result does not. A page that is missing tells us nothing about the next page; a
 * refusal tells us about every page after it.
 */
export async function enrichLinkedIn(
  plans: LinkedInPlan[],
  fetcher: LinkedInFetcher,
  store: LinkedInStore,
  opts: EnrichOptions
): Promise<LinkedInEnrichStats> {
  const stats: LinkedInEnrichStats = {
    fetched: 0,
    gone: 0,
    blocked: 0,
    improved: [],
    stoppedBecause: null,
  };

  const work = orderPlans(plans).slice(0, Math.max(0, opts.budget));

  for (const [i, plan] of work.entries()) {
    if (opts.cancelled?.()) {
      stats.stoppedBecause = "cancelled";
      opts.onStop?.({ because: "cancelled", reason: "cancelado" });
      break;
    }
    if (fetcher.stopped) {
      stats.stoppedBecause = "checkpoint";
      opts.onStop?.({ because: "checkpoint", reason: fetcher.stopped });
      break;
    }

    opts.onProgress?.({ done: i, total: work.length, url: plan.url });
    const result = await fetcher.fetch(plan.url, plan.mode);
    await store.save(plan.cnpj, result);

    if (result.status === "ok") {
      stats.fetched++;
      // "Gained facts" is not the same as "returned 200". A page that parsed to
      // nothing but its own name adds nothing to the score, and re-scoring on it
      // would spend an LLM request to reach the same answer — the same
      // distinction `presence.ts` draws with its `counted` filter.
      if (hasSubstance(result)) stats.improved.push(plan.cnpj);
    } else if (result.status === "gone") {
      stats.gone++;
    } else {
      stats.blocked++;
      stats.stoppedBecause = "checkpoint";
      opts.onStop?.({ because: "checkpoint", reason: result.reason });
      break;
    }
  }

  if (!stats.stoppedBecause && plans.length > work.length) {
    stats.stoppedBecause = "budget";
    opts.onStop?.({
      because: "budget",
      reason: `teto de ${opts.budget} páginas por rodada; ${plans.length - work.length} ficaram para depois`,
    });
  }

  return stats;
}

/**
 * Did this page tell us anything we did not already have?
 *
 * The name alone does not count: it came from our own search, so a page whose
 * only field is the name is our own query reflected back — the same trap
 * `looksLikeRegistryMirror` exists for on the search path.
 */
export function hasSubstance(result: LinkedInPageResult): boolean {
  if (result.status !== "ok") return false;
  if (result.mode === "entity") {
    const f = result.facts;
    return Boolean(
      f.description ||
      f.industry ||
      f.employeeRange ||
      f.employeesOnLinkedIn ||
      f.website ||
      f.headquarters ||
      f.founded
    );
  }
  return Boolean(result.facts.headline || result.facts.about);
}
