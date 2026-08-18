import { z } from "zod";
import { eq, and, isNull, sql } from "drizzle-orm";
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
import { mapLimit, type SiteSignals } from "@cnpj/core";
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
    .input(z.object({ projectId: z.string(), limit: z.number().int().min(1).max(500).default(100) }))
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
  revealPhone: publicProcedure
    .input(z.object({ cnpj }))
    .mutation(async ({ ctx, input }) => {
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
        limit: z.number().int().min(1).max(500).default(50),
        depth: z.number().int().min(0).max(5).default(0),
        concurrency: z.number().int().min(1).max(20).default(6),
        /** Re-visit companies already crawled. Off by default. */
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

      const targets = rows
        .filter((r) => input.recheck || !r.crawls)
        .map((r) => ({
          cnpj: r.companies.cnpj,
          target: resolveUrl(r.companies, r.places_lookups ?? undefined),
        }))
        .filter((t): t is { cnpj: string; target: { url: string; source: UrlSource } } =>
          t.target !== null
        )
        .slice(0, input.limit);

      const skipped = rows.filter((r) => input.recheck || !r.crawls).length - targets.length;
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
  placesLookup: publicProcedure
    .input(z.object({ cnpj, allowPaid: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const key = process.env.GOOGLE_MAPS_API_KEY;
      if (!key) {
        badRequest("GOOGLE_MAPS_API_KEY não configurada. Esta busca é opcional e paga.");
      }
      void input;
      void ctx;
      badRequest(
        "Busca no Places ainda não implementada. Ela é a única etapa que gasta dinheiro, " +
          "então fica desligada até você configurar a chave e o teto de gasto."
      );
    }),

  usage: publicProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(placesLookups);
    return { placesLookups: Number(row?.n ?? 0), placesConfigured: Boolean(process.env.GOOGLE_MAPS_API_KEY) };
  }),
});
