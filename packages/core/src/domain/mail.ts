/**
 * What an e-mail address tells you about a Brazilian company.
 *
 * Domain vocabulary rather than crawler internals: the query layer filters on
 * "own domain" and the crawler decides whether to guess a URL from it, and the
 * two must agree on what counts as a consumer provider.
 */

/**
 * Free/consumer mail providers. An address at one of these tells us nothing
 * about a website; an address at any other domain usually IS their domain.
 */
export const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.com.br",
  "outlook.com",
  "outlook.com.br",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.com.br",
  "ymail.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "ig.com.br",
  "globo.com",
  "globomail.com",
  "r7.com",
  "oi.com.br",
  "zipmail.com.br",
  "superig.com.br",
  "brturbo.com.br",
  "pop.com.br",
  "click21.com.br",
  "veloxmail.com.br",
]);

/**
 * Mistyped consumer providers. These resolve to parking or spam pages and
 * would otherwise be scored as though the business owned the domain.
 */
export const TYPO_MAIL =
  /^(gmai|gmial|gmail|hotmai|hotmial|outlok|yaho|uol|bol|terra|ig|globo)\.(com|com\.br)$/;

/**
 * Brazilian accounting-office markers — the classic wrong attribution, because
 * the accountant who filed the registration puts their own address in it.
 *
 * Two patterns, not one. The short stems have to stay anchored to a boundary:
 * unanchored, "escrit" matches "descritivo" and "conta" matches half the
 * language. But that anchoring misses "silvacontabilidade.com.br", which is
 * unmistakably an accounting firm, so the unambiguous full words are matched
 * anywhere in the domain.
 */
export const ACCOUNTANT =
  /(^|[.-])(contab|contabil|assessoria|escritorio|escrit|conta[bd]|fiscal|tributa)/;
export const ACCOUNTANT_WORD = /(contabilidade|contabeis|contadores|contabil)/;
