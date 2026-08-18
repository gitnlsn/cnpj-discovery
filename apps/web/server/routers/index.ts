import { router } from "../trpc";
import { projectRouter } from "./project";
import { discoveryRouter } from "./discovery";
import { enrichmentRouter } from "./enrichment";
import { scoringRouter } from "./scoring";
import { jobsRouter } from "./jobs";

export const appRouter = router({
  project: projectRouter,
  discovery: discoveryRouter,
  enrichment: enrichmentRouter,
  scoring: scoringRouter,
  jobs: jobsRouter,
});

export type AppRouter = typeof appRouter;
