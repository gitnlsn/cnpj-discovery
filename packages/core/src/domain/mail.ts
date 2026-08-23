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
 *
 * Widened after reading what the base actually contains. The earlier version
 * required a well-formed `.com`/`.com.br`, which missed two whole families:
 *
 * - a mistyped provider name: `homail.com`, `gmil.com`, `outook.com`;
 * - a mistyped TLD: `gmail.con`, where the provider is spelled right and the
 *   suffix is not, so anchoring on a valid TLD could never match it.
 *
 * All of them are registered domains — typosquatters park on exactly these —
 * so the crawl succeeds and returns an ad page that becomes the company's
 * "website". A dead domain is harmless; a parked one is fabricated evidence.
 */
const PROVIDER_STEMS =
  "gmai|gmial|gmail|gmil|gmailc|gemail|hotmai|hotmial|homail|hotmal|hotmil|" +
  "outlok|outook|outlook|otlook|yaho|yahho|uol|bol|terra|ig|globo|iclod|icloud";

export const TYPO_MAIL = new RegExp(
  // Either a mistyped stem on a plausible suffix, or a correctly spelled
  // provider on a mistyped one.
  `^(?:(?:${PROVIDER_STEMS})\\.(?:com|com\\.br|net|br)` +
    `|(?:gmail|hotmail|outlook|yahoo|icloud|live|terra|uol|bol)\\.(?:c[o0]n|cm|om|comm|co|bt|cim|xom|vom))$`
);

/**
 * Consumer providers on any country suffix.
 *
 * `yahoo.es`, `yahoo.fr` and `yahoo.it` were each crawled as though they were a
 * Brazilian company's homepage, returning 2.5 KB of Yahoo's Spanish portal to
 * the scorer. `FREE_MAIL` lists the Brazilian and .com forms; a Brazilian MEI
 * with a yahoo.es address is still just somebody with a Yahoo address.
 */
export const FREE_MAIL_ANY_TLD =
  /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|aol|protonmail)\./;

/**
 * Institutions whose domain belongs to the institution, not to the person.
 *
 * A MEI who registered a university address is a student or a lecturer there.
 * Guessing a website from it hands the scorer `unicesumar.edu.br` — 8,000
 * characters of a real university's homepage — as this company's site, which
 * reads as a substantial, professional operation. That was measured, not
 * imagined. `.gov.br` was already excluded for the same reason; these are the
 * rest of the family.
 */
export const INSTITUTIONAL =
  /(\.edu\.br|\.edu|\.ac\.br|oab[a-z]{0,2}\.org\.br|\.jus\.br|\.mil\.br|\.leg\.br|\.g12\.br)$/;

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
