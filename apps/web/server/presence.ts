import "server-only";
import { eq, sql } from "drizzle-orm";
import { searchHits, searchLookups, scores, companies, crawls, type Db } from "@cnpj/db";
import { findPresence, BlockStreak, type PresenceCompany } from "@cnpj/core";
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

export async function searchPresence(
  db: Db,
  targets: PresenceTarget[],
  jobCtx: JobContext
): Promise<PresenceStats> {
  const stats: PresenceStats = {
    found: 0,
    none: 0,
    blocked: 0,
    unverifiable: 0,
    improved: [],
  };

  const chain = serpFor(db, {
    cancelled: () => jobCtx.cancelled(),
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
  if (!chain) return stats;

  const streak = new BlockStreak(3);
  let done = 0;

  try {
    for (const target of targets) {
      if (jobCtx.cancelled()) break;
      if ((await remainingToday(db)) <= 0) {
        jobCtx.log("teto diário de buscas atingido; parei aqui.");
        break;
      }

      const outcome = await findPresence(target, chain.providers, {
        onProviderBlocked: ({ provider, reason }) =>
          jobCtx.log(`${provider} não respondeu (${reason})`),
      });
      const now = new Date().toISOString();

      if (outcome.status === "found") {
        stats.found++;
        stats.improved.push(target.cnpj);
        const row = {
          provider: outcome.provider,
          query: outcome.query,
          considered: outcome.considered,
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
            `confirmados (${outcome.hits.map((h) => h.kind).join(", ")})`
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
        break;
      }

      jobCtx.progress({
        done: ++done,
        total: targets.length,
        note: `${stats.found} com presença · ${stats.none} sem nada · ${stats.blocked} bloqueadas`,
      });
    }
  } finally {
    await chain.close();
  }

  return stats;
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
