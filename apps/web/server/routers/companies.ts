import { z } from "zod";
import { eq, and, inArray, desc, asc, sql } from "drizzle-orm";
import { companies, crawls, scores, leads, contacts, placesLookups } from "@cnpj/db";
import { websiteFromEmail, type SiteSignals } from "@cnpj/core";
import { router, publicProcedure } from "../trpc";
import { runPipeline } from "../pipeline";
import { runContinuous } from "../continuous";

/**
 * One query behind the companies view.
 *
 * The pipeline stages used to be four screens showing the same rows in
 * different states. They are one entity with several attributes, so this
 * returns the whole picture per company — registration, crawl, score, lead
 * state, revealed contacts — and the view decides what to show and what to run.
 */
const LEAD_STATUSES = ["flagged", "contacted", "replied", "won", "lost"] as const;

/**
 * The same shape the discovery router validates, restated here because the
 * continuous job takes it too. `.strict()` for the same reason: a filter the UI
 * sends but the schema forgot would be dropped in silence and the loop would
 * churn through companies nobody asked for.
 */
const continuousFilters = z
  .object({
    cnae: z
      .array(z.string().regex(/^\d{2,7}$/))
      .max(40)
      .optional(),
    uf: z.array(z.string().length(2)).max(27).optional(),
    foundedFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    foundedTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    hasPhone: z.boolean().optional(),
    hasEmail: z.boolean().optional(),
    ownDomainEmail: z.boolean().optional(),
    isMobile: z.boolean().optional(),
    mei: z.boolean().optional(),
    matrizOnly: z.boolean().optional(),
    porte: z.array(z.string().max(2)).max(5).optional(),
    naturezaPrefix: z.array(z.string().max(4)).max(8).optional(),
    minCapitalSocial: z.number().min(0).optional(),
    q: z.string().max(120).optional(),
  })
  .strict();

export const companiesRouter = router({
  list: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        q: z.string().max(120).optional(),
        cnae: z.string().max(7).optional(),
        uf: z.string().length(2).optional(),
        /** flagged = in the leads table at all; a status narrows it further. */
        flag: z.union([z.enum(LEAD_STATUSES), z.literal("any"), z.literal("none")]).optional(),
        crawled: z.boolean().optional(),
        scored: z.boolean().optional(),
        /**
         * "Processed" means it has a score.
         *
         * Scoring is the last stage and the pipeline only reaches it after
         * crawling, so a score is proof the company went through. Requiring a
         * *crawl* as well would permanently hide every company whose site could
         * not be found — which is a real answer about a lead, not an unfinished
         * one.
         */
        processed: z.boolean().optional(),
        order: z.enum(["score", "founded", "name"]).default("score"),
        limit: z.number().int().min(1).max(1000).default(200),
      })
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(companies)
        .leftJoin(crawls, eq(crawls.cnpj, companies.cnpj))
        .leftJoin(placesLookups, eq(placesLookups.cnpj, companies.cnpj))
        .leftJoin(
          scores,
          and(eq(scores.cnpj, companies.cnpj), eq(scores.projectId, companies.projectId))
        )
        .leftJoin(
          leads,
          and(eq(leads.cnpj, companies.cnpj), eq(leads.projectId, companies.projectId))
        )
        .where(eq(companies.projectId, input.projectId))
        .orderBy(
          input.order === "score"
            ? desc(scores.bestFit)
            : input.order === "founded"
              ? desc(companies.dataInicioAtividade)
              : asc(companies.nomeFantasia)
        )
        .limit(1000);

      const q = input.q?.toLowerCase();
      const filtered = rows.filter((r) => {
        const c = r.companies;
        if (input.cnae && !c.cnae.startsWith(input.cnae)) return false;
        if (input.uf && c.uf !== input.uf.toUpperCase()) return false;
        if (q) {
          const hay = `${c.nomeFantasia ?? ""} ${c.razaoSocial ?? ""} ${c.cnpj}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (input.flag === "none" && r.leads) return false;
        if (input.flag === "any" && !r.leads) return false;
        if (input.flag && input.flag !== "any" && input.flag !== "none") {
          if (r.leads?.status !== input.flag) return false;
        }
        if (input.crawled === true && !r.crawls) return false;
        if (input.crawled === false && r.crawls) return false;
        if (input.scored === true && !r.scores) return false;
        if (input.scored === false && r.scores) return false;
        if (input.processed === true && !r.scores) return false;
        if (input.processed === false && r.scores) return false;
        return true;
      });

      const page = filtered.slice(0, input.limit);
      const phones = page.length
        ? await ctx.db
            .select()
            .from(contacts)
            .where(
              inArray(
                contacts.cnpj,
                page.map((r) => r.companies.cnpj)
              )
            )
        : [];

      return {
        total: filtered.length,
        rows: page.map((r) => ({
          company: r.companies,
          crawl: r.crawls
            ? { ...r.crawls, signals: r.crawls.signals as SiteSignals | null }
            : null,
          places: r.places_lookups,
          score: r.scores,
          lead: r.leads,
          // Site-found numbers first: the registered one is frequently the
          // accountant's line.
          contacts: phones
            .filter((p) => p.cnpj === r.companies.cnpj)
            .sort((a, b) => (a.source === "site" ? -1 : 0) - (b.source === "site" ? -1 : 0)),
          /** What a crawl would visit, so the button knows if it has a target. */
          guessedSite: websiteFromEmail(r.companies.email),
        })),
      };
    }),

  /** Counters for the filter bar, so each filter shows what it would leave. */
  summary: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({
          total: sql<number>`count(*)`,
          crawled: sql<number>`count(${crawls.cnpj})`,
          scored: sql<number>`count(${scores.cnpj})`,
          flagged: sql<number>`count(${leads.cnpj})`,
        })
        .from(companies)
        .leftJoin(crawls, eq(crawls.cnpj, companies.cnpj))
        .leftJoin(
          scores,
          and(eq(scores.cnpj, companies.cnpj), eq(scores.projectId, companies.projectId))
        )
        .leftJoin(
          leads,
          and(eq(leads.cnpj, companies.cnpj), eq(leads.projectId, companies.projectId))
        )
        .where(eq(companies.projectId, input.projectId));

      const total = Number(row?.total ?? 0);
      const scored = Number(row?.scored ?? 0);
      return {
        total,
        crawled: Number(row?.crawled ?? 0),
        scored,
        flagged: Number(row?.flagged ?? 0),
        // What the default filter is holding back. Never silently.
        pending: Math.max(0, total - scored),
      };
    }),

  /**
   * The CNAEs actually present in this project's companies, with descriptions.
   *
   * Filtering by a code you have to remember is not filtering. These come from
   * the rows themselves rather than from `cnae_picks`, because a project can
   * hold companies from a CNAE that was later unchecked.
   */
  cnaeOptions: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          cnae: companies.cnae,
          descricao: companies.cnaeDescricao,
          n: sql<number>`count(*)`,
        })
        .from(companies)
        .where(eq(companies.projectId, input.projectId))
        .groupBy(companies.cnae, companies.cnaeDescricao)
        .orderBy(desc(sql`count(*)`));
      return rows.map((r) => ({
        cnae: r.cnae,
        descricao: r.descricao,
        count: Number(r.n),
      }));
    }),

  /**
   * Visit the sites, then score — one job, in that order.
   *
   * The order is the whole point: a company whose site was never read can only
   * ever come back `cannot_determine`, so scoring first wastes the call. This
   * is what "added to the pipeline" means for a freshly pulled company.
   */
  process: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        cnpjs: z
          .array(z.string().regex(/^\d{14}$/))
          .min(1)
          .max(500),
        depth: z.number().int().min(0).max(5).default(0),
        concurrency: z.number().int().min(1).max(20).default(6),
      })
    )
    .mutation(({ ctx, input }) => runPipeline(ctx.db, input)),

  /**
   * Keeps pulling one company at a time from the base until told to stop.
   *
   * The filters are the ones from the add dialog, captured when the job starts.
   * It stops on cancel, on running out of matches, on the daily model budget,
   * or on repeated model failures — and the log says which.
   */
  processContinuous: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        filters: continuousFilters,
        order: z
          .enum(["founded-desc", "founded-asc", "name", "capital-desc"])
          .default("founded-desc"),
        depth: z.number().int().min(0).max(5).default(5),
        sourcePeriod: z.string().max(10).optional(),
      })
    )
    .mutation(({ ctx, input }) => runContinuous(ctx.db, input)),

  /** Removes companies from the project. Cascade-free: leads/scores stay keyed. */
  remove: publicProcedure
    .input(
      z.object({ projectId: z.string(), cnpjs: z.array(z.string().regex(/^\d{14}$/)).min(1) })
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(companies)
        .where(
          and(eq(companies.projectId, input.projectId), inArray(companies.cnpj, input.cnpjs))
        );
      await ctx.db
        .delete(leads)
        .where(and(eq(leads.projectId, input.projectId), inArray(leads.cnpj, input.cnpjs)));
      return { removed: input.cnpjs.length };
    }),
});
