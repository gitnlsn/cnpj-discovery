import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/index";

/**
 * Shapes inferred from the routers rather than restated.
 *
 * Hand-written mirrors of a query's return type drift the first time a column
 * is added, and the drift is silent because the component still compiles.
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export type CompanyRow = RouterOutputs["companies"]["list"]["rows"][number];
export type CnaePick = RouterOutputs["discovery"]["picks"][number];
export type BaseCompany = RouterOutputs["discovery"]["companies"][number];
