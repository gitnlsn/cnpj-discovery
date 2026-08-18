import { z } from "zod";
import { eq, and, desc, inArray } from "drizzle-orm";
import { leads, companies, scores, crawls, contacts } from "@cnpj/db";
import { router, publicProcedure } from "../trpc";

const cnpj = z.string().regex(/^\d{14}$/);
const STATUSES = ["flagged", "contacted", "replied", "won", "lost"] as const;
const status = z.enum(STATUSES);

/**
 * The pipeline's last step: which companies you decided to pursue.
 *
 * Everything here records a decision a person made. Nothing in this router
 * contacts anybody — `contacted` means "I reached out", written down after the
 * fact, the same way the previous project treated it.
 */
export const leadsRouter = router({
  list: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        status: status.optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(leads)
        .leftJoin(
          companies,
          and(eq(companies.cnpj, leads.cnpj), eq(companies.projectId, leads.projectId))
        )
        .leftJoin(
          scores,
          and(eq(scores.cnpj, leads.cnpj), eq(scores.projectId, leads.projectId))
        )
        .leftJoin(crawls, eq(crawls.cnpj, leads.cnpj))
        .where(
          input.status
            ? and(eq(leads.projectId, input.projectId), eq(leads.status, input.status))
            : eq(leads.projectId, input.projectId)
        )
        .orderBy(desc(scores.bestFit), desc(leads.flaggedAt));

      const phones = rows.length
        ? await ctx.db
            .select()
            .from(contacts)
            .where(
              inArray(
                contacts.cnpj,
                rows.map((r) => r.leads.cnpj)
              )
            )
        : [];

      return rows.map((r) => ({
        lead: r.leads,
        company: r.companies,
        score: r.scores,
        finalUrl: r.crawls?.finalUrl ?? null,
        // A number found on the company's own site outranks the registered one.
        contacts: phones
          .filter((p) => p.cnpj === r.leads.cnpj)
          .sort((a, b) => (a.source === "site" ? -1 : 1) - (b.source === "site" ? -1 : 1)),
      }));
    }),

  counts: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({ status: leads.status })
        .from(leads)
        .where(eq(leads.projectId, input.projectId));
      const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<
        (typeof STATUSES)[number],
        number
      >;
      for (const r of rows) out[r.status]++;
      return { ...out, total: rows.length };
    }),

  /** Flags one or many companies. Idempotent: re-flagging keeps the status. */
  flag: publicProcedure
    .input(z.object({ projectId: z.string(), cnpjs: z.array(cnpj).min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .insert(leads)
        .values(input.cnpjs.map((c) => ({ projectId: input.projectId, cnpj: c })))
        .onConflictDoNothing();
      return { flagged: input.cnpjs.length };
    }),

  unflag: publicProcedure
    .input(z.object({ projectId: z.string(), cnpj }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(leads)
        .where(and(eq(leads.projectId, input.projectId), eq(leads.cnpj, input.cnpj)));
      return { ok: true };
    }),

  setStatus: publicProcedure
    .input(z.object({ projectId: z.string(), cnpj, status }))
    .mutation(async ({ ctx, input }) => {
      const nowIso = new Date().toISOString();
      await ctx.db
        .update(leads)
        .set({
          status: input.status,
          updatedAt: nowIso,
          // Stamped once, on the first transition out of "flagged". Re-marking
          // must not rewrite when the contact actually happened.
          ...(input.status !== "flagged" ? { contactedAt: nowIso } : {}),
        })
        .where(and(eq(leads.projectId, input.projectId), eq(leads.cnpj, input.cnpj)));
      return { ok: true };
    }),

  setNotes: publicProcedure
    .input(z.object({ projectId: z.string(), cnpj, notes: z.string().max(4000) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(leads)
        .set({ notes: input.notes, updatedAt: new Date().toISOString() })
        .where(and(eq(leads.projectId, input.projectId), eq(leads.cnpj, input.cnpj)));
      return { ok: true };
    }),
});
