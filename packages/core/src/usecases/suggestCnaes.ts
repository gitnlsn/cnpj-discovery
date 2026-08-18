import type { LlmPort } from "../ports/index";

/**
 * Asks the model which CNAEs fit a profile — and then checks every one.
 *
 * The model invents CNAE codes. That is not an occasional slip: "8599-6/05" is
 * real, "8599-6/09" is not, and the model produces both with the same
 * confidence. So a suggestion is a proposal, never a fact. The caller resolves
 * each code against the official dictionary and the real company counts, and
 * the UI shows the three outcomes separately:
 *
 *   ok      - the code exists and has companies
 *   empty   - the code exists, but nothing matches the other filters
 *   unknown - no such code. The model made it up.
 *
 * Collapsing "unknown" into "empty" would hide the hallucination behind a
 * plausible zero, which is exactly how a bad segment survives review.
 */

const SYSTEM = `Você sugere códigos CNAE (Classificação Nacional de Atividades Econômicas) que
correspondem a um perfil de cliente.

REGRAS:
- Devolva o código NUMÉRICO, 7 dígitos, sem pontuação. Ex: 8599605.
- Prefira códigos específicos a divisões inteiras.
- No máximo 12 sugestões, ordenadas da mais central para a mais periférica.
- Em "rationale", diga em uma frase por que esse ramo tem o problema descrito.
- Se não tiver certeza de um código, NÃO invente: prefira sugerir menos.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cnae", "guessedLabel", "rationale"],
        properties: {
          cnae: { type: "string" },
          /** What the model thinks the code means — compared against the real one. */
          guessedLabel: { type: "string" },
          rationale: { type: "string" },
        },
      },
    },
  },
} as const;

export interface CnaeSuggestion {
  cnae: string;
  guessedLabel: string;
  rationale: string;
}

export async function suggestCnaes(
  llm: LlmPort,
  input: { description: string; icpText: string }
): Promise<{ suggestions: CnaeSuggestion[]; model: string }> {
  const icp = input.icpText.trim() ? `\n\nPERFIL DE CLIENTE IDEAL:\n${input.icpText.trim()}` : "";
  const res = await llm.completeJson<{ suggestions: CnaeSuggestion[] }>({
    task: "suggest",
    schemaName: "cnae_suggestions",
    schema: SCHEMA as unknown as Record<string, unknown>,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `PRODUTO:\n${input.description.trim()}${icp}` },
    ],
  });

  const seen = new Set<string>();
  const suggestions: CnaeSuggestion[] = [];
  for (const s of res.value.suggestions ?? []) {
    const cnae = String(s.cnae ?? "").replace(/\D/g, "");
    if (cnae.length < 2 || cnae.length > 7 || seen.has(cnae)) continue;
    seen.add(cnae);
    suggestions.push({
      cnae,
      guessedLabel: String(s.guessedLabel ?? "").slice(0, 200),
      rationale: String(s.rationale ?? "").slice(0, 300),
    });
  }
  return { suggestions, model: res.model };
}
