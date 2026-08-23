import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { impressions } from "@cnpj/db";
import { router, publicProcedure } from "../trpc";

const cnpj = z.string().regex(/^\d{14}$/);

/**
 * What a person saw, in their own words, about one company.
 *
 * This is the only free-form text a human writes that reaches the model. It goes
 * into the *evidence* half of the prompt — next to the page title and the page
 * text — never into the rubric, so it cannot edit the guardrails. What it may
 * and may not do is stated in IMPRESSION_RULES in `packages/core/src/domain/prompt.ts`.
 */
export const impressionsRouter = router({
  /**
   * Upserts, or deletes when cleared.
   *
   * An upsert rather than the bare UPDATE `leads.setNotes` uses: there is no row
   * to update the first time, and an impression has to be writable while you are
   * still deciding — before the company is a lead, which is the whole point.
   *
   * Blank deletes instead of storing "". The absence of a row is what decides
   * whether the run's prompt gains its impression rules at all, so an empty
   * string would put those rules in front of the model with nothing to apply
   * them to.
   */
  set: publicProcedure
    .input(z.object({ projectId: z.string(), cnpj, body: z.string().max(4000) }))
    .mutation(async ({ ctx, input }) => {
      const body = input.body.trim();
      if (!body) {
        await ctx.db
          .delete(impressions)
          .where(
            and(eq(impressions.projectId, input.projectId), eq(impressions.cnpj, input.cnpj))
          );
        return { stored: false };
      }
      const updatedAt = new Date().toISOString();
      await ctx.db
        .insert(impressions)
        .values({ projectId: input.projectId, cnpj: input.cnpj, body, updatedAt })
        .onConflictDoUpdate({
          target: [impressions.projectId, impressions.cnpj],
          set: { body, updatedAt },
        });
      return { stored: true, updatedAt };
    }),
});
