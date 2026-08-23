import "server-only";
import {
  createFallbackLlm,
  createOpenRouterLlm,
  createGeminiLlm,
  type LlmLink,
  type LlmPort,
  type Task,
} from "@cnpj/core";

/**
 * The single place `process.env` is read for the model.
 *
 * Gemini wins when both keys are present, for one reason: OpenRouter's free
 * models allow 50 requests a day, which a continuous run spends in under an
 * hour, while Gemini's free tier is several hundred per model per day. The
 * scoring prompt and schema are provider-agnostic, so the choice is only about
 * how long the loop can keep going.
 *
 * With both keys the loser is not discarded — it becomes the fallback, so a
 * provider that is overloaded or out of quota stops being a dead end. See
 * `fallbackProvider()`.
 */
export type Provider = "gemini" | "openrouter";

function geminiKey(): string | undefined {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY;
}

function openRouterKey(): string | undefined {
  return process.env.OPEN_ROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
}

export function provider(): Provider | null {
  if (process.env.LLM_PROVIDER === "openrouter" && openRouterKey()) return "openrouter";
  if (process.env.LLM_PROVIDER === "gemini" && geminiKey()) return "gemini";
  if (geminiKey()) return "gemini";
  if (openRouterKey()) return "openrouter";
  return null;
}

/**
 * The provider that answers when the primary cannot, or null.
 *
 * `LLM_FALLBACK=off` turns it off, for the case where the second key exists but
 * spending its daily allowance on retries is not wanted.
 */
export function fallbackProvider(): Provider | null {
  if (process.env.LLM_FALLBACK === "off") return null;
  const primary = provider();
  if (!primary) return null;
  if (primary === "gemini" && openRouterKey()) return "openrouter";
  if (primary === "openrouter" && geminiKey()) return "gemini";
  return null;
}

function overrides(prefix: string): Partial<Record<Task, string>> {
  const out: Partial<Record<Task, string>> = {};
  const score = process.env[`${prefix}_MODEL_SCORE`];
  const compile = process.env[`${prefix}_MODEL_COMPILE`];
  const suggest = process.env[`${prefix}_MODEL_SUGGEST`];
  if (score) out.score = score;
  if (compile) out.compile = compile;
  if (suggest) out.suggest = suggest;
  return out;
}

function envPrefix(which: Provider): string {
  return which === "gemini" ? "GEMINI" : "OPENROUTER";
}

function build(which: Provider): LlmPort {
  const apiKey = (which === "gemini" ? geminiKey() : openRouterKey())!;
  const models = overrides(envPrefix(which));
  return which === "gemini"
    ? createGeminiLlm({ apiKey, models })
    : createOpenRouterLlm({ apiKey, models });
}

/**
 * How many attempts the primary gets before the chain moves on.
 *
 * Its own default is 4, which nests inside the JSON-parse loop and spends past
 * a minute of backoff against a model that is overloaded and will stay that way
 * for longer than that. Two attempts absorb a blip; anything past that is time
 * spent not asking the provider that would have answered. `LLM_PRIMARY_RETRIES`
 * exists for the opposite preference — keeping the better model at any cost.
 */
function primaryRetries(): number {
  const raw = Number(process.env.LLM_PRIMARY_RETRIES);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 1;
}

/**
 * One client per process, not one per call.
 *
 * Both adapters space their own requests to stay under the provider's
 * per-minute ceiling, and they do it by remembering when they last called. A
 * fresh client has no such memory, so two of them fire back to back and the
 * spacing never happens — which is what would occur the moment you re-score a
 * lead from the sheet while the continuous loop is running. `continuous.ts`
 * already caches per job for exactly this reason; caching here makes every
 * caller share the same one.
 *
 * The cost is that editing a key in `.env` needs a reload to take effect. In dev
 * that is a file save away, and this app runs nowhere else.
 */
let cached: { key: string; port: LlmPort } | null = null;

export function llm(): LlmPort | null {
  const primary = provider();
  if (!primary) return null;
  const second = fallbackProvider();
  const retries = primaryRetries();

  // Keyed on everything that shapes the client, so a changed model override is
  // not served from a stale instance.
  const key = JSON.stringify([
    primary,
    (primary === "gemini" ? geminiKey() : openRouterKey())!,
    overrides(envPrefix(primary)),
    second,
    second ? overrides(envPrefix(second)) : null,
    retries,
  ]);
  if (cached?.key === key) return cached.port;

  const links: LlmLink[] = [{ name: primary, port: build(primary), retries }];
  if (second) links.push({ name: second, port: build(second) });

  const port = createFallbackLlm({
    links,
    // The compile button gives no other sign that the answer came from the
    // second model, and "why is this spec worse than yesterday's" is a question
    // the server log should be able to answer.
    onFallback: ({ from, to, task, error }) =>
      console.warn(`[llm] ${from} falhou em ${task}, tentando ${to}: ${error.message}`),
  });
  cached = { key, port };
  return port;
}

export function requireLlm(): LlmPort {
  const port = llm();
  if (!port) {
    throw new Error(
      "Falta GEMINI_API_KEY ou OPEN_ROUTER_API_KEY no .env. " +
        "O nível gratuito do Gemini rende muito mais requisições por dia."
    );
  }
  return port;
}
