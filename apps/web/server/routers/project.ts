import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { projects, scores, companies, cnaePicks } from "@cnpj/db";
import { compileSpec, parseProjectSpec, type ProjectSpec } from "@cnpj/core";
import { cnaeReach } from "@cnpj/data";
import { router, publicProcedure, notFound } from "../trpc";
import { requireLlm } from "../../lib/llm";

const slug = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "use letras minúsculas, números e hífen");

/** Reading a stored spec goes back through the validator, not a cast. */
function readSpec(raw: unknown): ProjectSpec | null {
  if (!raw) return null;
  try {
    return parseProjectSpec(raw);
  } catch {
    return null;
  }
}

export const projectRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.select().from(projects).orderBy(desc(projects.updatedAt));
    return rows.map((p) => ({ ...p, spec: readSpec(p.spec) }));
  }),

  get: publicProcedure.input(z.object({ id: slug })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db.select().from(projects).where(eq(projects.id, input.id));
    if (!row) notFound(`projeto ${input.id} não existe`);
    const [counts] = await ctx.db
      .select({ n: companies.cnpj })
      .from(companies)
      .where(eq(companies.projectId, input.id))
      .limit(1);
    return { ...row, spec: readSpec(row.spec), hasCompanies: Boolean(counts) };
  }),

  create: publicProcedure
    .input(
      z.object({
        id: slug,
        name: z.string().min(2).max(120),
        description: z.string().max(4000).default(""),
        icpText: z.string().max(4000).default(""),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.insert(projects).values(input);
      return { id: input.id };
    }),

  update: publicProcedure
    .input(
      z.object({
        id: slug,
        name: z.string().min(2).max(120).optional(),
        description: z.string().max(4000).optional(),
        icpText: z.string().max(4000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...rest } = input;
      await ctx.db
        .update(projects)
        .set({ ...rest, updatedAt: new Date().toISOString() })
        .where(eq(projects.id, id));
      return { ok: true };
    }),

  remove: publicProcedure.input(z.object({ id: slug })).mutation(async ({ ctx, input }) => {
    // Cascades to cnae_picks, companies and scores via the foreign keys.
    await ctx.db.delete(projects).where(eq(projects.id, input.id));
    return { ok: true };
  }),

  /**
   * Compiles the ICP into a spec. Two model calls, and the result is validated
   * before it is stored — the model authored it, so it is input, not truth.
   */
  compile: publicProcedure.input(z.object({ id: slug })).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db.select().from(projects).where(eq(projects.id, input.id));
    if (!row) notFound(`projeto ${input.id} não existe`);
    if (!row.description.trim()) {
      throw new Error("Descreva o produto antes de compilar o perfil.");
    }

    const { spec, model } = await compileSpec(requireLlm(), {
      description: row.description,
      icpText: row.icpText,
    });

    await ctx.db
      .update(projects)
      .set({
        spec,
        specModel: model,
        specCompiledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(projects.id, input.id));

    // Seed the discovery tab with whatever CNAEs the compiler chose, each
    // resolved against the official dictionary.
    //
    // This is not bookkeeping. The compiler writes a label next to the code it
    // picked, and it is routinely wrong: asked for "ensino médio" it answered
    // 8599 and captioned it "(ensino médio)", when 8599 is
    // "Cursos preparatórios / Treinamento profissional" and ensino médio is
    // 8520. Showing the code beside its REAL description is what makes that
    // visible instead of it quietly deciding the whole shortlist.
    if (spec.targeting.cnaePrefixes.length) {
      const checked = await cnaeReach(spec.targeting.cnaePrefixes, {
        uf: spec.targeting.ufs.length ? spec.targeting.ufs : undefined,
      });
      await ctx.db
        .insert(cnaePicks)
        .values(
          checked.map((c) => ({
            projectId: input.id,
            cnae: c.codigo,
            descricao: c.descricao,
            status: (c.descricao === null ? "unknown" : c.total === 0 ? "empty" : "ok") as
              "ok" | "unknown" | "empty",
            reachTotal: c.total,
            reachWithPhone: c.withPhone,
            reachRecent: c.recent,
            rationale: "escolhido ao compilar o perfil — confira a descrição oficial",
            suggestedBy: "llm" as const,
            // Never pre-chosen: an unverified code must not silently define
            // the shortlist.
            chosen: false,
          }))
        )
        .onConflictDoNothing();
    }

    return { spec, model };
  }),

  stats: publicProcedure.input(z.object({ id: slug })).query(async ({ ctx, input }) => {
    const comps = await ctx.db
      .select({ cnpj: companies.cnpj })
      .from(companies)
      .where(eq(companies.projectId, input.id));
    const scored = await ctx.db
      .select({
        cnpj: scores.cnpj,
        tier: scores.tier,
        wrongType: scores.wrongType,
        error: scores.error,
      })
      .from(scores)
      .where(eq(scores.projectId, input.id));

    return {
      companies: comps.length,
      scored: scored.filter((s) => !s.error).length,
      failed: scored.filter((s) => s.error).length,
      wrongType: scored.filter((s) => s.wrongType).length,
      hot: scored.filter((s) => s.tier === "hot").length,
      warm: scored.filter((s) => s.tier === "warm").length,
      cold: scored.filter((s) => s.tier === "cold").length,
    };
  }),
});
