import type {
  CompleteOptions,
  HttpPort,
  LlmPort,
  ModelInfo,
  Task,
  Usage,
} from "../ports/index";
import { nodeHttp } from "../ports/index";

/**
 * Google's Gemini API, behind the same port as OpenRouter.
 *
 * The reason to have it: OpenRouter's free models allow 50 requests a day,
 * which a continuous run exhausts in under an hour. Gemini's free tier is
 * several hundred a day per model, so the same loop runs far longer before it
 * has to stop for the day.
 */
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * The `-latest` aliases, on purpose. Pinning a version here means the app
 * breaks the day Google closes that version to new keys — which is exactly how
 * this landed: `gemini-2.5-flash` answered with "no longer available to new
 * users". The aliases keep pointing at whatever the current generation is
 * (today 3.5-flash-lite and 3.7-flash).
 */
export const GEMINI_DEFAULT_MODELS: Record<Task, string> = {
  // The lite model does the per-company work, which dominates the request count
  // and has the most generous free quota.
  score: "gemini-flash-lite-latest",
  compile: "gemini-flash-latest",
  suggest: "gemini-flash-latest",
};

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * JSON Schema → Gemini's `responseSchema` dialect.
 *
 * Two differences that matter for the scoring schema: Gemini spells types in
 * upper case, and expresses "or null" as `nullable: true` rather than a type
 * union. It also rejects `additionalProperties` outright, so that key is
 * dropped. Sending our schema unchanged gets the whole request refused, so
 * this translates rather than hopes.
 *
 * `minimum`/`maximum` are kept: Gemini does honour them, and dropping them let
 * a 1-to-5 rubric come back with `fit: 10`.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;

  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    if (key === "additionalProperties") continue;

    if (key === "type") {
      const types = Array.isArray(value) ? value : [value];
      const real = types.filter((t) => t !== "null");
      if (types.includes("null")) out.nullable = true;
      out.type = String(real[0] ?? "string").toUpperCase();
      continue;
    }

    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toGeminiSchema(v)])
      );
      continue;
    }

    out[key] = key === "items" ? toGeminiSchema(value) : value;
  }

  return out;
}

export interface GeminiOptions {
  apiKey: string;
  models?: Partial<Record<Task, string>>;
  http?: HttpPort;
  onUsage?: (model: string, task: Task, usage: Usage) => Promise<void> | void;
}

export function createGeminiLlm(opts: GeminiOptions): LlmPort {
  const http = opts.http ?? nodeHttp;
  const models = { ...GEMINI_DEFAULT_MODELS, ...opts.models };

  // The free tier allows about ten requests a minute; stay under it rather
  // than discovering the ceiling with a 429.
  const MIN_INTERVAL_MS = 6500;
  let lastCallAt = 0;

  function modelFor(task: Task): string {
    return models[task] ?? GEMINI_DEFAULT_MODELS[task];
  }

  async function complete(
    o: CompleteOptions
  ): Promise<{ text: string; usage: Usage; model: string }> {
    const model = modelFor(o.task);
    const retries = o.retries ?? 4;

    const system = o.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = o.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const generationConfig: Record<string, unknown> = {
      temperature: o.temperature ?? 0,
    };
    if (o.maxTokens) generationConfig.maxOutputTokens = o.maxTokens;
    if (o.schema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = toGeminiSchema(o.schema);
    }

    const body: Record<string, unknown> = { contents, generationConfig };
    if (system) body.system_instruction = { parts: [{ text: system }] };

    let lastErr: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 16_000));

      const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastCallAt = Date.now();

      let res: Response;
      try {
        res = await http.fetch(`${BASE}/${model}:generateContent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": opts.apiKey,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastErr = new GeminiError(`erro de rede no Gemini: ${(err as Error).message}`);
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        // Kept verbatim: the caller tells a per-minute limit from a daily one by
        // reading this text.
        lastErr = new GeminiError(
          `Gemini ${res.status}: ${(await res.text()).slice(0, 400)}`,
          res.status
        );
        continue;
      }
      if (!res.ok) {
        throw new GeminiError(
          `Gemini ${res.status}: ${(await res.text()).slice(0, 500)}`,
          res.status
        );
      }

      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        error?: { message?: string };
      };
      if (data.error) throw new GeminiError(`Gemini: ${data.error.message ?? "erro"}`);

      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
      if (!text) {
        lastErr = new GeminiError("Gemini não devolveu conteúdo");
        continue;
      }

      const usage = {
        promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      };
      try {
        await opts.onUsage?.(model, o.task, usage);
      } catch {
        /* accounting must never lose a completed call */
      }

      return { text, model, usage };
    }

    throw lastErr ?? new GeminiError("chamada ao Gemini falhou");
  }

  /** Same salvage as the OpenRouter client: a parse failure is retryable. */
  async function completeJson<T>(
    o: CompleteOptions
  ): Promise<{ value: T; usage: Usage; model: string }> {
    const parseRetries = o.retries ?? 3;
    let last: GeminiError | undefined;

    for (let attempt = 0; attempt <= parseRetries; attempt++) {
      const { text, usage, model } = await complete({ ...o, retries: 2 });
      const cleaned = text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
      try {
        return { value: JSON.parse(cleaned) as T, usage, model };
      } catch {
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start >= 0 && end > start) {
          try {
            return { value: JSON.parse(cleaned.slice(start, end + 1)) as T, usage, model };
          } catch {
            /* fall through to retry */
          }
        }
        last = new GeminiError(
          `Gemini não devolveu JSON válido. Primeiros 200: ${cleaned.slice(0, 200) || "(vazio)"}`
        );
      }
    }
    throw last ?? new GeminiError("Gemini não devolveu JSON válido");
  }

  async function listFreeModels(): Promise<ModelInfo[]> {
    return Object.entries(GEMINI_DEFAULT_MODELS).map(([task, id]) => ({
      id,
      name: `${id} (${task})`,
      contextLength: 0,
      structured: true,
    }));
  }

  return { complete, completeJson, modelFor, listFreeModels };
}
