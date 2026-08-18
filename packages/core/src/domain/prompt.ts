import { createHash } from "node:crypto";
import type { ProjectSpec } from "./spec";

/**
 * Composes the scoring prompt from shared guardrails plus project-specific anchors.
 *
 * The split matters. Roughly 60% of the original hardcoded RUBRIC was not about
 * websites or chatbots at all — it was about not lying: use only the evidence
 * given, say "cannot_determine" instead of guessing, never assert something that
 * was not verified, and never claim a business lacks something merely because we
 * did not find it. That text is the reason the scores are trustworthy, and it is
 * true for every product. It lives here, unchanged, and no offer can edit it.
 *
 * What an offer supplies is only what it is selling and what a good buyer looks
 * like. That is why the dashboard lets a user edit *fields* rather than a raw
 * prompt: a free-form textarea would let someone delete the guardrails below.
 */

// --------------------------------------------------------------- guardrails

/** Epistemics: what the data can and cannot support. Product-agnostic. */
const EVIDENCE_RULES = `IMPORTANTE — os dados vêm da Receita Federal, que NÃO tem campo de site.
"site: NÃO ENCONTRADO" significa que não achamos um site, não que ele não exista.
Nesse caso use confidence "low" ou "medium", nunca "high", e não dê 5.
Nota 5 exige EVIDÊNCIA POSITIVA e verificada — nunca ausência de informação.

REGRAS:
- Baseie-se SOMENTE nas evidências fornecidas. Não invente fatos.
- Não suponha porte, faturamento, número de alunos, de clientes ou de
  funcionários: esses dados NÃO existem na base. Se a nota depender disso,
  use confidence mais baixa.
- Se as evidências forem insuficientes, use confidence "cannot_determine" e
  TODAS as notas null. É uma resposta legítima e preferível a um chute.
- Nota maior significa SEMPRE cliente melhor para quem vende. Nunca inverta.`;

/**
 * The hook rules. This is the part that decides whether a message gets a reply
 * or a block, and every clause was earned. The PROIBIDO examples stay because
 * the site check runs for every offer, so "site NÃO ENCONTRADO" appears in every
 * candidate rendering and the model must know what it may not conclude from it.
 */
const HOOK_RULES = `O campo MAIS IMPORTANTE é "hook": UMA frase em português do Brasil, informal,
que você mandaria no WhatsApp, citando um fato CONCRETO e específico daquele
negócio.

REGRA ABSOLUTA DO HOOK — nunca afirme algo que não foi verificado.
Se o dado diz "site NÃO ENCONTRADO", você NÃO sabe que eles não têm site.
Dizer "vi que vocês não têm site" é mentira e queima o contato.
Nesse caso, ou fale do que você REALMENTE sabe (ramo, cidade, tempo de
abertura), ou PERGUNTE em vez de afirmar.
  PROIBIDO: "vi que vocês não têm site"
  PROIBIDO: afirmar que eles não usam / não têm alguma coisa que não foi checada
  OK:       perguntar como fazem hoje, em vez de afirmar que não fazem

Se não houver nada específico e honesto a dizer, deixe hook null.
Um hook genérico é pior que nenhum: é ele que faz a pessoa bloquear.`;

const ADVICE_RULES = `O campo "advice" é para VOCÊ, não para o cliente: uma frase dizendo o que fazer
com esse lead e por quê. Cite o sinal que decidiu a nota. Se a página não foi
lida, diga isso — "sem site conhecido, vale procurar antes de abordar" é um
conselho útil; "parece promissor" não é.`;

const OUTPUT_RULES = `Responda um objeto por negócio, na mesma ordem recebida, com o cnpj exato.`;

// ----------------------------------------------------------------- composer

export function buildRubricPrompt(spec: ProjectSpec): string {
  const parts: string[] = [];

  parts.push(EVIDENCE_RULES);

  parts.push(
    `Você avalia empresas brasileiras como potenciais clientes de:\n${spec.summary}\n\n` +
      `Quem decide a compra: ${spec.buyer}\n` +
      `Problema que o produto resolve: ${spec.problem}`
  );

  for (const axis of spec.rubric.axes) {
    parts.push(
      `${axis.key} — ${axis.question}\n` +
        (["5", "4", "3", "2", "1"] as const)
          .map((lvl) => `  ${lvl} = ${axis.anchors[lvl]}`)
          .join("\n")
    );
  }

  if (spec.rubric.notes.length) {
    parts.push(`Heurísticas específicas deste produto:\n` + spec.rubric.notes.map((n) => `- ${n}`).join("\n"));
  }

  parts.push(
    `wrong_business_type — antes de pontuar, decida se a empresa é do ramo:\n` +
      `  O CNAE é um filtro grosso e deixa passar negócio de outro ramo. Se o\n` +
      `  título ou o texto da página mostrarem outra atividade, marque true e\n` +
      `  diga em justification o que a página diz que ela faz.\n` +
      `  true = ramo errado. NÃO é para encaixe fraco — para isso use nota baixa.\n` +
      `  Se a página foi lida e NENHUM sinal do produto apareceu, isso é prova de\n` +
      `  ausência e pesa. Se a página não foi lida, você não sabe: não marque true\n` +
      `  só pelo silêncio.\n` +
      `  Conflito entre CNAE e site NÃO é "cautela" nem "inconsistência de dados":\n` +
      `  é ramo errado. O CNAE é cadastro que envelhece; o site é o que a empresa\n` +
      `  faz hoje. Se o título e o texto falam de outro negócio, decida.\n` +
      `  TERMINE justification com [RAMO: ok] ou [RAMO: errado], e faça o booleano\n` +
      `  concordar com essa marca. Não adianta escrever "mas o site é de outro ramo"\n` +
      `  e deixar wrong_business_type=false — isso é se contradizer.`
  );

  parts.push(
    `recommendation — qual caminho seguir com este lead:\n` +
      spec.rubric.recommendations.map((r) => `  "${r.value}" (${r.label}) quando ${r.when}`).join("\n")
  );

  // Offer-specific hook examples are appended AFTER the shared rules, so they
  // can add cases but never soften the prohibition above.
  const hookExtras: string[] = [];
  for (const bad of spec.rubric.hookBad) hookExtras.push(`  PROIBIDO: ${bad}`);
  for (const good of spec.rubric.hookGood) hookExtras.push(`  OK:       ${good}`);
  parts.push(hookExtras.length ? `${HOOK_RULES}\n\nPara este produto:\n${hookExtras.join("\n")}` : HOOK_RULES);

  parts.push(ADVICE_RULES);
  parts.push(OUTPUT_RULES);

  return parts.join("\n\n");
}

/**
 * Builds the JSON Schema from the offer's axes.
 *
 * Called ONCE per run, before the batch loop, so the system prompt is constant
 * within a run and stays prompt-cacheable. `strict: true` on OpenRouter requires
 * every property listed in `required` and `additionalProperties: false`.
 *
 * `tier` is deliberately absent: it is a pure function of the fits and is derived
 * in TypeScript. Asking the model for it adds a failure mode and makes the
 * hot/warm/cold mapping unauditable.
 */
export function buildScoreSchema(spec: ProjectSpec): Record<string, unknown> {
  const fitProps: Record<string, unknown> = {};
  for (const axis of spec.rubric.axes) {
    fitProps[axis.key] = {
      type: ["integer", "null"],
      minimum: 1,
      maximum: 5,
      description: axis.question,
    };
  }

  const properties: Record<string, unknown> = {
    cnpj: { type: "string" },
    // Justification first so generation is conditioned on the reasoning.
    justification: { type: "string" },
    // One boolean, deliberately. The CNAE is a coarse gate: "Cursos
    // preparatórios para concursos" also contains a ballooning company and an
    // oncology clinic, and without somewhere to say "wrong business" the model
    // reasons from the CNAE label and grades everything a 5. The reason goes in
    // `justification` rather than a second field — this schema is already at the
    // size where free structured-output models start returning prose.
    wrong_business_type: {
      type: "boolean",
      description:
        "true quando a empresa é de OUTRO RAMO — não um encaixe fraco, mas o " +
        "negócio errado para esta oferta. O CNAE é indício; o texto da página manda.",
    },
    ...fitProps,
    confidence: { type: "string", enum: ["high", "medium", "low", "cannot_determine"] },
    recommendation: {
      type: "string",
      enum: spec.rubric.recommendations.map((r) => r.value),
    },
    evidence: { type: "array", items: { type: "string" } },
    hook: { type: ["string", "null"] },
    advice: { type: ["string", "null"] },
  };

  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: Object.keys(properties),
          properties,
        },
      },
    },
  };
}

/**
 * Identity of the exact prompt that produced a score. Stored on every score row
 * so "which rubric graded this lead?" has a precise answer even after the spec
 * has been edited a dozen times.
 */
export function promptSha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
