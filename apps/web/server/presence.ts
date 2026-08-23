import "server-only";
import { eq, sql } from "drizzle-orm";
import { searchHits, searchLookups, scores, companies, crawls, type Db } from "@cnpj/db";
import {
  findPresence,
  BlockStreak,
  linkedInIsEvidence,
  type PresenceCompany,
} from "@cnpj/core";
import type { JobContext } from "@cnpj/jobs";
import { serpFor, remainingToday, noteBlocked } from "../lib/serp";
import { crawlIsReadable } from "./candidate";

/**
 * The web-presence search loop, in one place.
 *
 * Two procedures run it — the manual "search these" button and the MEI
 * reprocess button — and the loop is the part with all the invariants in it:
 * which outcomes are written, which are deliberately not written, and when to
 * stop. Two copies of that would drift, and the drift would be silent because
 * every wrong answer looks like an ordinary negative result.
 */

export interface PresenceTarget extends PresenceCompany {
  cnpj: string;
}

export interface PresenceStats {
  found: number;
  none: number;
  blocked: number;
  unverifiable: number;
  /** Companies that gained evidence, so the caller knows what to re-score. */
  improved: string[];
}

/**
 * Why one company was not searched, when it was not.
 *
 * `stop` reasons end the whole run; `skip` reasons are about this company only.
 * They are separated because the continuous loop has to know whether to move on
 * or to give up, and a caller that conflated them would either quit on one
 * refusal or hammer a blocked engine to the end of the list.
 */
export type PresenceStop = "cancelled" | "daily-cap" | "blocked-streak";

export interface PresenceRun {
  /**
   * Searches one company. Returns the reason the run must end, or null to go on.
   *
   * Whether the company gained evidence is in `stats.improved`, not here: the
   * caller re-scores from that list, and "found something" and "found something
   * that counts" are different facts — see the `counted` filter below.
   */
  searchOne(target: PresenceTarget): Promise<PresenceStop | null>;
  stats: PresenceStats;
  close(): Promise<void>;
}

/**
 * Opens a search run and keeps the engine chain open across companies.
 *
 * Split out of `searchPresence` for the continuous loop, which handles one
 * company at a time and would otherwise pay the Chrome profile warm-up — the
 * one the log calls "uma vez por rodada, não por empresa" — on every single
 * company. Batch callers get the same behaviour through `searchPresence`, which
 * is now this plus a for-loop.
 *
 * Returns null when SERP is switched off, exactly as `serpFor` does.
 */
export function openPresenceRun(db: Db, jobCtx: JobContext): PresenceRun | null {
  const stats: PresenceStats = {
    found: 0,
    none: 0,
    blocked: 0,
    unverifiable: 0,
    improved: [],
  };

  const chain = serpFor(db, {
    cancelled: () => jobCtx.cancelled(),
    onWarmup: ({ sites }) =>
      jobCtx.log(
        `aquecendo o perfil do Chrome em ${sites} sites comuns antes de começar ` +
          `(uma vez por rodada, não por empresa)`
      ),
    onCaptcha: ({ query, waitingMs }) =>
      jobCtx.log(
        `⚠️  O Google pediu CAPTCHA. A janela do Chrome está aberta — resolva lá e eu sigo ` +
          `sozinho (espero até ${Math.round(waitingMs / 60000)} min). Busca: ${query}`
      ),
    onCaptchaResolved: ({ outcome, waitedMs }) =>
      jobCtx.log(
        outcome === "solved"
          ? `✅ resolvido em ${Math.round(waitedMs / 1000)}s. O cookie vale para o resto da rodada.`
          : `CAPTCHA não resolvido (${outcome}) após ${Math.round(waitedMs / 1000)}s.`
      ),
  });
  if (!chain) return null;

  const streak = new BlockStreak(3);

  return {
    stats,
    close: () => chain.close(),
    async searchOne(target: PresenceTarget): Promise<PresenceStop | null> {
      if (jobCtx.cancelled()) return "cancelled";
      if ((await remainingToday(db)) <= 0) {
        jobCtx.log("teto diário de buscas atingido; parei aqui.");
        return "daily-cap";
      }

      const outcome = await findPresence(target, chain.providers, {
        onProviderBlocked: ({ provider, reason }) =>
          jobCtx.log(`${provider} não respondeu (${reason})`),
      });
      const now = new Date().toISOString();

      if (outcome.status === "found") {
        stats.found++;
        // `improved` drives the re-scoring stage, so it has to mean "gained
        // evidence", not "gained a row". A company whose only hit is a LinkedIn
        // profile with no usable headline would otherwise be re-scored, spending
        // an LLM request to reach the same `cannot_determine` it already had.
        const counted = outcome.hits.filter((h) =>
          h.kind === "linkedin" ? linkedInIsEvidence(h, target.razaoSocial) : true
        ).length;
        if (counted) stats.improved.push(target.cnpj);
        const row = {
          provider: outcome.provider,
          query: outcome.query,
          considered: outcome.considered,
          // Still "survived the gates", as the column is documented — NOT
          // "reached the model". A LinkedIn row can be one without the other,
          // and `stats.improved` above is what tracks the latter.
          verified: outcome.hits.length,
          checkedAt: now,
        };
        await db
          .insert(searchLookups)
          .values({ cnpj: target.cnpj, ...row })
          .onConflictDoUpdate({ target: searchLookups.cnpj, set: row });

        for (const hit of outcome.hits) {
          const hitRow = {
            title: hit.title,
            description: hit.description,
            kind: hit.kind,
            headline: hit.headline ?? null,
            matchedOn: hit.matchedOn,
            checkedAt: now,
          };
          await db
            .insert(searchHits)
            .values({ cnpj: target.cnpj, url: hit.url, ...hitRow })
            .onConflictDoUpdate({
              target: [searchHits.cnpj, searchHits.url],
              set: hitRow,
            });
        }
        jobCtx.log(
          `${target.razaoSocial ?? target.cnpj}: ${outcome.hits.length}/${outcome.considered} ` +
            `confirmados (${outcome.hits.map((h) => h.kind).join(", ")})` +
            // Two numbers, because they differ: stored is not the same as
            // counted, and the gap is the whole measurement this feature needs.
            (counted < outcome.hits.length
              ? ` — ${counted} com evidência de fato, ${outcome.hits.length - counted} só registrado`
              : "")
        );
      } else if (outcome.status === "none") {
        // A real answer, recorded so the next run does not repeat the query.
        stats.none++;
        const row = {
          provider: outcome.provider,
          query: outcome.query,
          considered: outcome.considered,
          verified: 0,
          checkedAt: now,
        };
        await db
          .insert(searchLookups)
          .values({ cnpj: target.cnpj, ...row })
          .onConflictDoUpdate({ target: searchLookups.cnpj, set: row });
      } else if (outcome.status === "unverifiable") {
        // No query was spent, so there is nothing to record.
        stats.unverifiable++;
      } else {
        // Blocked or unrecognized: deliberately NO row. We did not look, and a
        // row here would later read as "searched, found nothing" — inventing
        // evidence of absence for a company we were simply refused on.
        stats.blocked++;
      }

      if (streak.record(outcome)) {
        // Start the cooldown before logging, so a second click cannot slip in.
        noteBlocked();
        jobCtx.log(
          `parei: ${streak.consecutive} buscas bloqueadas em sequência. Insistir só marcaria ` +
            `empresa por empresa como "sem presença", o que seria falso. O bloqueio é do IP e ` +
            `passa sozinho — mas só se ninguém ficar batendo na porta, então travei a busca por ` +
            `um tempo.`
        );
        return "blocked-streak";
      }

      return null;
    },
  };
}

/**
 * The whole batch: open a run, search every target, close.
 *
 * The two buttons that search a selection use this. `continuous.ts` drives
 * `openPresenceRun` directly instead, because it interleaves one search with a
 * crawl and a score and cannot hand over the whole list up front.
 */
export async function searchPresence(
  db: Db,
  targets: PresenceTarget[],
  jobCtx: JobContext
): Promise<PresenceStats> {
  const run = openPresenceRun(db, jobCtx);
  if (!run) {
    return { found: 0, none: 0, blocked: 0, unverifiable: 0, improved: [] };
  }
  try {
    let done = 0;
    for (const target of targets) {
      if (await run.searchOne(target)) break;
      const { found, none, blocked } = run.stats;
      jobCtx.progress({
        done: ++done,
        total: targets.length,
        note: `${found} com presença · ${none} sem nada · ${blocked} bloqueadas`,
      });
    }
  } finally {
    await run.close();
  }
  return run.stats;
}

/**
 * MEIs whose scoring never reached a conclusion.
 *
 * `model IS NULL` is the marker the pipeline writes when it recorded a row
 * *without* asking the model — there was nothing to read, so a call would only
 * have bought a `cannot_determine`. Together with an explicit
 * `cannot_determine` from the model itself, that is the cohort this feature
 * exists for: companies the rubric could not judge for lack of evidence, not
 * for lack of merit.
 *
 * Restricted to companies that still have nothing readable. One whose site was
 * crawled successfully but scored low is a real judgement, not an open question.
 */
export async function meiPendingTargets(db: Db, projectId: string, meiOnly = true) {
  const rows = await db
    .select({
      cnpj: companies.cnpj,
      razaoSocial: companies.razaoSocial,
      nomeFantasia: companies.nomeFantasia,
      municipio: companies.municipio,
      uf: companies.uf,
      mei: companies.mei,
      crawl: crawls,
      model: scores.model,
      confidence: scores.confidence,
      alreadySearched: searchLookups.cnpj,
    })
    .from(companies)
    .leftJoin(crawls, eq(crawls.cnpj, companies.cnpj))
    .leftJoin(searchLookups, eq(searchLookups.cnpj, companies.cnpj))
    .leftJoin(
      scores,
      sql`${scores.cnpj} = ${companies.cnpj} AND ${scores.projectId} = ${companies.projectId}`
    )
    .where(eq(companies.projectId, projectId));

  return rows
    .filter((r) => (meiOnly ? r.mei : true))
    .filter((r) => r.model === null || r.confidence === "cannot_determine")
    .filter((r) => !crawlIsReadable(r.crawl))
    .map((r) => ({
      cnpj: r.cnpj,
      razaoSocial: r.razaoSocial,
      nomeFantasia: r.nomeFantasia,
      municipio: r.municipio,
      uf: r.uf,
      alreadySearched: Boolean(r.alreadySearched),
    }));
}
