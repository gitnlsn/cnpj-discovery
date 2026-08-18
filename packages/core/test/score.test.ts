import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreCompanies,
  renderCandidate,
  type ScoreCandidate,
} from "../src/usecases/scoreCompanies";
import { parseProjectSpec } from "../src/domain/spec";
import type { LlmPort, CompleteOptions } from "../src/ports/index";

const spec = parseProjectSpec({
  summary: "Sites para escolas",
  buyer: "Diretor",
  problem: "Site velho",
  probes: [{ key: "portal", label: "portal do aluno", terms: ["portal do aluno"] }],
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

function llmReturning(payload: unknown | (() => never)): LlmPort {
  return {
    async complete() {
      throw new Error("não usado");
    },
    async completeJson<T>(_o: CompleteOptions) {
      if (typeof payload === "function") (payload as () => never)();
      return {
        value: payload as T,
        usage: { promptTokens: 0, completionTokens: 0 },
        model: "stub",
      };
    },
    modelFor: () => "stub",
    async listFreeModels() {
      return [];
    },
  };
}

const candidate = (cnpj: string, over: Partial<ScoreCandidate> = {}): ScoreCandidate => ({
  cnpj,
  razaoSocial: "Escola X",
  nomeFantasia: "Escola X",
  cnae: "8520",
  cnaeDescricao: "Ensino médio",
  uf: "SP",
  municipio: "São Paulo",
  dataInicioAtividade: "2015-01-01",
  porte: "03",
  mei: false,
  site: null,
  ...over,
});

test("a model failure writes the error and NEVER a score", async () => {
  const llm = llmReturning(() => {
    throw new Error("429 rate limited");
  });
  const [r] = await scoreCompanies(llm, spec, [candidate("11111111000111")]);
  assert.ok(r);
  assert.equal(r.bestFit, null, "no fabricated number");
  assert.equal(r.tier, null);
  assert.deepEqual(r.fits, {});
  assert.match(r.error ?? "", /429/);
});

test("malformed JSON is a failure, not a default score", async () => {
  const llm = llmReturning(() => {
    throw new Error("Model did not return valid JSON");
  });
  const [r] = await scoreCompanies(llm, spec, [candidate("11111111000111")]);
  assert.equal(r?.bestFit, null);
  assert.ok(r?.error);
});

test("a CNPJ the model skipped is recorded as failed, not dropped", async () => {
  const llm = llmReturning({
    results: [{ cnpj: "11111111000111", fit: 5, confidence: "high" }],
  });
  const out = await scoreCompanies(llm, spec, [
    candidate("11111111000111"),
    candidate("22222222000122"),
  ]);
  assert.equal(out.length, 2, "every candidate gets a row");
  assert.equal(out[0]?.bestFit, 5);
  assert.equal(out[1]?.bestFit, null);
  assert.match(out[1]?.error ?? "", /não devolveu/);
});

test("tier is derived from the fits, whatever the model says", async () => {
  const llm = llmReturning({
    results: [{ cnpj: "11111111000111", fit: 4, confidence: "high", tier: "hot" }],
  });
  const [r] = await scoreCompanies(llm, spec, [candidate("11111111000111")]);
  // The model said "hot"; 4 means warm. The derivation wins.
  assert.equal(r?.tier, "warm");
});

test("out-of-range and non-integer scores are rejected, not clamped", async () => {
  const llm = llmReturning({
    results: [{ cnpj: "11111111000111", fit: 9, confidence: "high" }],
  });
  const [r] = await scoreCompanies(llm, spec, [candidate("11111111000111")]);
  assert.equal(r?.fits.fit, null);
  assert.equal(r?.bestFit, null);
});

test("the [RAMO: errado] tag flags a wrong business even if the boolean disagrees", async () => {
  const llm = llmReturning({
    results: [
      {
        cnpj: "11111111000111",
        fit: 5,
        confidence: "high",
        wrong_business_type: false,
        justification: "o site fala de oncologia, não de ensino. [RAMO: errado]",
      },
    ],
  });
  const [r] = await scoreCompanies(llm, spec, [candidate("11111111000111")]);
  assert.equal(r?.wrongType, true, "the tag must break the tie");
});

test("bare-array and {leads:[]} responses are both accepted", async () => {
  for (const payload of [
    [{ cnpj: "11111111000111", fit: 3, confidence: "low" }],
    { leads: [{ cnpj: "11111111000111", fit: 3, confidence: "low" }] },
  ]) {
    const [r] = await scoreCompanies(llmReturning(payload), spec, [
      candidate("11111111000111"),
    ]);
    assert.equal(r?.bestFit, 3);
  }
});

test("renderCandidate separates 'not found' from 'never looked'", () => {
  const notCrawled = renderCandidate(candidate("1"), spec);
  assert.match(notCrawled, /site: NÃO VERIFICADO/);
  assert.doesNotMatch(notCrawled, /procurado e NÃO encontrado/);

  const crawled = renderCandidate(
    candidate("1", {
      site: {
        finalUrl: "https://escola.com.br",
        isDead: false,
        isLinkHub: false,
        isFreeBuilder: false,
        hasViewport: true,
        hasWaLink: null,
        hasContactPath: true,
        platform: null,
        footerYear: null,
        title: "Escola",
        textExcerpt: "a".repeat(2000),
        probes: { portal: false },
      },
    }),
    spec
  );
  assert.match(crawled, /procurado e NÃO encontrado \(li 2000 caracteres\): portal do aluno/);
  // Full page read, zero hits: say so outright rather than hoping it is inferred.
  assert.match(crawled, /CONFLITO/);
});

test("a short page makes a probe miss inconclusive, so no CONFLITO", () => {
  const out = renderCandidate(
    candidate("1", {
      site: {
        finalUrl: "https://x.com.br",
        isDead: false,
        isLinkHub: false,
        isFreeBuilder: false,
        hasViewport: null,
        hasWaLink: null,
        hasContactPath: null,
        platform: null,
        footerYear: null,
        title: null,
        textExcerpt: "oi",
        probes: { portal: false },
      },
    }),
    spec
  );
  assert.doesNotMatch(out, /CONFLITO/);
});
