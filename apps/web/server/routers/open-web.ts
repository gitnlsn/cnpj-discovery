import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  buildDiscoveryQueries,
  discoveryQuery,
  parseProjectSpec,
  FREE_MONTHLY,
  PLACES_SKU,
  PLACES_MAX_RESULTS,
} from "@cnpj/core";
import { listCompaniesByCnpj } from "@cnpj/data";
import {
  cnaePicks,
  companies,
  crawls,
  projects,
  webLeadScores,
  webLeads,
  webQueries,
} from "@cnpj/db";
import { JobBusyError } from "@cnpj/jobs";
import { router, publicProcedure, badRequest, notFound } from "../trpc";
import { placesFor } from "../../lib/places";
import { toCompanyRow, withAddress } from "../company-row";
import { runOpenWebDiscovery, rescoreWebLeads, recrawlWebLeads } from "../open-web";

/**
 * The open internet, as its own tab.
 *
 * Named `openWeb` rather than `discovery` because that name is taken and means the
 * opposite direction — finding companies inside the Receita base. Two things
 * called discovery, one of them starting from the registry and one from the web,
 * would be a coin-flip every time somebody reads a call site.
 */

const apex = z.string().min(3).max(255);

export const openWebRouter = router({
  /** Whether a sweep can run at all, and what is left of the month's quota. */
  status: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const places = placesFor(ctx.db);
      const [project] = ctx.db
        .select({ spec: projects.spec })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1)
        .all();
      const chosen = ctx.db
        .select({ cnae: cnaePicks.cnae })
        .from(cnaePicks)
        .where(and(eq(cnaePicks.projectId, input.projectId), eq(cnaePicks.chosen, true)))
        .all();

      return {
        enabled: Boolean(places),
        specCompiled: Boolean(parseProjectSpec(project?.spec)),
        chosenCnaes: chosen.length,
        remaining: places ? await places.budget.remaining(PLACES_SKU) : 0,
        monthlyFree: FREE_MONTHLY[PLACES_SKU] ?? 0,
        perQuery: PLACES_MAX_RESULTS,
      };
    }),

  /**
   * The exact queries a sweep would send, without sending any.
   *
   * Its own procedure so the operator approves a spend they can read. The quota is
   * a month-long ceiling, so a wasted sweep is not recoverable until the month
   * turns — which makes "look before you buy" worth a round trip.
   */
  plan: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        maxQueries: z.number().int().min(1).max(50),
        pagesPerQuery: z.number().int().min(1).max(3).default(1),
        nationwide: z.boolean().default(false),
      })
    )
    .query(({ ctx, input }) => {
      const [project] = ctx.db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1)
        .all();
      if (!project) notFound("projeto não encontrado");
      const spec = parseProjectSpec(project!.spec);
      if (!spec) return { queries: [] as string[] };

      const labels = ctx.db
        .select({ descricao: cnaePicks.descricao })
        .from(cnaePicks)
        .where(and(eq(cnaePicks.projectId, input.projectId), eq(cnaePicks.chosen, true)))
        .all()
        .map((p) => p.descricao)
        .filter((d): d is string => Boolean(d));

      const rows = ctx.db
        .select({ municipio: companies.municipio, uf: companies.uf })
        .from(companies)
        .where(eq(companies.projectId, input.projectId))
        .all();
      const tally = new Map<string, number>();
      for (const r of rows) {
        if (!r.municipio || !r.uf) continue;
        const key = `${r.municipio} ${r.uf}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      const places = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

      // Mirrors the job's own arithmetic: pagination shares the call budget, so
      // paginating means fewer distinct queries for the same spend.
      return {
        queries: buildDiscoveryQueries({
          spec,
          cnaeLabels: labels,
          places,
          max: Math.max(1, Math.floor(input.maxQueries / input.pagesPerQuery)),
          nationwide: input.nationwide,
        }).map((q) => discoveryQuery(q.term, q.place)),
      };
    }),

  /** Starts the sweep. One job, four phases — see `runOpenWebDiscovery`. */
  run: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        engine: z.enum(["places", "google", "duckduckgo"]).default("places"),
        maxQueries: z.number().int().min(1).max(50).default(5),
        pagesPerQuery: z.number().int().min(1).max(3).default(1),
        nationwide: z.boolean().default(false),
        depth: z.number().int().min(0).max(3).default(1),
        crawl: z.boolean().default(true),
        score: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Only the Places engine spends the paid quota; the organic ones spend the
      // SERP daily allowance instead, and `openSource` refuses with its own
      // message when they are switched off.
      if (input.engine === "places") {
        const places = placesFor(ctx.db);
        if (!places) {
          badRequest(
            "A busca pelo Places precisa de GOOGLE_MAPS_API_KEY no .env — a cota gratuita cobre 1.000 chamadas por mês, e cada uma devolve até 20 negócios com o site incluído. Ou escolha DuckDuckGo, que é grátis."
          );
        }
        const left = await places!.budget.remaining(PLACES_SKU);
        if (left <= 0) {
          badRequest(
            `A cota gratuita do Places deste mês acabou (${FREE_MONTHLY[PLACES_SKU] ?? 0} chamadas). Ela vira no mês que vem; nada aqui gasta além dela.`
          );
        }
        if (input.maxQueries > left) {
          badRequest(`Só restam ${left} chamadas gratuitas este mês. Peça no máximo isso.`);
        }
      }

      try {
        // The lane is what lets this run next to the Empresas tab; a busy lane
        // means another sweep, not another kind of work.
        return await runOpenWebDiscovery(ctx.db, input);
      } catch (err) {
        if (err instanceof JobBusyError) badRequest(err.message);
        throw err;
      }
    }),

  /** The leads, with their verdict and whatever score they got. */
  list: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        verdict: z.enum(["in_reach", "out_of_reach", "unmatched"]).optional(),
        status: z.enum(["flagged", "contacted", "replied", "won", "lost"]).optional(),
        /** Substring over the site, its title and the matched CNPJ. */
        q: z.string().max(120).optional(),
        includeDiscarded: z.boolean().default(false),
      })
    )
    .query(({ ctx, input }) => {
      const where = [eq(webLeads.projectId, input.projectId)];
      if (input.verdict) where.push(eq(webLeads.verdict, input.verdict));
      if (input.status) where.push(eq(webLeads.status, input.status));
      if (!input.includeDiscarded) where.push(isNull(webLeads.discardedAt));

      const rows = ctx.db
        .select()
        .from(webLeads)
        .leftJoin(
          webLeadScores,
          and(
            eq(webLeadScores.projectId, webLeads.projectId),
            eq(webLeadScores.apex, webLeads.apex)
          )
        )
        .where(and(...where))
        .orderBy(desc(webLeadScores.bestFit), desc(webLeads.foundAt))
        .limit(500)
        .all();

      const q = input.q?.trim().toLowerCase();
      return rows
        .filter((r) => {
          if (!q) return true;
          const title = (r.web_leads.signals as { title?: string } | null)?.title ?? "";
          return `${r.web_leads.apex} ${title} ${r.web_leads.matchedCnpj ?? ""}`
            .toLowerCase()
            .includes(q);
        })
        .map((r) => ({
          ...r.web_leads,
          // The displayed name comes from OUR crawl, never from Google — see the
          // note on `webLeads` about why there is no name column.
          title: (r.web_leads.signals as { title?: string } | null)?.title ?? null,
          score: r.web_lead_scores,
        }));
    }),

  /**
   * The yield, which is the number this whole feature exists to produce.
   *
   * Always visible rather than behind a button: the honest answer to "was the
   * sweep worth it" is a count of leads the project could not already reach, and
   * hiding it would make the feature unfalsifiable.
   */
  yield: publicProcedure.input(z.object({ projectId: z.string() })).query(({ ctx, input }) => {
    const byVerdict = ctx.db
      .select({ verdict: webLeads.verdict, n: sql<number>`count(*)` })
      .from(webLeads)
      .where(eq(webLeads.projectId, input.projectId))
      .groupBy(webLeads.verdict)
      .all();

    const [queries] = ctx.db
      .select({
        n: sql<number>`count(*)`,
        considered: sql<number>`coalesce(sum(considered), 0)`,
      })
      .from(webQueries)
      .where(eq(webQueries.projectId, input.projectId))
      .all();

    const counts = { in_reach: 0, out_of_reach: 0, unmatched: 0 };
    for (const row of byVerdict) counts[row.verdict as keyof typeof counts] = Number(row.n);

    return {
      ...counts,
      queriesSpent: Number(queries?.n ?? 0),
      businessesSeen: Number(queries?.considered ?? 0),
    };
  }),

  /**
   * Turns a lead that HAS a CNPJ into an ordinary company.
   *
   * This is where the identity decision pays off. A matched lead needs no new
   * machinery at all: once its row is in `companies`, every verb the project
   * already has works on it — score, reveal phone, flag, export — with no parallel
   * implementation to keep in step.
   *
   * The crawl already done is carried across rather than repeated, tagged
   * `discovery` so a dead site found this way stays distinguishable from a dead
   * site guessed out of an e-mail domain.
   */
  promote: publicProcedure
    .input(z.object({ projectId: z.string(), apex }))
    .mutation(async ({ ctx, input }) => {
      const [lead] = ctx.db
        .select()
        .from(webLeads)
        .where(and(eq(webLeads.projectId, input.projectId), eq(webLeads.apex, input.apex)))
        .limit(1)
        .all();
      if (!lead) notFound("lead não encontrado");
      if (!lead!.matchedCnpj) {
        badRequest(
          "Este lead não tem CNPJ que a gente tenha conseguido casar, então não há empresa da Receita para promover. Ele fica aqui com a nota que recebeu."
        );
      }

      const [company] = await listCompaniesByCnpj([lead!.matchedCnpj!]);
      if (!company) badRequest("o CNPJ casado não está mais na base — refaça o sync");

      ctx.db
        .insert(companies)
        .values(toCompanyRow(company!, input.projectId))
        .onConflictDoNothing()
        .run();

      // Carry the crawl over only if nothing has crawled this company already:
      // an existing row was produced by the Empresas tab and is not ours to
      // overwrite.
      if (lead!.crawledAt) {
        ctx.db
          .insert(crawls)
          .values({
            cnpj: company!.cnpj,
            websiteUrl: lead!.websiteUrl,
            finalUrl: lead!.finalUrl,
            httpStatus: lead!.httpStatus,
            error: lead!.crawlError,
            urlSource: "discovery",
            signals: lead!.signals,
            textExcerpt: lead!.textExcerpt,
            pagesFetched: lead!.pagesFetched,
          })
          .onConflictDoNothing()
          .run();
      }

      ctx.db
        .update(webLeads)
        .set({ promotedAt: new Date().toISOString() })
        .where(and(eq(webLeads.projectId, input.projectId), eq(webLeads.apex, input.apex)))
        .run();

      return { cnpj: company!.cnpj, company: withAddress(company!) };
    }),

  /**
   * Your decision about a lead. Same five states the Empresas tab uses.
   *
   * Deliberately the same vocabulary: a pipeline where "contatado" means one thing
   * on one tab and something else on the other is a pipeline nobody can read
   * across. Passing null clears the mark, which is not the same as "flagged" —
   * marking is an act and absence is not one.
   */
  setStatus: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        apexes: z.array(apex).min(1).max(500),
        status: z.enum(["flagged", "contacted", "replied", "won", "lost"]).nullable(),
      })
    )
    .mutation(({ ctx, input }) => {
      ctx.db
        .update(webLeads)
        .set({ status: input.status })
        .where(
          and(eq(webLeads.projectId, input.projectId), inArray(webLeads.apex, input.apexes))
        )
        .run();
      return { marked: input.apexes.length };
    }),

  /** What happened after you reached out. Never touched by a rerun. */
  setNotes: publicProcedure
    .input(z.object({ projectId: z.string(), apex, notes: z.string().max(4000) }))
    .mutation(({ ctx, input }) => {
      ctx.db
        .update(webLeads)
        .set({ notes: input.notes.trim() || null })
        .where(and(eq(webLeads.projectId, input.projectId), eq(webLeads.apex, input.apex)))
        .run();
      return { ok: true };
    }),

  /**
   * Re-score one lead, for the ones a quota failure left with an error.
   *
   * Its own procedure rather than a rerun of the sweep, because a sweep would
   * spend engine calls to rediscover businesses already stored. The 16 leads a
   * Gemini 429 left unscored need the model, not the search.
   */
  rescore: publicProcedure
    .input(z.object({ projectId: z.string(), onlyFailed: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await rescoreWebLeads(ctx.db, input.projectId, input.onlyFailed);
      } catch (err) {
        if (err instanceof JobBusyError) badRequest(err.message);
        throw err;
      }
    }),

  /**
   * Re-reads the sites, to pick up contacts a older crawl could not extract.
   *
   * Free of engine cost: it touches only sites already stored. `onlyWithoutContact`
   * keeps it from re-reading what already worked.
   */
  recrawl: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        onlyWithoutContact: z.boolean().default(true),
        depth: z.number().int().min(0).max(5).default(3),
        /** Page budget per site for the deep walk. */
        maxPages: z.number().int().min(1).max(40).default(15),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await recrawlWebLeads(ctx.db, input.projectId, {
          onlyWithoutContact: input.onlyWithoutContact,
          depth: input.depth,
          maxPages: input.maxPages,
        });
      } catch (err) {
        if (err instanceof JobBusyError) badRequest(err.message);
        throw err;
      }
    }),

  /** Sets a lead aside without deleting it — a filter you cannot inspect is a hole. */
  discard: publicProcedure
    .input(z.object({ projectId: z.string(), apex, undo: z.boolean().default(false) }))
    .mutation(({ ctx, input }) => {
      ctx.db
        .update(webLeads)
        .set({ discardedAt: input.undo ? null : new Date().toISOString() })
        .where(and(eq(webLeads.projectId, input.projectId), eq(webLeads.apex, input.apex)))
        .run();
      return { ok: true };
    }),
});
