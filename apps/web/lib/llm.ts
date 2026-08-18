import "server-only";
import { createOpenRouterLlm, type LlmPort, type Task } from "@cnpj/core";

/**
 * The single place `process.env` is read for the model.
 *
 * A port that cannot work must not exist: without a key this returns null, and
 * the callers report "sem OPEN_ROUTER_API_KEY — pulado" instead of failing
 * somewhere deeper with a 401.
 */
export function llm(): LlmPort | null {
  const apiKey = process.env.OPEN_ROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const models: Partial<Record<Task, string>> = {};
  if (process.env.OPENROUTER_MODEL_SCORE) models.score = process.env.OPENROUTER_MODEL_SCORE;
  if (process.env.OPENROUTER_MODEL_COMPILE) models.compile = process.env.OPENROUTER_MODEL_COMPILE;
  if (process.env.OPENROUTER_MODEL_SUGGEST) models.suggest = process.env.OPENROUTER_MODEL_SUGGEST;

  return createOpenRouterLlm({ apiKey, models });
}

export function requireLlm(): LlmPort {
  const port = llm();
  if (!port) {
    throw new Error(
      "Falta OPEN_ROUTER_API_KEY no .env. Os modelos padrão do OpenRouter são gratuitos."
    );
  }
  return port;
}
