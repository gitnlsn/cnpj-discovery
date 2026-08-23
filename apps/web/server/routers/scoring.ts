import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { companies, crawls, scores, projects, impressions, type Db } from "@cnpj/db";
import { scoreCompanies, parseProjectSpec, type ScoreCandidate } from "@cnpj/core";
import { startJob } from "@cnpj/jobs";
import { router, publicProcedure, notFound, badRequest } from "../trpc";
import { requireLlm } from "../../lib/llm";
import { dailyLimit, recordLlm, remainingToday } from "../../lib/llm-budget";
import { siteFromCrawl, toScoreCandidate, loadPresence } from "../candidate";

type ScoreRow = Awaited<ReturnType<typeof scoreCompanies>>[number];

/**
 * The one place a score row is written from a model result.
 *
 * Every column is restated in `set` because SQLite has no "update all", and a
 * column left out of that list would keep a value from the previous run while
 * the rest of the row moved on — the most confusing possible state for a table
 * whose whole job is to be trustworthy.
 */
async function persistScore(db: Db, projectId: string, r: ScoreRow): Promise<void> {
  const row = {
    fits: r.fits,
    bestFit: r.bestFit,
    tier: r.tier,
    confidence: r.confidence,
    recommendation: r.recommendation,
    wrongType: r.wrongType,
    hook: r.hook,
    advice: r.advice,
    evidence: r.evidence,
    model: r.model,
    promptSha: r.promptSha,
    error: r.error,
    scoredAt: new Date().toISOString(),
  };
  await db
    .insert(scores)
    .values({ projectId, cnpj: r.cnpj, ...row })
    .onConflictDoUpdate({ target: [scores.projectId, scores.cnpj], set: row });
}

export const scoringRouter = router({
  /**
   * Scores the project's companies against its rubric.
   *
   * A failed call is written as a row with `error` set and every fit null.
   * Never a number — a fabricated 5 outranks real 4s forever and nothing in the
   * UI would show that it was invented.
   */
  run: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        /** Explicit selection. Without it, everything not yet scored. */
        cnpjs: z
          .array(z.string().regex(/^\d{14}$/))
          .max(2000)
          .optional(),
        limit: z.number().int().min(1).max(500).default(50),
        batchSize: z.number().int().min(1).max(20).default(10),
        rescore: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [project] = await ctx.db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId));
      if (!project) notFound(`projeto ${input.projectId} não existe`);
      if (!project.spec) {
        badRequest("Compile o perfil de cliente ideal antes de pontuar.");
      }
      const spec = parseProjectSpec(project.spec);

      const rows = await ctx.db
        .select()
        .from(companies)
        .leftJoin(crawls, eq(crawls.cnpj, companies.cnpj))
        .leftJoin(
          scores,
          and(eq(scores.cnpj, companies.cnpj), eq(scores.projectId, input.projectId))
        )
        .leftJoin(
          impressions,
          and(eq(impressions.cnpj, companies.cnpj), eq(impressions.projectId, input.projectId))
        )
        .where(eq(companies.projectId, input.projectId))
        .limit(input.limit * 3);

      // An explicit selection means "score these", including ones already
      // scored — otherwise picking a row and being silently skipped reads as a
      // bug in the button.
      const picked = input.cnpjs ? new Set(input.cnpjs) : null;
      const pending = rows
        .filter((r) => (picked ? picked.has(r.companies.cnpj) : true))
        .filter((r) => picked !== null || input.rescore || !r.scores || r.scores.error)
        .slice(0, picked ? picked.size : input.limit);

      if (pending.length === 0) return { scored: 0, failed: 0 };

      // A null site block means never crawled, which the prompt renders
      // differently from a crawl that found nothing.
      const presence = await loadPresence(
        ctx.db,
        pending.map((r) => r.companies.cnpj)
      );
      const candidates: ScoreCandidate[] = pending.map((r) =>
        toScoreCandidate(
          r.companies,
          siteFromCrawl(r.crawls),
          r.impressions?.body ?? null,
          presence.get(r.companies.cnpj)
        )
      );

      // Started, not awaited. Free models are throttled to one request every
      // 3.2s, so 200 companies at batch 10 is over a minute of wall clock —
      // well past what an HTTP request should hold open.
      const job = startJob(ctx.db, "score", input.projectId, async (jobCtx) => {
        jobCtx.log(`pontuando ${candidates.length} empresas, lote de ${input.batchSize}`);
        const results = await scoreCompanies(requireLlm(), spec, candidates, {
          batchSize: input.batchSize,
          onProgress: (done, total) => jobCtx.progress({ done, total }),
        });

        for (const r of results) await persistScore(ctx.db, input.projectId, r);

        const failed = results.filter((r) => r.error).length;
        jobCtx.log(`pronto: ${results.length - failed} pontuadas, ${failed} falharam`);
      });

      return { jobId: job.id, queued: candidates.length };
    }),

  /**
   * Re-scores exactly one company, right now, and returns the new row.
   *
   * Deliberately NOT a job, unlike every other scoring path. Two reasons:
   *
   * - It is one company at batch 1, so one model call — seconds, well inside
   *   what an HTTP request can hold open. The job machinery exists for work
   *   measured in minutes.
   * - `jobs_one_running_idx` allows one job at a time, so going through
   *   `startJob` would fail with "já existe um trabalho rodando" whenever the
   *   continuous loop is on. That is precisely when you are sitting in the sheet
   *   reading leads and want to try your impression against the rubric.
   *
   * The candidate carries whatever impression is stored, so this is the path
   * that answers "does what I saw change the score?".
   */
  rescoreOne: publicProcedure
    .input(z.object({ projectId: z.string(), cnpj: z.string().regex(/^\d{14}$/) }))
    .mutation(async ({ ctx, input }) => {
      const [project] = await ctx.db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId));
      if (!project) notFound(`projeto ${input.projectId} não existe`);
      if (!project.spec) {
        badRequest("Compile o perfil de cliente ideal antes de pontuar.");
      }
      const spec = parseProjectSpec(project.spec);

      const [row] = await ctx.db
        .select()
        .from(companies)
        .leftJoin(crawls, eq(crawls.cnpj, companies.cnpj))
        .leftJoin(
          impressions,
          and(eq(impressions.cnpj, companies.cnpj), eq(impressions.projectId, input.projectId))
        )
        .where(and(eq(companies.projectId, input.projectId), eq(companies.cnpj, input.cnpj)));
      if (!row) notFound(`${input.cnpj} não está neste projeto`);

      // Checked before the call, like the continuous loop does. A single button
      // press is not worth an exception to the local brake.
      if ((await remainingToday(ctx.db)) <= 0) {
        badRequest(
          `O teto de ${dailyLimit()} requisições ao modelo por dia acabou. ` +
            "Tente de novo amanhã, ou ajuste LLM_DAILY_REQUESTS."
        );
      }

      const candidate = toScoreCandidate(
        row.companies,
        siteFromCrawl(row.crawls),
        row.impressions?.body ?? null,
        (await loadPresence(ctx.db, [input.cnpj])).get(input.cnpj)
      );

      const [result] = await scoreCompanies(requireLlm(), spec, [candidate], {
        batchSize: 1,
      });
      // After the call, never before — a request that threw was still a request
      // as far as the provider is concerned.
      await recordLlm(ctx.db, 1);
      if (!result) badRequest("o modelo não devolveu resultado");

      // A failed call is persisted with `error` set and every fit null, exactly
      // as the batch path does. The sheet already renders that honestly, and an
      // invented number would outrank real ones forever.
      await persistScore(ctx.db, input.projectId, result);

      const [fresh] = await ctx.db
        .select()
        .from(scores)
        .where(and(eq(scores.projectId, input.projectId), eq(scores.cnpj, input.cnpj)));
      return { score: fresh ?? null, error: result.error };
    }),

  /** The ranked list, plus the discarded pile kept visible with its reason. */
  results: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        include: z.enum(["ranked", "discarded", "failed"]).default("ranked"),
        limit: z.number().int().min(1).max(500).default(100),
      })
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(scores)
        .leftJoin(
          companies,
          and(eq(companies.cnpj, scores.cnpj), eq(companies.projectId, scores.projectId))
        )
        .leftJoin(crawls, eq(crawls.cnpj, scores.cnpj))
        .where(eq(scores.projectId, input.projectId))
        .orderBy(desc(scores.bestFit))
        .limit(500);

      const filtered = rows.filter((r) => {
        if (input.include === "failed") return Boolean(r.scores.error);
        if (input.include === "discarded") return r.scores.wrongType && !r.scores.error;
        return !r.scores.wrongType && !r.scores.error;
      });

      return filtered.slice(0, input.limit).map((r) => ({
        score: r.scores,
        company: r.companies,
        finalUrl: r.crawls?.finalUrl ?? null,
      }));
    }),
});
