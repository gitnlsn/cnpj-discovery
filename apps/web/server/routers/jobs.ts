import { z } from "zod";
import {
  currentJob,
  runningJobs,
  recentJobs,
  getJob,
  cancelJob,
  reconcileStaleJobs,
} from "@cnpj/jobs";
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
    // `current` keeps meaning "the job on the Receita side", which is what every
    // component written before lanes assumed. `running` carries both lanes for
    // the callers that need to show two bars at once.
    return {
      current: currentJob(ctx.db),
      openWeb: currentJob(ctx.db, "openweb"),
      running: runningJobs(ctx.db),
      recent: recentJobs(ctx.db, 10),
    };
  }),

  get: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .query(({ ctx, input }) => getJob(ctx.db, input.id)),

  cancel: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(({ ctx, input }) => ({ cancelled: cancelJob(ctx.db, input.id) })),
});
