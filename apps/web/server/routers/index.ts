import { router } from "../trpc";
import { projectRouter } from "./project";
import { discoveryRouter } from "./discovery";
import { enrichmentRouter } from "./enrichment";
import { scoringRouter } from "./scoring";
import { jobsRouter } from "./jobs";
import { leadsRouter } from "./leads";
import { companiesRouter } from "./companies";
import { impressionsRouter } from "./impressions";
import { openWebRouter } from "./open-web";

export const appRouter = router({
  project: projectRouter,
  discovery: discoveryRouter,
  enrichment: enrichmentRouter,
  scoring: scoringRouter,
  jobs: jobsRouter,
  leads: leadsRouter,
  companies: companiesRouter,
  impressions: impressionsRouter,
  // Named openWeb, not discovery: that name already means the opposite
  // direction — finding companies inside the Receita base.
  openWeb: openWebRouter,
});

export type AppRouter = typeof appRouter;
