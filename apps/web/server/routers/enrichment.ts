import { z } from "zod";
import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import { companies, crawls, contacts, placesLookups, projects } from "@cnpj/db";
import {
  crawlSite,
  websiteFromEmail,
  classifyReceitaPhone,
  buildWaMeLink,
  parseProjectSpec,
  HostThrottle,
  type Probe,
} from "@cnpj/core";
import { listCompaniesByCnpj } from "@cnpj/data";
import { startJob } from "@cnpj/jobs";
import {
  mapLimit,
  placesQuery,
  PLACES_SKU,
  FREE_MONTHLY,
  BudgetExceededError,
  type SiteSignals,
} from "@cnpj/core";
import { placesFor } from "../../lib/places";
import { provider } from "../../lib/llm";
import { remainingToday, dailyLimit } from "../../lib/llm-budget";
import { router, publicProcedure, notFound, badRequest, type Context } from "../trpc";

const cnpj = z.string().regex(/^\d{14}$/);

/** The project's probes, or none if the spec has not been compiled yet. */
async function projectProbes(db: Context["db"], projectId: string): Promise<Probe[]> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!row?.spec) return [];
  try {
    return parseProjectSpec(row.spec).probes;
  } catch {
    return [];
  }
}

type UrlSource = "email" | "places" | "manual";

/**
 * Where a company's site would come from, if anywhere.
 *
 * Order matters: a URL confirmed through Places beats one guessed from the
 * e-mail domain, and an explicitly typed one beats both.
 */
function resolveUrl(
  company: { email: string | null },
  place: { websiteUrl: string | null } | undefined,
  manual?: string
): { url: string; source: UrlSource } | null {
  if (manual) return { url: manual, source: "manual" };
  if (place?.websiteUrl) return { url: place.websiteUrl, source: "places" };
  const guess = websiteFromEmail(company.email);
  return guess ? { url: guess, source: "email" } : null;
}

/**
 * Crawls one company and stores what was found.
 *
 * Shared by the single-company button and the batch job so there is exactly one
 * implementation of "what a crawl records" — the previous project ended up with
 * two copies of its CSV writer for want of this.
 */
async function crawlAndStore(
  db: Context["db"],
  cnpjValue: string,
  target: { url: string; source: UrlSource },
  opts: { depth: number; probes: Probe[]; throttle: HostThrottle }
): Promise<SiteSignals> {
  const signals = await crawlSite(target.url, {
    depth: opts.depth,
    probes: opts.probes,
    throttle: opts.throttle,
  });

  const row = {
    websiteUrl: target.url,
    finalUrl: signals.finalUrl,
    httpStatus: signals.httpStatus,
    error: signals.error,
    urlSource: target.source,
    signals,
    textExcerpt: signals.textExcerpt,
    pagesFetched: signals.pagesFetched,
    checkedAt: new Date().toISOString(),
  };

  await db
    .insert(crawls)
    .values({ cnpj: cnpjValue, ...row })
    .onConflictDoUpdate({ target: crawls.cnpj, set: row });

  // A number on the company's own site beats the one filed with the Receita,
  // which is frequently the accountant's line.
  if (signals.sitePhone) {
    const digits = signals.sitePhone.replace(/^\+55/, "");
    const parsed = classifyReceitaPhone(digits.slice(0, 2), digits.slice(2));
    if (parsed) {
      await db
        .insert(contacts)
        .values({
          cnpj: cnpjValue,
          phoneE164: parsed.e164,
          isMobile: parsed.isMobile,
          source: "site",
          waMe: buildWaMeLink(parsed.e164),
        })
        .onConflictDoNothing();
    }
  }

  return signals;
}

export const enrichmentRouter = router({
  /** Everything known about the companies in a project, for the enrichment tab. */
  list: publicProcedure
    .input(
      z.object({ projectId: z.string(), limit: z.number().int().min(1).max(500).default(100) })
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(companies)
        .leftJoin(crawls, eq(crawls.cnpj, companies.cnpj))
        .leftJoin(placesLookups, eq(placesLookups.cnpj, companies.cnpj))
        .where(eq(companies.projectId, input.projectId))
        .limit(input.limit);

      const revealed = await ctx.db.select().from(contacts);
      const byCnpj = new Map<string, typeof revealed>();
      for (const c of revealed) {
        byCnpj.set(c.cnpj, [...(byCnpj.get(c.cnpj) ?? []), c]);
      }

      return rows.map((r) => ({
        company: r.companies,
        crawl: r.crawls,
        places: r.places_lookups,
        contacts: byCnpj.get(r.companies.cnpj) ?? [],
        // What we would crawl if asked, so the button can say whether it has a
        // target before it is clicked.
        guessedSite: websiteFromEmail(r.companies.email),
      }));
    }),

  /**
   * Reveals the phone. Free: the number is already in the downloaded base, and
   * this only normalises it, classifies the line and stores it for this one
   * company. Nothing is stored for companies nobody asks about.
   */
  revealPhone: publicProcedure.input(z.object({ cnpj })).mutation(async ({ ctx, input }) => {
    const [c] = await listCompaniesByCnpj([input.cnpj]);
    if (!c) notFound(`CNPJ ${input.cnpj} não está na base`);
    if (!c.phone) return { phone: null, reason: "a Receita não tem telefone para este CNPJ" };

    await ctx.db
      .insert(contacts)
      .values({
        cnpj: input.cnpj,
        phoneE164: c.phone.e164,
        isMobile: c.phone.isMobile,
        source: "rf",
        waMe: c.phone.waMe,
      })
      .onConflictDoNothing();

    return { phone: c.phone, reason: null };
  }),

  /**
   * Reveals the phone for many companies at once.
   *
   * Free and fast — the numbers are already in the downloaded base, so this is
   * a normalisation pass, not a network call. Still explicit: nothing is stored
   * for companies nobody asked about.
   */
  revealPhoneBatch: publicProcedure
    .input(z.object({ cnpjs: z.array(cnpj).min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const found = await listCompaniesByCnpj(input.cnpjs);
      const rows = found
        .filter((c) => c.phone)
        .map((c) => ({
          cnpj: c.cnpj,
          phoneE164: c.phone!.e164,
          isMobile: c.phone!.isMobile,
          source: "rf" as const,
          waMe: c.phone!.waMe,
        }));
      if (rows.length) await ctx.db.insert(contacts).values(rows).onConflictDoNothing();
      return { revealed: rows.length, withoutPhone: input.cnpjs.length - rows.length };
    }),

  /**
   * Crawls one company's site.
   *
   * The URL comes from the own-domain e-mail, or from a previous Places lookup,
   * or is typed in. `urlSource` is recorded so a dead crawl of a guessed URL
   * stays distinguishable from a dead crawl of a confirmed one.
   */
  crawl: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        cnpj,
        url: z.string().url().max(500).optional(),
        depth: z.number().int().min(0).max(5).default(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [company] = await ctx.db
        .select()
        .from(companies)
        .where(and(eq(companies.projectId, input.projectId), eq(companies.cnpj, input.cnpj)));
      if (!company) notFound(`${input.cnpj} não está neste projeto`);

      const [place] = await ctx.db
        .select()
        .from(placesLookups)
        .where(eq(placesLookups.cnpj, input.cnpj));

      const target = resolveUrl(company, place, input.url);
      if (!target) {
        badRequest("Nenhum site conhecido. Tente 'Buscar no Google Places' ou informe a URL.");
      }

      return crawlAndStore(ctx.db, input.cnpj, target, {
        depth: input.depth,
        probes: await projectProbes(ctx.db, input.projectId),
        throttle: new HostThrottle(1000),
      });
    }),

  /**
   * Crawls every company in the project that has a site to visit.
   *
   * Runs as a job: at one second per host plus the fetch itself, a hundred
   * companies is minutes, and the crawl is the input scoring depends on — an
   * uncrawled company can only ever come back `cannot_determine`.
   */
  crawlBatch: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        /** Explicit selection. Without it, everything not yet crawled. */
        cnpjs: z.array(cnpj).max(2000).optional(),
        limit: z.number().int().min(1).max(500).default(50),
        depth: z.number().int().min(0).max(5).default(0),
        concurrency: z.number().int().min(1).max(20).default(6),
        /** Re-visit companies already crawled. Implied by an explicit selection. */
        recheck: z.boolean().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(companies)
        .leftJoin(crawls, eq(crawls.cnpj, companies.cnpj))
        .leftJoin(placesLookups, eq(placesLookups.cnpj, companies.cnpj))
        .where(eq(companies.projectId, input.projectId));

      // An explicit selection means "do these", including ones already done:
      // picking a row and being silently skipped is worse than a wasted fetch.
      const picked = input.cnpjs ? new Set(input.cnpjs) : null;
      const recheck = input.recheck || picked !== null;

      const targets = rows
        .filter((r) => (picked ? picked.has(r.companies.cnpj) : true))
        .filter((r) => recheck || !r.crawls)
        .map((r) => ({
          cnpj: r.companies.cnpj,
          target: resolveUrl(r.companies, r.places_lookups ?? undefined),
        }))
        .filter(
          (t): t is { cnpj: string; target: { url: string; source: UrlSource } } =>
            t.target !== null
        )
        .slice(0, input.limit);

      const considered = rows
        .filter((r) => (picked ? picked.has(r.companies.cnpj) : true))
        .filter((r) => recheck || !r.crawls).length;
      const skipped = considered - targets.length;
      if (targets.length === 0) {
        return { jobId: null, queued: 0, skipped };
      }

      const probes = await projectProbes(ctx.db, input.projectId);
      // One throttle for the whole run, so two companies sharing a host — a
      // franchise, a school group — still get their requests spaced out.
      const throttle = new HostThrottle(1000);

      const job = startJob(ctx.db, "crawl", input.projectId, async (jobCtx) => {
        jobCtx.log(`visitando ${targets.length} sites (${skipped} sem site conhecido)`);
        let done = 0;
        let alive = 0;
        let dead = 0;

        await mapLimit(targets, input.concurrency, async ({ cnpj: c, target }) => {
          if (jobCtx.cancelled()) return;
          const signals = await crawlAndStore(ctx.db, c, target, {
            depth: input.depth,
            probes,
            throttle,
          });
          if (signals.error || signals.isDead) dead++;
          else alive++;
          jobCtx.progress({ done: ++done, total: targets.length });
        });

        jobCtx.log(`pronto: ${alive} sites lidos, ${dead} mortos ou bloqueados`);
      });

      return { jobId: job.id, queued: targets.length, skipped };
    }),

  /**
   * Places for many companies, stopping cleanly when the free quota runs out.
   *
   * A budget stop is a result, not a failure: the companies already looked up
   * keep their answers and the caller is told where it stopped. The previous
   * project learnt this the hard way — a quota exception mid-run used to lose
   * the whole stage.
   */
  placesBatch: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        cnpjs: z.array(cnpj).min(1).max(500),
        /** Deliberate: the caller has to acknowledge this is the paid step. */
        allowPaid: z.literal(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const places = placesFor(ctx.db, input.cnpjs.length);
      if (!places) {
        badRequest(
          "GOOGLE_MAPS_API_KEY não configurada. Esta busca é opcional e é a única que gasta dinheiro."
        );
      }

      const rows = await ctx.db
        .select()
        .from(companies)
        .where(
          and(eq(companies.projectId, input.projectId), inArray(companies.cnpj, input.cnpjs))
        );

      let looked = 0;
      let withSite = 0;
      let stoppedOnQuota = false;

      for (const c of rows) {
        const query = placesQuery(c);
        if (!query) continue;
        try {
          const found = await places.client.findWebsite(query);
          looked++;
          if (found?.websiteUrl) withSite++;
          const row = {
            placeId: found?.placeId ?? null,
            websiteUrl: found?.websiteUrl ?? null,
            found: Boolean(found),
            checkedAt: new Date().toISOString(),
          };
          await ctx.db
            .insert(placesLookups)
            .values({ cnpj: c.cnpj, ...row })
            .onConflictDoUpdate({ target: placesLookups.cnpj, set: row });
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            stoppedOnQuota = true;
            break;
          }
          throw err;
        }
      }

      return {
        looked,
        withSite,
        stoppedOnQuota,
        remaining: await places.budget.remaining(PLACES_SKU),
      };
    }),

  /** How many companies still have no site to crawl. */
  pending: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({ cnpj: companies.cnpj, email: companies.email })
        .from(companies)
        .leftJoin(crawls, eq(crawls.cnpj, companies.cnpj))
        .where(and(eq(companies.projectId, input.projectId), isNull(crawls.cnpj)));
      const withGuess = rows.filter((r) => websiteFromEmail(r.email)).length;
      return { notCrawled: rows.length, withGuessableSite: withGuess };
    }),

  /**
   * Google Places website discovery.
   *
   * Deliberately its own table and its own button. The Receita has no website
   * column, so this is the only way to find a site for a company whose e-mail
   * is at gmail — but it is a paid quota, and Google's terms permit storing the
   * place_id and nothing else. Nothing but the id, the URL and timestamps has a
   * column here to be stored in.
   */
  /**
   * Finds a company's website through Google Places.
   *
   * The only step in this project that can spend money, so: off unless a key is
   * configured, guarded by the monthly free allowance, checked before the
   * request rather than after, and it asks Google for two fields. Google's terms
   * allow storing `place_id` and nothing else — the field mask is the
   * enforcement, since a field never fetched cannot be stored by accident.
   */
  placesLookup: publicProcedure
    .input(z.object({ projectId: z.string(), cnpj }))
    .mutation(async ({ ctx, input }) => {
      const places = placesFor(ctx.db);
      if (!places) {
        badRequest(
          "GOOGLE_MAPS_API_KEY não configurada. Esta busca é opcional e é a única que gasta dinheiro."
        );
      }

      const [company] = await ctx.db
        .select()
        .from(companies)
        .where(and(eq(companies.projectId, input.projectId), eq(companies.cnpj, input.cnpj)));
      if (!company) notFound(`${input.cnpj} não está neste projeto`);

      const query = placesQuery(company);
      if (!query) badRequest("A empresa não tem nome para procurar.");

      let found: Awaited<ReturnType<typeof places.client.findWebsite>>;
      try {
        found = await places.client.findWebsite(query);
      } catch (err) {
        if (err instanceof BudgetExceededError) badRequest(err.message);
        throw err;
      }

      const row = {
        placeId: found?.placeId ?? null,
        websiteUrl: found?.websiteUrl ?? null,
        found: Boolean(found),
        checkedAt: new Date().toISOString(),
      };
      await ctx.db
        .insert(placesLookups)
        .values({ cnpj: input.cnpj, ...row })
        .onConflictDoUpdate({ target: placesLookups.cnpj, set: row });

      return {
        ...row,
        remaining: await places.budget.remaining(PLACES_SKU),
      };
    }),

  usage: publicProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db.select({ n: sql<number>`count(*)` }).from(placesLookups);
    const places = placesFor(ctx.db);
    return {
      placesLookups: Number(row?.n ?? 0),
      placesConfigured: Boolean(places),
      // Left this month on the free allowance. Zero means the button stops.
      placesRemaining: places ? await places.budget.remaining(PLACES_SKU) : 0,
      placesMonthly: FREE_MONTHLY[PLACES_SKU] ?? 0,
      // Which model provider is in play, and what is left of today's allowance.
      // The continuous run stops on this, so it should not be a surprise.
      llmProvider: provider(),
      llmRemaining: await remainingToday(ctx.db),
      llmDaily: dailyLimit(),
    };
  }),
});
