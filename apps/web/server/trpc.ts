import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { getDb } from "@cnpj/db";

/**
 * tRPC replaces the argv allowlist the previous version needed.
 *
 * That project drove its dashboard by spawning the CLI, so every button had to
 * hand-validate the strings it put on a command line. Here the procedures are
 * the boundary and Zod is the validator, so there is no shell to escape into.
 */
export interface Context {
  db: ReturnType<typeof getDb>;
}

export function createContext(): Context {
  return { db: getDb() };
}

const t = initTRPC.context<Context>().create({
  // Dates and undefined survive the wire; the DuckDB layer already converts
  // BigInt, which superjson would otherwise happily serialise into something
  // the browser cannot compare.
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // Surface the real reason for a missing dataset instead of "500".
        cause: error.cause instanceof Error ? error.cause.name : undefined,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

export function notFound(message: string): never {
  throw new TRPCError({ code: "NOT_FOUND", message });
}

export function badRequest(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}
