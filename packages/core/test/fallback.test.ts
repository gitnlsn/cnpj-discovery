import { test } from "node:test";
import assert from "node:assert/strict";
import { createFallbackLlm } from "../src/adapters/fallback";
import { classifyRateLimit } from "../src/services/rateLimit";
import type { CompleteOptions, LlmPort, Task } from "../src/ports/index";

/** A port that fails a fixed number of times, then answers. */
function stub(
  name: string,
  failures: number,
  error = `${name} 503 overloaded`
): LlmPort & {
  calls: { task: Task; retries?: number }[];
} {
  let left = failures;
  const calls: { task: Task; retries?: number }[] = [];

  const complete = async (o: CompleteOptions) => {
    calls.push({ task: o.task, retries: o.retries });
    if (left-- > 0) throw new Error(error);
    return {
      text: `{"from":"${name}"}`,
      usage: { promptTokens: 1, completionTokens: 1 },
      model: name,
    };
  };

  return {
    calls,
    complete,
    completeJson: async <T>(o: CompleteOptions) => {
      const { text, usage, model } = await complete(o);
      return { value: JSON.parse(text) as T, usage, model };
    },
    modelFor: () => name,
    listFreeModels: async () => [{ id: name, name, contextLength: 0, structured: true }],
  };
}

const ask: CompleteOptions = { task: "compile", messages: [{ role: "user", content: "oi" }] };

test("o 503 do primeiro provedor é respondido pelo segundo", async () => {
  const first = stub("gemini", 1);
  const second = stub("openrouter", 0);
  const fell: string[] = [];

  const llm = createFallbackLlm({
    links: [
      { name: "gemini", port: first },
      { name: "openrouter", port: second },
    ],
    onFallback: ({ from, to }) => fell.push(`${from}->${to}`),
  });

  const out = await llm.completeJson<{ from: string }>(ask);
  assert.equal(out.value.from, "openrouter");
  assert.equal(out.model, "openrouter", "o modelo relatado é o que respondeu, não o primeiro");
  assert.deepEqual(fell, ["gemini->openrouter"]);
  assert.equal(second.calls.length, 1, "o reserva só é chamado quando o primeiro falha");
});

test("o primeiro provedor respondendo nunca gasta a cota do reserva", async () => {
  const first = stub("gemini", 0);
  const second = stub("openrouter", 0);
  const llm = createFallbackLlm({
    links: [
      { name: "gemini", port: first },
      { name: "openrouter", port: second },
    ],
  });

  await llm.complete(ask);
  assert.equal(second.calls.length, 0);
});

test("as tentativas do primeiro link são limitadas, as do reserva não", async () => {
  const first = stub("gemini", 1);
  const second = stub("openrouter", 0);
  const llm = createFallbackLlm({
    links: [
      { name: "gemini", port: first, retries: 1 },
      { name: "openrouter", port: second },
    ],
  });

  await llm.complete({ ...ask, retries: 9 });
  assert.equal(first.calls[0]?.retries, 1, "o limite do link vence o pedido do chamador");
  assert.equal(
    second.calls[0]?.retries,
    9,
    "sem limite próprio, o reserva recebe o pedido intacto"
  );
});

test("falhando todos, o erro conta o que cada provedor disse", async () => {
  const llm = createFallbackLlm({
    links: [
      { name: "gemini", port: stub("gemini", 9, "Gemini 503: The model is overloaded") },
      {
        name: "openrouter",
        port: stub("openrouter", 9, "OpenRouter 429: free-models-per-day"),
      },
    ],
  });

  const err = await llm.complete(ask).then(
    () => null,
    (e: Error) => e
  );
  assert.ok(err, "a chamada tem de falhar");
  assert.match(err.message, /gemini: Gemini 503/);
  assert.match(err.message, /openrouter: OpenRouter 429/);
  // O laço contínuo lê este texto para decidir se esperar resolve. Com os dois
  // provedores esgotados, esperar não resolve.
  assert.equal(classifyRateLimit(err.message), "daily");
});

test("um provedor só dispensa o encadeamento", () => {
  const only = stub("gemini", 0);
  assert.equal(createFallbackLlm({ links: [{ name: "gemini", port: only }] }), only);
});

test("um 503 é transitório, não uma falha definitiva", () => {
  assert.equal(
    classifyRateLimit("Gemini 503: The model is overloaded. Please try again later."),
    "transient"
  );
  assert.equal(classifyRateLimit("OpenRouter 502: bad gateway"), "transient");
  assert.equal(classifyRateLimit("Gemini 400: schema inválido"), "none");
});
