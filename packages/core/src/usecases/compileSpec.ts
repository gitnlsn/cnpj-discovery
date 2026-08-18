import type { LlmPort } from "../ports/index";
import { parseProjectSpec, LIMITS, type ProjectSpec } from "../domain/spec";

/**
 * Turns a written product description and ideal customer profile into a spec.
 *
 * Two calls, not one. A single strict JSON schema covering targeting, probes,
 * axes and anchors is large enough that free structured-output models start
 * returning prose instead of JSON. Splitting it keeps each schema answerable.
 *
 * The model is never asked for ranking weights or for the tier mapping. Those
 * are assembled in code, because a number the model invents is a number nobody
 * can audit later.
 */

const TARGETING_SYSTEM = `Você traduz a descrição de um produto e o perfil de cliente ideal (ICP) em
FILTROS sobre a base de empresas da Receita Federal.

A base tem, por empresa: CNAE principal, natureza jurídica, porte, capital
social, opção pelo Simples/MEI, data de início de atividade, UF, município,
bairro, telefone e e-mail.

A base NÃO tem: número de funcionários, faturamento, número de clientes ou de
alunos, tecnologia usada, nome do dono, redes sociais, nem site.

REGRAS:
- cnaePrefixes: códigos CNAE numéricos. Pode ser prefixo ("8599" pega todo
  8599xxx) ou o código completo de 7 dígitos. Prefira poucos e certeiros.
- Todo critério do ICP tem que aparecer em icpCoverage, com mapped=true e onde
  virou filtro, OU mapped=false e POR QUE não deu. Não invente um filtro para
  um critério que a base não suporta — diga que não deu.
- probes: termos LITERAIS que apareceriam no site de um bom cliente. Nada de
  regex. Poucos e específicos.
- Trate o ICP como requisito, não como sugestão.`;

const TARGETING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["cnaePrefixes", "cnaeExclude", "ufs", "excludeMei", "matrizOnly", "probes", "icpCoverage"],
  properties: {
    cnaePrefixes: { type: "array", items: { type: "string" }, maxItems: LIMITS.maxCnaePrefixes },
    cnaeExclude: { type: "array", items: { type: "string" } },
    ufs: { type: "array", items: { type: "string" } },
    naturezaPrefixes: { type: "array", items: { type: "string" } },
    excludeMei: { type: "boolean" },
    matrizOnly: { type: "boolean" },
    minCapitalSocial: { type: ["number", "null"] },
    minAgeYears: { type: ["number", "null"] },
    maxAgeYears: { type: ["number", "null"] },
    requireNomeFantasia: { type: "boolean" },
    probes: {
      type: "array",
      maxItems: LIMITS.maxProbes,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "terms", "meaning"],
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          terms: { type: "array", items: { type: "string" }, maxItems: LIMITS.maxProbeTerms },
          meaning: { type: "string", enum: ["positive", "negative"] },
        },
      },
    },
    icpCoverage: {
      type: "array",
      maxItems: LIMITS.maxIcpCriteria,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "mapped", "mappedTo"],
        properties: {
          criterion: { type: "string" },
          mapped: { type: "boolean" },
          mappedTo: { type: "string" },
        },
      },
    },
  },
} as const;

const RUBRIC_SYSTEM = `Você escreve a RUBRICA que vai pontuar cada empresa como possível cliente.

REGRAS:
- No máximo 3 eixos. Cada eixo tem uma pergunta e os 5 níveis DESCRITOS.
- Nota maior significa SEMPRE cliente melhor. Nunca inverta a escala.
- Os 5 níveis precisam ser distinguíveis por quem lê a página da empresa. Se
  dois níveis não dá para separar olhando o site, junte-os e use menos eixos.
- recommendations: as AÇÕES possíveis com um lead depois de pontuado, e quando
  usar cada uma. É uma lista curta de decisões, tipo:
    {"value":"abordar","label":"Abordar","when":"encaixa no perfil e tem contato"}
    {"value":"pesquisar","label":"Pesquisar antes","when":"parece bom mas falta informação"}
    {"value":"descartar","label":"Descartar","when":"não encaixa"}
  NÃO coloque aqui heurísticas, exemplos de mensagem, nem os campos abaixo.
- notes: heurísticas específicas deste produto, curtas. Campo separado.
- hookBad/hookGood: exemplos de PRIMEIRA FRASE de mensagem. Campos separados.

Cada campo recebe só o que foi pedido nele. Repetir o conteúdo de um campo
dentro de outro quebra a pontuação depois.`;

const RUBRIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "buyer", "problem", "axes", "recommendations", "siteSignals"],
  properties: {
    summary: { type: "string" },
    buyer: { type: "string" },
    problem: { type: "string" },
    axes: {
      type: "array",
      maxItems: LIMITS.maxAxes,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "question", "anchors"],
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          question: { type: "string" },
          anchors: {
            type: "object",
            additionalProperties: false,
            required: ["1", "2", "3", "4", "5"],
            properties: {
              "1": { type: "string" }, "2": { type: "string" }, "3": { type: "string" },
              "4": { type: "string" }, "5": { type: "string" },
            },
          },
        },
      },
    },
    recommendations: {
      type: "array",
      maxItems: LIMITS.maxRecommendations,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["value", "label", "when"],
        properties: {
          value: { type: "string" }, label: { type: "string" }, when: { type: "string" },
        },
      },
    },
    notes: { type: "array", items: { type: "string" } },
    siteSignals: { type: "string", enum: ["full", "minimal", "none"] },
    hookBad: { type: "array", items: { type: "string" } },
    hookGood: { type: "array", items: { type: "string" } },
  },
} as const;

export interface CompileInput {
  description: string;
  icpText: string;
}

export interface CompileResult {
  spec: ProjectSpec;
  model: string;
}

export async function compileSpec(
  llm: LlmPort,
  input: CompileInput
): Promise<CompileResult> {
  const icpBlock = input.icpText.trim()
    ? `\n\nPERFIL DE CLIENTE IDEAL (trate como requisito, não como sugestão):\n${input.icpText.trim()}`
    : "";

  const targeting = await llm.completeJson<Record<string, unknown>>({
    task: "compile",
    schemaName: "targeting",
    schema: TARGETING_SCHEMA as unknown as Record<string, unknown>,
    messages: [
      { role: "system", content: TARGETING_SYSTEM },
      { role: "user", content: `PRODUTO:\n${input.description.trim()}${icpBlock}` },
    ],
  });

  const unmapped = Array.isArray(targeting.value.icpCoverage)
    ? (targeting.value.icpCoverage as { criterion?: string; mapped?: boolean }[])
        .filter((c) => c.mapped === false)
        .map((c) => c.criterion)
        .filter(Boolean)
    : [];

  // The rubric call is told what the filters could NOT enforce, so it can put
  // those criteria into the anchors instead. Otherwise an unmappable criterion
  // vanishes twice: not a filter, and not scored either.
  const unmappedBlock = unmapped.length
    ? `\n\nEstes critérios do ICP NÃO viraram filtro (a base não os tem):\n` +
      unmapped.map((c) => `- ${c}`).join("\n") +
      `\nEles precisam aparecer na rubrica, para a triagem acontecer na nota.`
    : "";

  const rubric = await llm.completeJson<Record<string, unknown>>({
    task: "compile",
    schemaName: "rubric",
    schema: RUBRIC_SCHEMA as unknown as Record<string, unknown>,
    messages: [
      { role: "system", content: RUBRIC_SYSTEM },
      {
        role: "user",
        content: `PRODUTO:\n${input.description.trim()}${icpBlock}${unmappedBlock}`,
      },
    ],
  });

  // Validated, never cast. The model wrote both halves of this object.
  const spec = parseProjectSpec({
    summary: rubric.value.summary,
    buyer: rubric.value.buyer,
    problem: rubric.value.problem,
    targeting: targeting.value,
    probes: targeting.value.probes,
    icpCoverage: targeting.value.icpCoverage,
    rubric: rubric.value,
  });

  return { spec, model: rubric.model };
}
