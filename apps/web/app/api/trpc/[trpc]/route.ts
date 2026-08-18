import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/routers/index";
import { createContext } from "@/server/trpc";

/**
 * Everything server-side goes through here. There is no subprocess to spawn and
 * no argv to escape — the procedures are the boundary and Zod is the validator.
 */
const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext,
    onError({ error, path }) {
      console.error(`[trpc] ${path ?? "<no-path>"}:`, error.message);
    },
  });

export { handler as GET, handler as POST };
export const dynamic = "force-dynamic";
