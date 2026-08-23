/**
 * Telling apart the two 429s OpenRouter sends.
 *
 * They look alike and mean opposite things:
 *
 *   "…is temporarily rate-limited upstream. Please retry shortly"
 *       — a per-minute ceiling. Waiting fixes it.
 *
 *   "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock
 *    1000 free model requests per day"  (X-RateLimit-Limit: 50)
 *       — the daily cap. Waiting does nothing until tomorrow.
 *
 * A long-running loop has to react differently to each: back off and carry on
 * for the first, stop and say why for the second. Treating both as "give up"
 * is what made a continuous run end after a few dozen companies.
 */
export type RateLimitKind = "daily" | "transient" | "none";

/**
 * "transient" also covers the 503 an overloaded model answers with. It is not a
 * limit, but the reaction is the same one: wait and carry on.
 */

/**
 * Each provider words the daily cap differently, and both share the 429 status
 * with their per-minute limit — so the status alone decides nothing.
 *
 *   OpenRouter: "Rate limit exceeded: free-models-per-day"
 *   Gemini:     "Quota exceeded for quota metric 'Generate requests per day'"
 *               and metric names like GenerateRequestsPerDayPerProjectPerModel
 *
 * Getting this wrong in either direction is costly: call a daily cap transient
 * and the loop retries for hours against a wall; call a per-minute limit daily
 * and it quits after one bad minute.
 */
export function classifyRateLimit(error: string | null | undefined): RateLimitKind {
  if (!error) return "none";
  if (/per[-\s_]?day|perday|daily/i.test(error)) return "daily";
  if (/\b429\b|rate.?limit|too many requests|quota|resource_exhausted/i.test(error)) {
    return "transient";
  }
  // Not a limit at all: `503 The model is overloaded` is the provider saying it
  // has no capacity for that model this minute. It belongs here because this is
  // what the loop reads to decide whether waiting helps, and waiting is exactly
  // what an overload wants — counting it as a hard failure ended runs after a
  // few unlucky minutes.
  if (/\b50[23]\b|overloaded|unavailable|try again later/i.test(error)) return "transient";
  return "none";
}

/** Growing waits for a transient limit: 30s, 60s, 2min, 4min, then 5min. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 300_000);
}

/**
 * What to tell someone whose daily allowance just ran out.
 *
 * The way out differs by provider, so the message has to say which one hit the
 * wall. Advising "buy OpenRouter credits" to someone running on Gemini is worse
 * than saying nothing.
 */
export function dailyLimitAdvice(provider: "gemini" | "openrouter" | null): string {
  const base = "O teto diário de requisições do modelo gratuito acabou.";
  if (provider === "gemini") {
    return `${base} O nível gratuito do Gemini reabre amanhã; para seguir hoje, ative o faturamento no Google AI Studio ou troque para o OpenRouter com LLM_PROVIDER=openrouter.`;
  }
  if (provider === "openrouter") {
    return `${base} Comprar 10 créditos no OpenRouter sobe de 50 para 1.000 por dia, ou troque para o Gemini com GEMINI_API_KEY no .env.`;
  }
  return `${base} Espere o próximo dia ou configure outro provedor no .env.`;
}
