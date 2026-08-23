/**
 * Turns a fetch failure into something a person can act on.
 *
 * Node's fetch reports every network problem as the string "fetch failed" and
 * hides the real reason in `cause`. That is worse than useless here: "the
 * domain does not exist" means the e-mail guess was wrong, while "connection
 * refused" means the guess was right and the site is down — and those lead to
 * opposite decisions about the lead.
 *
 * Pure classification with no I/O, which is why it sits in `domain` rather than
 * beside the crawler that first needed it. The Receita sync needs exactly the
 * same answers for exactly the same reason, and `packages/data` can only reach
 * `@cnpj/core/domain`.
 */
export function describeFetchError(err: unknown, timeoutMs: number): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  if (e?.name === "AbortError") return `timeout após ${timeoutMs}ms`;

  const code = e?.cause?.code;
  switch (code) {
    case "ENOTFOUND":
      return "domínio não existe";
    case "ECONNREFUSED":
      return "conexão recusada";
    case "ECONNRESET":
      return "conexão interrompida pelo servidor";
    case "ETIMEDOUT":
      return "servidor não respondeu";
    case "EAI_AGAIN":
      return "falha de DNS";
    case "CERT_HAS_EXPIRED":
      return "certificado HTTPS vencido";
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return "certificado HTTPS não confiável";
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return "certificado HTTPS incompleto";
    default:
      break;
  }
  const detail = e?.cause?.message ?? e?.message ?? String(err);
  return detail === "fetch failed" ? "site inacessível" : detail.slice(0, 200);
}

/** Whether the failure means the hostname itself did not resolve. */
export function isDnsFailure(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  return code === "ENOTFOUND" || code === "EAI_AGAIN";
}
