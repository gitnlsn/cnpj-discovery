import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileSpec,
  compileTargeting,
  compileRubric,
  isTargetingDraft,
} from "../src/usecases/compileSpec";
import type { CompleteOptions, LlmPort, Usage } from "../src/ports/index";

const TARGETING = {
  cnaePrefixes: ["8513"],
  cnaeExclude: [],
  ufs: ["SP"],
  excludeMei: true,
  matrizOnly: true,
  probes: [{ key: "site", label: "Site", terms: ["matrícula"], meaning: "positive" }],
  icpCoverage: [
    { criterion: "escola particular", mapped: true, mappedTo: "CNAE 8513" },
    { criterion: "mais de 200 alunos", mapped: false, mappedTo: "a base não tem" },
  ],
};

const RUBRIC = {
  summary: "Sites para escolas",
  buyer: "Diretor",
  problem: "Site velho",
  axes: [
    {
      key: "fit",
      label: "Fit",
      question: "Precisa de site?",
      anchors: { "1": "não", "2": "pouco", "3": "talvez", "4": "sim", "5": "muito" },
    },
  ],
  recommendations: [{ value: "abordar", label: "Abordar", when: "encaixa" }],
  siteSignals: "full",
};

/**
 * Answers by `schemaName`, so a test can make one of the two calls fail without
 * caring which order they run in.
 */
function stub(fail?: { schemaName: string; times: number }): LlmPort & {
  seen: { schemaName?: string; prompt: string }[];
} {
  const seen: { schemaName?: string; prompt: string }[] = [];
  let left = fail?.times ?? 0;
  const usage: Usage = { promptTokens: 1, completionTokens: 1 };

  return {
    seen,
    complete: async () => ({ text: "", usage, model: "stub" }),
    completeJson: async <T>(o: CompleteOptions) => {
      seen.push({
        schemaName: o.schemaName,
        prompt: o.messages.map((m) => m.content).join("\n"),
      });
      if (o.schemaName === fail?.schemaName && left-- > 0) {
        throw new Error("Gemini 503: The model is overloaded. Please try again later.");
      }
      const value = o.schemaName === "targeting" ? TARGETING : RUBRIC;
      return { value: value as T, usage, model: `stub-${o.schemaName}` };
    },
    modelFor: () => "stub",
    listFreeModels: async () => [],
  };
}

const input = { description: "Sites para escolas particulares", icpText: "mais de 200 alunos" };

test("compilar é alvo e depois rubrica, nessa ordem", async () => {
  const llm = stub();
  const { spec, model } = await compileSpec(llm, input);

  assert.deepEqual(
    llm.seen.map((c) => c.schemaName),
    ["targeting", "rubric"]
  );
  assert.equal(spec.targeting.cnaePrefixes[0], "8513");
  assert.equal(spec.rubric.axes.length, 1);
  assert.equal(model, "stub-rubric", "o modelo gravado é o da rubrica");
});

test("o 503 na rubrica não custa a chamada do alvo de novo", async () => {
  const llm = stub({ schemaName: "rubric", times: 1 });

  // Primeira tentativa: o alvo responde, a rubrica cai. O chamador guarda o
  // rascunho — é isso que a coluna spec_draft faz.
  const draft = await compileTargeting(llm, input);
  await assert.rejects(() => compileRubric(llm, input, draft), /503/);

  // A retomada refaz só a rubrica.
  const { spec } = await compileRubric(llm, input, draft);
  assert.equal(spec.summary, "Sites para escolas");

  const targetingCalls = llm.seen.filter((c) => c.schemaName === "targeting").length;
  assert.equal(targetingCalls, 1, "o alvo foi pedido ao modelo uma única vez");
  assert.equal(llm.seen.length, 3, "três chamadas no total, não quatro");
});

test("um rascunho passado a compileSpec pula a primeira chamada", async () => {
  const llm = stub();
  const draft = { targeting: TARGETING as unknown as Record<string, unknown>, model: "antigo" };

  await compileSpec(llm, input, draft);
  assert.deepEqual(
    llm.seen.map((c) => c.schemaName),
    ["rubric"]
  );
});

test("o critério que não virou filtro chega no prompt da rubrica", async () => {
  const llm = stub();
  await compileSpec(llm, input);

  const rubricPrompt = llm.seen.find((c) => c.schemaName === "rubric")!.prompt;
  assert.match(rubricPrompt, /mais de 200 alunos/, "o critério não mapeado tem de ser dito");
  assert.match(rubricPrompt, /NÃO viraram filtro/);
  // É esta dependência que impede juntar as duas chamadas ou rodá-las em paralelo.
  const targetingPrompt = llm.seen.find((c) => c.schemaName === "targeting")!.prompt;
  assert.doesNotMatch(targetingPrompt, /NÃO viraram filtro/);
});

test("um rascunho de outra origem é recusado", () => {
  assert.ok(isTargetingDraft({ targeting: TARGETING, model: "stub" }));
  assert.ok(!isTargetingDraft(null));
  assert.ok(!isTargetingDraft({ targeting: TARGETING }), "sem model não serve");
  assert.ok(!isTargetingDraft({ targeting: {}, model: "x" }), "sem cnaePrefixes não serve");
  assert.ok(!isTargetingDraft("{}"));
});
