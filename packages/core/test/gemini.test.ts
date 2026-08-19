import { test } from "node:test";
import assert from "node:assert/strict";
import { toGeminiSchema, createGeminiLlm } from "../src/adapters/gemini";
import { buildScoreSchema } from "../src/domain/prompt";
import { parseProjectSpec } from "../src/domain/spec";
import { classifyRateLimit, dailyLimitAdvice } from "../src/services/rateLimit";
import type { HttpPort } from "../src/ports/index";

const spec = parseProjectSpec({
  summary: "Sites para escolas",
  buyer: "Diretor",
  problem: "Site velho",
  rubric: {
    axes: [
      {
        key: "fit",
        label: "Fit",
        question: "Precisa de site?",
        anchors: { "1": "não", "2": "pouco", "3": "talvez", "4": "sim", "5": "muito" },
      },
    ],
    recommendations: [{ value: "abordar", label: "Abordar", when: "encaixa" }],
  },
});

/** Walks the whole tree so a nested violation cannot hide. */
function walk(node: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  visit(o);
  for (const v of Object.values(o)) walk(v, visit);
}

test("o schema de pontuação sobrevive à tradução para o Gemini", () => {
  const gem = toGeminiSchema(buildScoreSchema(spec));
  walk(gem, (o) => {
    // Gemini recusa a requisição inteira se qualquer um destes aparecer.
    assert.ok(!("additionalProperties" in o), "additionalProperties tem de sumir");
    if ("type" in o) {
      assert.equal(typeof o.type, "string", "tipo não pode ser união");
      assert.equal(o.type, String(o.type).toUpperCase(), "tipo em maiúsculas");
    }
  });
});

test("união com null vira nullable, não um tipo estranho", () => {
  const gem = toGeminiSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      hook: { type: ["string", "null"] },
      nota: { type: ["integer", "null"], minimum: 1, maximum: 5 },
      nome: { type: "string" },
    },
  }) as { properties: Record<string, unknown> };

  assert.deepEqual(gem.properties["hook"], { type: "STRING", nullable: true });
  // O intervalo tem de sobreviver: sem ele o modelo devolveu `fit: 10` numa
  // rubrica que vai de 1 a 5.
  assert.deepEqual(gem.properties["nota"], {
    type: "INTEGER",
    nullable: true,
    minimum: 1,
    maximum: 5,
  });
  assert.deepEqual(gem.properties["nome"], { type: "STRING" });
});

test("enum e required atravessam intactos", () => {
  const gem = toGeminiSchema({
    type: "object",
    required: ["conf"],
    properties: { conf: { type: "string", enum: ["high", "low"] } },
  }) as { required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.deepEqual(gem.required, ["conf"]);
  assert.deepEqual(gem.properties["conf"]?.enum, ["high", "low"]);
});

test("o 429 do Gemini chega ao chamador com texto suficiente para classificar", async () => {
  const http: HttpPort = {
    async fetch() {
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: "Quota exceeded for quota metric 'Generate requests per day'",
          },
        }),
        { status: 429 }
      );
    },
  };
  const llm = createGeminiLlm({ apiKey: "k", http });
  await assert.rejects(
    () =>
      llm.complete({ task: "score", messages: [{ role: "user", content: "oi" }], retries: 0 }),
    (err: Error) => {
      assert.match(err.message, /429/);
      assert.equal(classifyRateLimit(err.message), "daily");
      return true;
    }
  );
});

test("resposta boa é lida do formato de partes do Gemini", async () => {
  const http: HttpPort = {
    async fetch() {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"ok":' }, { text: "true}" }] } }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
        }),
        { status: 200 }
      );
    },
  };
  const llm = createGeminiLlm({ apiKey: "k", http });
  const out = await llm.completeJson<{ ok: boolean }>({
    task: "score",
    messages: [{ role: "user", content: "oi" }],
  });
  assert.deepEqual(out.value, { ok: true });
  assert.equal(out.usage.promptTokens, 12);
});

test("o conselho do teto diário fala do provedor que bateu no teto", () => {
  // Mandar comprar crédito no OpenRouter quem está rodando no Gemini é pior
  // que não dizer nada.
  const gem = dailyLimitAdvice("gemini");
  assert.ok(!/comprar 10 créditos/i.test(gem), "não pode mandar comprar crédito no OpenRouter");
  assert.match(gem, /Gemini/);

  const or = dailyLimitAdvice("openrouter");
  assert.match(or, /OpenRouter/);
  assert.ok(!/Google AI Studio/.test(or));

  // Sem provedor ainda tem de sair uma frase útil.
  assert.match(dailyLimitAdvice(null), /\.env/);
});
