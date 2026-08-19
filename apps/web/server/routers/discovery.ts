import { z } from "zod";
import { eq, and, desc, sql } from "drizzle-orm";
import { projects, cnaePicks, companies } from "@cnpj/db";
import { suggestCnaes, parseProjectSpec } from "@cnpj/core";
import {
  listCompanies,
  listCompaniesByCnpj,
  countReach,
  searchCnaes,
  cnaeReach,
} from "@cnpj/data";
import { router, publicProcedure, notFound } from "../trpc";
import { requireLlm } from "../../lib/llm";

/**
 * `.strict()` on purpose.
 *
 * Zod strips unknown keys by default, so a filter the UI sends but the schema
 * has not declared is silently dropped and the query runs unfiltered — which is
 * exactly how `ownDomainEmail`, `isMobile` and `porte` appeared to work while
 * doing nothing at all. Failing loudly is the point of validating here.
 */
const filters = z
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

/**
 * How many already-added CNPJs we will exclude in SQL.
 *
 * A cap because each one is a bound parameter. Beyond it the list would keep
 * showing companies already in the project — so the caller is told, rather than
 * the dedup quietly going partial.
 */
const MAX_EXCLUDE = 5000;

export const discoveryRouter = router({
  /**
   * Asks the model for CNAEs, then checks every one against the official
   * dictionary and the real counts before any of it reaches the screen.
   *
   * A code that does not exist is stored as "unknown" rather than dropped: a
   * hallucination that disappears silently looks exactly like a segment the
   * model chose not to suggest.
   */
  suggest: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId));
      if (!row) notFound(`projeto ${input.projectId} não existe`);

      const { suggestions, model } = await suggestCnaes(requireLlm(), {
        description: row.description,
        icpText: row.icpText,
      });

      // The spec's UF filter, if it has been compiled, scopes the counts so the
      // reach numbers match what the list will actually show.
      let ufs: string[] | undefined;
      try {
        const spec = row.spec ? parseProjectSpec(row.spec) : null;
        if (spec?.targeting.ufs.length) ufs = spec.targeting.ufs;
      } catch {
        /* an unparseable stored spec must not block discovery */
      }

      const checked = await cnaeReach(
        suggestions.map((s) => s.cnae),
        ufs ? { uf: ufs } : {}
      );
      const byCode = new Map(checked.map((c) => [c.codigo, c]));

      const rows = suggestions.map((s) => {
        const r = byCode.get(s.cnae);
        const status: "ok" | "unknown" | "empty" =
          !r || r.descricao === null ? "unknown" : r.total === 0 ? "empty" : "ok";
        return {
          projectId: input.projectId,
          cnae: s.cnae,
          descricao: r?.descricao ?? null,
          status,
          reachTotal: r?.total ?? 0,
          reachWithPhone: r?.withPhone ?? 0,
          reachRecent: r?.recent ?? 0,
          // Kept so the model's guess can be compared against the real label —
          // that mismatch is the tell for a plausible-looking wrong code.
          rationale: `${s.rationale}${
            r?.descricao && s.guessedLabel
              ? ` · o modelo achou que era "${s.guessedLabel}"`
              : ""
          }`,
          suggestedBy: "llm" as const,
          chosen: false,
        };
      });

      if (rows.length) {
        await ctx.db
          .insert(cnaePicks)
          .values(rows)
          .onConflictDoUpdate({
            target: [cnaePicks.projectId, cnaePicks.cnae],
            set: {
              descricao: rows[0]!.descricao,
              checkedAt: new Date().toISOString(),
            },
          });
      }
      return { model, picks: rows };
    }),

  /**
   * The project's CNAEs, usable ones first.
   *
   * A single `suggest` run can return more invented codes than real ones — the
   * model answered nine bogus codes and four good ones on the education
   * profile. Interleaved by code number, that buries the rows you can act on.
   *
   * The invented ones are still returned, never dropped: a filter you cannot
   * inspect is indistinguishable from a hole in the data. They just go last.
   */
  picks: publicProcedure.input(z.object({ projectId: z.string() })).query(({ ctx, input }) =>
    ctx.db
      .select()
      .from(cnaePicks)
      .where(eq(cnaePicks.projectId, input.projectId))
      .orderBy(
        sql`CASE ${cnaePicks.status} WHEN 'ok' THEN 0 WHEN 'empty' THEN 1 ELSE 2 END`,
        desc(cnaePicks.chosen),
        desc(cnaePicks.reachTotal),
        cnaePicks.cnae
      )
  ),

  /** Add a CNAE by hand, still checked against the dictionary. */
  addPick: publicProcedure
    .input(z.object({ projectId: z.string(), cnae: z.string().regex(/^\d{2,7}$/) }))
    .mutation(async ({ ctx, input }) => {
      const [r] = await cnaeReach([input.cnae]);
      const usable = Boolean(r && r.descricao !== null && r.total > 0);
      await ctx.db
        .insert(cnaePicks)
        .values({
          projectId: input.projectId,
          cnae: input.cnae,
          descricao: r?.descricao ?? null,
          status: !r || r.descricao === null ? "unknown" : r.total === 0 ? "empty" : "ok",
          reachTotal: r?.total ?? 0,
          reachWithPhone: r?.withPhone ?? 0,
          reachRecent: r?.recent ?? 0,
          suggestedBy: "human",
          // Only a code that exists AND has companies can be used. Marking an
          // invented code as chosen makes it look like part of the targeting.
          chosen: usable,
        })
        .onConflictDoUpdate({
          target: [cnaePicks.projectId, cnaePicks.cnae],
          // Re-resolve, don't just flip `chosen`: a row seeded before the
          // dictionary lookup improved would keep its stale verdict forever.
          set: {
            chosen: usable,
            descricao: r?.descricao ?? null,
            status: !r || r.descricao === null ? "unknown" : r.total === 0 ? "empty" : "ok",
            reachTotal: r?.total ?? 0,
            reachWithPhone: r?.withPhone ?? 0,
            reachRecent: r?.recent ?? 0,
            checkedAt: new Date().toISOString(),
          },
        });
      return { ok: true };
    }),

  setChosen: publicProcedure
    .input(z.object({ projectId: z.string(), cnae: z.string(), chosen: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(cnaePicks)
        .set({ chosen: input.chosen })
        .where(and(eq(cnaePicks.projectId, input.projectId), eq(cnaePicks.cnae, input.cnae)));
      return { ok: true };
    }),

  searchCnaes: publicProcedure
    .input(
      z.object({ q: z.string().max(80), limit: z.number().int().min(1).max(50).default(30) })
    )
    .query(({ input }) => searchCnaes(input.q, input.limit)),

  /** The list itself. Ordered newest-first by default. */
  companies: publicProcedure
    .input(
      z.object({
        filters,
        /** Leave out what this project already has. */
        excludeProjectId: z.string().optional(),
        order: z
          .enum(["founded-desc", "founded-asc", "name", "capital-desc"])
          .default("founded-desc"),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ ctx, input }) => {
      const already = input.excludeProjectId
        ? await ctx.db
            .select({ cnpj: companies.cnpj })
            .from(companies)
            .where(eq(companies.projectId, input.excludeProjectId))
            .limit(MAX_EXCLUDE)
        : [];
      return listCompanies({
        filters: {
          ...input.filters,
          excludeCnpjs: already.length ? already.map((r) => r.cnpj) : undefined,
        },
        order: input.order,
        limit: input.limit,
        offset: input.offset,
      });
    }),

  reach: publicProcedure
    .input(z.object({ filters, excludeProjectId: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      // Must exclude the same rows the list does, or the header counts
      // companies the table will not show.
      const already = input.excludeProjectId
        ? await ctx.db
            .select({ cnpj: companies.cnpj })
            .from(companies)
            .where(eq(companies.projectId, input.excludeProjectId))
            .limit(MAX_EXCLUDE)
        : [];
      return countReach({
        ...input.filters,
        excludeCnpjs: already.length ? already.map((r) => r.cnpj) : undefined,
      });
    }),

  /**
   * Pulls chosen companies into the project. This is the only moment anything
   * from the Receita base is written to the app's own database.
   */
  addCompanies: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        cnpjs: z
          .array(z.string().regex(/^\d{14}$/))
          .min(1)
          .max(2000),
        sourcePeriod: z.string().max(10).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Re-read from the Parquet base rather than trusting whatever the client
      // posted: the browser sends CNPJs, not company records.
      const rows = await listCompaniesByCnpj(input.cnpjs);
      if (rows.length === 0) return { added: 0 };

      await ctx.db
        .insert(companies)
        .values(
          rows.map((c) => ({
            projectId: input.projectId,
            cnpj: c.cnpj,
            razaoSocial: c.razaoSocial,
            nomeFantasia: c.nomeFantasia,
            cnae: c.cnae,
            cnaeDescricao: c.cnaeDescricao,
            uf: c.uf,
            municipio: c.municipio,
            bairro: c.bairro,
            dataInicioAtividade: c.dataInicioAtividade,
            porte: c.porte,
            capitalSocial: c.capitalSocial,
            naturezaJuridica: c.naturezaJuridica,
            mei: c.mei,
            simples: c.simples,
            email: c.email,
            sourcePeriod: input.sourcePeriod ?? null,
          }))
        )
        .onConflictDoNothing();

      return { added: rows.length };
    }),
});
