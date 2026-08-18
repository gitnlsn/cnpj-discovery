import { z } from "zod";
import { currentJob, recentJobs, getJob, cancelJob, reconcileStaleJobs } from "@cnpj/jobs";
import { router, publicProcedure } from "../trpc";

/**
 * A `running` row cannot outlive the process that owns it, so any row still
 * marked running when this module first loads is a ghost from a dev-server
 * restart — and it would hold the single-job lock forever.
 */
let reconciled = false;

export const jobsRouter = router({
  status: publicProcedure.query(({ ctx }) => {
    if (!reconciled) {
      reconciled = true;
      const cleared = reconcileStaleJobs(ctx.db);
      if (cleared) console.warn(`[jobs] ${cleared} job(s) órfão(s) liberado(s)`);
    }
    return { current: currentJob(ctx.db), recent: recentJobs(ctx.db, 10) };
  }),

  get: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .query(({ ctx, input }) => getJob(ctx.db, input.id)),

  cancel: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(({ ctx, input }) => ({ cancelled: cancelJob(ctx.db, input.id) })),
});
