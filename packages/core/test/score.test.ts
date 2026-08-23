import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreCompanies,
  renderCandidate,
  type ScoreCandidate,
} from "../src/usecases/scoreCompanies";
import { parseProjectSpec } from "../src/domain/spec";
import { buildRubricPrompt, promptSha } from "../src/domain/prompt";
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
        structuredText: null,
        isJsShell: false,
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
        structuredText: null,
        isJsShell: false,
        probes: { portal: false },
      },
    }),
    spec
  );
  assert.doesNotMatch(out, /CONFLITO/);
});

// ------------------------------------------------------------- impressão

test("a human impression is rendered, fenced, and capped", () => {
  const out = renderCandidate(
    candidate("1", { impression: "abri o instagram, é buffet infantil" }),
    spec
  );
  assert.match(out, /impressão de quem olhou: <<<abri o instagram, é buffet infantil>>>/);

  const long = renderCandidate(candidate("1", { impression: "a".repeat(5000) }), spec);
  const fenced = /<<<(a+)>>>/.exec(long)?.[1] ?? "";
  assert.equal(fenced.length, 1200, "capped, and the closing fence survives the cap");
});

test("no impression renders no impression block", () => {
  for (const value of [null, undefined, "   "]) {
    const out = renderCandidate(candidate("1", { impression: value }), spec);
    assert.doesNotMatch(out, /impressão de quem olhou/, `for ${JSON.stringify(value)}`);
  }
});

test("the impression rules reach the model only when there is an impression", async () => {
  const systems: string[] = [];
  const llm: LlmPort = {
    async complete() {
      throw new Error("não usado");
    },
    async completeJson<T>(o: CompleteOptions) {
      systems.push(o.messages.find((m) => m.role === "system")?.content ?? "");
      return {
        value: { results: [{ cnpj: "11111111000111", fit: 4, confidence: "high" }] } as T,
        usage: { promptTokens: 0, completionTokens: 0 },
        model: "stub",
      };
    },
    modelFor: () => "stub",
    async listFreeModels() {
      return [];
    },
  };

  const plain = await scoreCompanies(llm, spec, [candidate("11111111000111")]);
  const withOne = await scoreCompanies(llm, spec, [
    candidate("11111111000111", { impression: "olhei, é outro ramo" }),
  ]);

  assert.doesNotMatch(systems[0] ?? "", /OBSERVAÇÃO, não ORDEM/);
  assert.match(systems[1] ?? "", /OBSERVAÇÃO, não ORDEM/);
  // The sha is the only record of which prompt graded a lead, so the two runs
  // must not claim to have used the same one.
  assert.notEqual(plain[0]?.promptSha, withOne[0]?.promptSha);
});

test("one impression in a batch turns the rules on for the whole run", () => {
  const withImpressions = buildRubricPrompt(spec, { withImpressions: true });
  const without = buildRubricPrompt(spec);
  assert.match(withImpressions, /evidência mais forte/);
  assert.doesNotMatch(without, /evidência mais forte/);
  // The guardrails are still in front of it, not replaced by it.
  assert.match(withImpressions, /Baseie-se SOMENTE nas evidências fornecidas/);
  assert.notEqual(promptSha(withImpressions), promptSha(without));
});
