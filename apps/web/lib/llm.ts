import "server-only";
import { createOpenRouterLlm, createGeminiLlm, type LlmPort, type Task } from "@cnpj/core";

/**
 * The single place `process.env` is read for the model.
 *
 * Gemini wins when both keys are present, for one reason: OpenRouter's free
 * models allow 50 requests a day, which a continuous run spends in under an
 * hour, while Gemini's free tier is several hundred per model per day. The
 * scoring prompt and schema are provider-agnostic, so the choice is only about
 * how long the loop can keep going.
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

export function llm(): LlmPort | null {
  const which = provider();
  if (which === "gemini") {
    return createGeminiLlm({ apiKey: geminiKey()!, models: overrides("GEMINI") });
  }
  if (which === "openrouter") {
    return createOpenRouterLlm({ apiKey: openRouterKey()!, models: overrides("OPENROUTER") });
  }
  return null;
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
