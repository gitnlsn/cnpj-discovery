import { z } from "zod";
import { eq, and, inArray, desc, asc, sql } from "drizzle-orm";
import { companies, crawls, scores, leads, contacts, placesLookups } from "@cnpj/db";
import { websiteFromEmail, type SiteSignals } from "@cnpj/core";
import { router, publicProcedure } from "../trpc";

/**
 * One query behind the companies view.
 *
 * The pipeline stages used to be four screens showing the same rows in
 * different states. They are one entity with several attributes, so this
 * returns the whole picture per company — registration, crawl, score, lead
 * state, revealed contacts — and the view decides what to show and what to run.
 */
const LEAD_STATUSES = ["flagged", "contacted", "replied", "won", "lost"] as const;

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

      return {
        total: Number(row?.total ?? 0),
        crawled: Number(row?.crawled ?? 0),
        scored: Number(row?.scored ?? 0),
        flagged: Number(row?.flagged ?? 0),
      };
    }),

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
