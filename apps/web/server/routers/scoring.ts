import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { companies, crawls, scores, projects } from "@cnpj/db";
import {
  scoreCompanies,
  parseProjectSpec,
  type ScoreCandidate,
  type SiteSignals,
} from "@cnpj/core";
import { startJob } from "@cnpj/jobs";
import { router, publicProcedure, notFound, badRequest } from "../trpc";
import { requireLlm } from "../../lib/llm";

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

      const candidates: ScoreCandidate[] = pending.map((r) => {
        const s = r.crawls?.signals as SiteSignals | null;
        return {
          cnpj: r.companies.cnpj,
          razaoSocial: r.companies.razaoSocial,
          nomeFantasia: r.companies.nomeFantasia,
          cnae: r.companies.cnae,
          cnaeDescricao: r.companies.cnaeDescricao,
          uf: r.companies.uf,
          municipio: r.companies.municipio,
          dataInicioAtividade: r.companies.dataInicioAtividade,
          porte: r.companies.porte,
          mei: r.companies.mei,
          // null means never crawled, which the prompt renders differently from
          // a crawl that found nothing.
          site: r.crawls
            ? {
                finalUrl: r.crawls.finalUrl,
                isDead: s?.isDead ?? false,
                isLinkHub: s?.isLinkHub ?? false,
                isFreeBuilder: s?.isFreeBuilder ?? false,
                hasViewport: s?.hasViewport ?? null,
                hasWaLink: s?.hasWaLink ?? null,
                hasContactPath: s?.hasContactPath ?? null,
                platform: s?.platform ?? null,
                footerYear: s?.footerYear ?? null,
                title: s?.title ?? null,
                textExcerpt: r.crawls.textExcerpt,
                probes: s?.probes ?? {},
              }
            : null,
        };
      });

      // Started, not awaited. Free models are throttled to one request every
      // 3.2s, so 200 companies at batch 10 is over a minute of wall clock —
      // well past what an HTTP request should hold open.
      const job = startJob(ctx.db, "score", input.projectId, async (jobCtx) => {
        jobCtx.log(`pontuando ${candidates.length} empresas, lote de ${input.batchSize}`);
        const results = await scoreCompanies(requireLlm(), spec, candidates, {
          batchSize: input.batchSize,
          onProgress: (done, total) => jobCtx.progress({ done, total }),
        });

        for (const r of results) {
          await ctx.db
            .insert(scores)
            .values({
              projectId: input.projectId,
              cnpj: r.cnpj,
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
            })
            .onConflictDoUpdate({
              target: [scores.projectId, scores.cnpj],
              set: {
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
              },
            });
        }

        const failed = results.filter((r) => r.error).length;
        jobCtx.log(`pronto: ${results.length - failed} pontuadas, ${failed} falharam`);
      });

      return { jobId: job.id, queued: candidates.length };
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
