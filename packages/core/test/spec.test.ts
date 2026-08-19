import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProjectSpec, SpecError, tierFor, bestFit } from "../src/domain/spec";
import { runProbes, extractText } from "../src/domain/probes";
import { classifyRateLimit, backoffMs } from "../src/services/rateLimit";

const minimal = {
  summary: "Sites para escolas",
  buyer: "Diretor",
  problem: "Site velho",
  rubric: {
    axes: [
      {
        key: "fit",
        label: "Fit",
        question: "Precisa de site novo?",
        anchors: { "1": "não", "2": "pouco", "3": "talvez", "4": "sim", "5": "muito" },
      },
    ],
  },
};

test("a spec with no valid axis is rejected, not silently emptied", () => {
  assert.throws(() => parseProjectSpec({ ...minimal, rubric: { axes: [] } }), SpecError);
});

test("an axis missing an anchor level is dropped", () => {
  // A 1-5 scale with an undescribed level is just the model's private opinion.
  assert.throws(
    () =>
      parseProjectSpec({
        ...minimal,
        rubric: {
          axes: [
            { key: "fit", question: "q", anchors: { "1": "a", "2": "b", "3": "c", "4": "d" } },
          ],
        },
      }),
    SpecError
  );
});

test("CNAE codes are normalised to digits", () => {
  const spec = parseProjectSpec({
    ...minimal,
    targeting: { cnaePrefixes: ["8599-6/05", "8520", "lixo", "9"] },
  });
  // "lixo" has no digits and "9" is under two digits: both dropped.
  assert.deepEqual(spec.targeting.cnaePrefixes, ["8599605", "8520"]);
});

test("limits are enforced so the JSON schema stays small enough to answer", () => {
  const spec = parseProjectSpec({
    ...minimal,
    rubric: {
      axes: Array.from({ length: 9 }, (_, i) => ({
        key: `a${i}`,
        question: "q",
        anchors: { "1": "a", "2": "b", "3": "c", "4": "d", "5": "e" },
      })),
    },
    probes: Array.from({ length: 30 }, (_, i) => ({ key: `p${i}`, terms: ["x"] })),
  });
  assert.equal(spec.rubric.axes.length, 3);
  assert.equal(spec.probes.length, 12);
});

test("duplicate probe keys collapse", () => {
  const spec = parseProjectSpec({
    ...minimal,
    probes: [
      { key: "portal", terms: ["portal do aluno"] },
      { key: "portal", terms: ["outra coisa"] },
    ],
  });
  assert.equal(spec.probes.length, 1);
  assert.deepEqual(spec.probes[0]?.terms, ["portal do aluno"]);
});

test("icpCoverage keeps the criteria that could not be mapped", () => {
  const spec = parseProjectSpec({
    ...minimal,
    icpCoverage: [
      { criterion: "escolas particulares", mapped: true, mappedTo: "CNAE 8520" },
      { criterion: "mais de 50 funcionários", mapped: false, mappedTo: "a base não traz" },
    ],
  });
  assert.equal(spec.icpCoverage.length, 2);
  assert.equal(spec.icpCoverage.filter((c) => !c.mapped).length, 1);
});

test("tier is derived from the scores, never supplied", () => {
  assert.equal(tierFor({ a: 5, b: 2 }), "hot");
  assert.equal(tierFor({ a: 4 }), "warm");
  assert.equal(tierFor({ a: 3, b: 1 }), "cold");
  // A failed call leaves every axis null; that must not become "cold".
  assert.equal(tierFor({ a: null }), null);
  assert.equal(bestFit({ a: null }), null);
});

test("probes distinguish 'looked and did not find' from 'never looked'", () => {
  const probes = [
    {
      key: "portal",
      label: "Portal",
      terms: ["portal do aluno"],
      meaning: "positive" as const,
      weight: 1,
    },
  ];
  // No text at all: empty object, NOT {portal: false}.
  assert.deepEqual(runProbes(probes, null), {});
  assert.deepEqual(runProbes(probes, "   "), {});
  // Text present, term absent: an explicit false.
  assert.deepEqual(runProbes(probes, "somos uma escola de idiomas"), { portal: false });
  assert.deepEqual(runProbes(probes, "acesse o Portal do Aluno aqui"), { portal: true });
});

test("probe matching ignores accents and respects word boundaries", () => {
  const probes = [
    { key: "pratico", label: "x", terms: ["prático"], meaning: "positive" as const, weight: 1 },
  ];
  assert.deepEqual(runProbes(probes, "curso pratico de..."), { pratico: true });
  const ia = [
    { key: "ia", label: "x", terms: ["ia"], meaning: "positive" as const, weight: 1 },
  ];
  assert.deepEqual(runProbes(ia, "nossa familia de produtos"), { ia: false });
});

test("extractText strips markup and caps length", () => {
  const html = `<html><script>var x=1</script><style>a{}</style><body><h1>Olá</h1><p>Mundo &amp; tal</p></body></html>`;
  assert.equal(extractText(html), "Olá Mundo & tal");
  assert.equal(extractText("<p>" + "a".repeat(20000) + "</p>", 100).length, 100);
});

test("field names leaking into recommendations are refused", () => {
  // Observed live: the compiler answered with notes/hookBad/hookGood as if they
  // were recommendations, and the scorer then recommended "hookgood".
  const parsed = parseProjectSpec({
    ...minimal,
    rubric: {
      ...minimal.rubric,
      recommendations: [
        { value: "notes", label: "Heurísticas", when: "..." },
        { value: "hookgood", label: "Exemplo de frase", when: "..." },
        { value: "abordar", label: "Abordar", when: "encaixa" },
      ],
    },
  });
  assert.deepEqual(
    parsed.rubric.recommendations.map((r) => r.value),
    ["abordar"]
  );
});

test("a wholly degenerate recommendation list falls back to a usable default", () => {
  const parsed = parseProjectSpec({
    ...minimal,
    rubric: {
      ...minimal.rubric,
      recommendations: [{ value: "hookbad", label: "x", when: "y" }],
    },
  });
  assert.deepEqual(
    parsed.rubric.recommendations.map((r) => r.value),
    ["abordar", "descartar"]
  );
});

test("the literal string 'null' is not data", () => {
  // Models emit "null" as a string often enough that it reaches the screen. In
  // the ICP panel that column exists to explain WHY a criterion failed to map,
  // so "null" there reads as an answer when it is the absence of one.
  const spec = parseProjectSpec({
    ...minimal,
    icpCoverage: [
      { criterion: "mais de 50 funcionários", mapped: false, mappedTo: "null" },
      { criterion: "em SP", mapped: true, mappedTo: "uf: SP" },
    ],
  });
  assert.equal(spec.icpCoverage[0]?.mappedTo, "");
  assert.equal(spec.icpCoverage[1]?.mappedTo, "uf: SP");
});

test("os dois 429 do OpenRouter são coisas diferentes", () => {
  // Tratar os dois como "desista" é o que fazia o processamento contínuo
  // terminar depois de algumas dezenas de empresas.
  const transitorio =
    'OpenRouter 429: {"error":{"message":"Provider returned error","code":429,' +
    '"metadata":{"raw":"google/gemma-4-26b-a4b-it:free is temporarily rate-limited upstream. Please retry shortly"}}}';
  const diario =
    'OpenRouter 429: {"error":{"message":"Rate limit exceeded: free-models-per-day. ' +
    'Add 10 credits to unlock 1000 free model requests per day","code":429}}';

  // As duas frases reais do Gemini para o teto diário.
  const geminiDiario =
    "Gemini 429: Quota exceeded for quota metric 'Generate requests per day'";
  const geminiMetrica =
    "Gemini 429: GenerateRequestsPerDayPerProjectPerModel-FreeTier exceeded";
  const geminiMinuto =
    "Gemini 429: Quota exceeded for quota metric 'Generate requests per minute'";

  assert.equal(classifyRateLimit(transitorio), "transient");
  assert.equal(classifyRateLimit(diario), "daily");
  assert.equal(classifyRateLimit(geminiDiario), "daily");
  assert.equal(classifyRateLimit(geminiMetrica), "daily");
  assert.equal(classifyRateLimit(geminiMinuto), "transient");
  assert.equal(classifyRateLimit("modelo não devolveu resultado para este CNPJ"), "none");
  assert.equal(classifyRateLimit(null), "none");
});

test("o backoff cresce e para de crescer", () => {
  assert.equal(backoffMs(1), 30_000);
  assert.equal(backoffMs(2), 60_000);
  assert.equal(backoffMs(3), 120_000);
  assert.equal(backoffMs(10), 300_000, "não passa de 5 minutos");
});
