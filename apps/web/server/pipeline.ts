import { eq, and, inArray } from "drizzle-orm";
import {
  companies,
  crawls,
  scores,
  placesLookups,
  projects,
  contacts,
  impressions,
  type Db,
} from "@cnpj/db";
import { startJob } from "@cnpj/jobs";
import {
  crawlSite,
  websiteFromEmail,
  classifyReceitaPhone,
  buildWaMeLink,
  parseProjectSpec,
  scoreCompanies,
  mapLimit,
  HostThrottle,
  type ScoreCandidate,
} from "@cnpj/core";
import { requireLlm } from "../lib/llm";
import { siteFromCrawl, toScoreCandidate, crawlIsReadable, loadPresence } from "./candidate";

/**
 * Visit sites, then score — as one job.
 *
 * Two stages rather than two jobs because the order is load-bearing and the
 * single-running-job index would otherwise force the operator to wait for the
 * crawl, notice it finished, and start the score by hand. A company whose site
 * was never read can only come back `cannot_determine`, so scoring first burns
 * a model call to learn nothing.
 *
 * Either stage can produce nothing and the job still succeeds: no site to visit
 * is a fact about the company, not a failure of the run.
 */
export async function runPipeline(
  db: Db,
  input: { projectId: string; cnpjs: string[]; depth: number; concurrency: number }
): Promise<{ jobId: number; queued: number }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId));
  const spec = project?.spec ? parseProjectSpec(project.spec) : null;

  const job = startJob(db, "pipeline", input.projectId, async (ctx) => {
    // ---------------------------------------------------------- stage 1: crawl
    const rows = await db
      .select()
      .from(companies)
      .leftJoin(placesLookups, eq(placesLookups.cnpj, companies.cnpj))
      .where(
        and(eq(companies.projectId, input.projectId), inArray(companies.cnpj, input.cnpjs))
      );

    const targets = rows
      .map((r) => ({
        cnpj: r.companies.cnpj,
        url: r.places_lookups?.websiteUrl ?? websiteFromEmail(r.companies.email),
        source: (r.places_lookups?.websiteUrl ? "places" : "email") as "places" | "email",
      }))
      .filter((t): t is { cnpj: string; url: string; source: "places" | "email" } =>
        Boolean(t.url)
      );

    ctx.log(
      `etapa 1/2 · visitando ${targets.length} sites ` +
        `(${rows.length - targets.length} sem site conhecido)`
    );

    const throttle = new HostThrottle(1000);
    let visited = 0;
    await mapLimit(targets, input.concurrency, async (t) => {
      if (ctx.cancelled()) return;
      const signals = await crawlSite(t.url, {
        depth: input.depth,
        probes: spec?.probes ?? [],
        throttle,
      });
      const row = {
        websiteUrl: t.url,
        finalUrl: signals.finalUrl,
        httpStatus: signals.httpStatus,
        error: signals.error,
        urlSource: t.source,
        signals,
        textExcerpt: signals.textExcerpt,
        pagesFetched: signals.pagesFetched,
        checkedAt: new Date().toISOString(),
      };
      await db
        .insert(crawls)
        .values({ cnpj: t.cnpj, ...row })
        .onConflictDoUpdate({ target: crawls.cnpj, set: row });

      if (signals.sitePhone) {
        const digits = signals.sitePhone.replace(/^\+55/, "");
        const parsed = classifyReceitaPhone(digits.slice(0, 2), digits.slice(2));
        if (parsed) {
          await db
            .insert(contacts)
            .values({
              cnpj: t.cnpj,
              phoneE164: parsed.e164,
              isMobile: parsed.isMobile,
              source: "site",
              waMe: buildWaMeLink(parsed.e164),
            })
            .onConflictDoNothing();
        }
      }
      // Half the progress bar is the crawl, half is the scoring.
      ctx.progress({ done: ++visited, total: targets.length + input.cnpjs.length });
    });

    if (ctx.cancelled()) return;

    // ---------------------------------------------------------- stage 2: score
    if (!spec) {
      ctx.log("etapa 2/2 · pulada: o perfil do projeto ainda não foi compilado");
      return;
    }

    const fresh = await db
      .select()
      .from(companies)
      .leftJoin(crawls, eq(crawls.cnpj, companies.cnpj))
      .leftJoin(
        impressions,
        and(
          eq(impressions.cnpj, companies.cnpj),
          eq(impressions.projectId, companies.projectId)
        )
      )
      .where(
        and(eq(companies.projectId, input.projectId), inArray(companies.cnpj, input.cnpjs))
      );

    // Only companies whose page was actually read go to the model.
    //
    // Measured on this project: of 181 companies with no site, scoring produced
    // ONE usable score and zero hooks — the rubric requires positive evidence,
    // so a company with nothing to read can only come back
    // `cannot_determine` by construction. Each batch of ten still costs one
    // request against a rate-limited daily cap.
    //
    // The rest get a row recorded without a call. `model IS NULL` is what
    // separates "we never asked" from "we asked and it could not tell".
    const readable = fresh.filter((r) => crawlIsReadable(r.crawls));
    const unreadable = fresh.filter((r) => !crawlIsReadable(r.crawls));

    for (const r of unreadable) {
      const row = {
        fits: {},
        bestFit: null,
        tier: null,
        confidence: "cannot_determine" as const,
        recommendation: null,
        wrongType: false,
        hook: null,
        advice: "Sem site para ler. Tente o Places para descobrir um, ou descarte.",
        evidence: {
          evidence: [],
          justification:
            "Nenhuma página foi lida, então não há evidência para pontuar. " +
            "Nenhuma chamada ao modelo foi gasta com esta empresa.",
        },
        model: null,
        promptSha: null,
        error: null,
        scoredAt: new Date().toISOString(),
      };
      await db
        .insert(scores)
        .values({ projectId: input.projectId, cnpj: r.companies.cnpj, ...row })
        .onConflictDoUpdate({ target: [scores.projectId, scores.cnpj], set: row });
    }

    if (readable.length === 0) {
      ctx.log(
        `etapa 2/2 · nenhuma empresa com página lida — ${unreadable.length} registradas sem gastar LLM`
      );
      return;
    }

    const presence = await loadPresence(
      db,
      readable.map((r) => r.companies.cnpj)
    );
    const candidates: ScoreCandidate[] = readable.map((r) =>
      toScoreCandidate(
        r.companies,
        siteFromCrawl(r.crawls),
        r.impressions?.body ?? null,
        presence.get(r.companies.cnpj)
      )
    );

    ctx.log(
      `etapa 2/2 · pontuando ${candidates.length} com página lida` +
        (unreadable.length ? ` · ${unreadable.length} sem site, sem gastar LLM` : "")
    );

    const results = await scoreCompanies(requireLlm(), spec, candidates, {
      batchSize: 10,
      onProgress: (done) =>
        ctx.progress({
          done: targets.length + done,
          total: targets.length + candidates.length,
        }),
    });

    for (const r of results) {
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
        .values({ projectId: input.projectId, cnpj: r.cnpj, ...row })
        .onConflictDoUpdate({
          target: [scores.projectId, scores.cnpj],
          set: row,
        });
    }

    const failed = results.filter((r) => r.error).length;
    ctx.log(
      `pronto · ${visited} sites lidos · ${results.length - failed} pontuadas` +
        (failed ? ` · ${failed} falharam` : "")
    );
  });

  return { jobId: job.id, queued: input.cnpjs.length };
}
