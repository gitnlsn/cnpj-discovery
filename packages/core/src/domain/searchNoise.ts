/**
 * Sorting a search result into "tells us something" and "tells us nothing".
 *
 * The name gate in `nameMatch` is necessary but not sufficient, and the reason
 * is counter-intuitive: the results that match a razão social most perfectly
 * are the ones worth least. Query any Brazilian company name and the first page
 * is CNPJ mirror sites — they republish the Receita row verbatim, so they score
 * a flawless exact-name match while containing nothing we did not already have
 * on disk. Without this blocklist the pipeline would confidently "discover"
 * that every company has a web presence, and the presence would be our own
 * database reflected back.
 *
 * Court records are excluded for a different reason. They are real information,
 * but a lawsuit is not evidence about a business, and storing litigation
 * against a named natural person is a liability rather than a lead.
 */

import { hostOf, isHub, isSocialProfileUrl } from "./hosts";
import { isLinkedInProfileUrl } from "./linkedin";

/**
 * Sites that republish the Receita's own data.
 *
 * Matched on the registrable domain, so subdomains are covered. This list is
 * the single highest-leverage thing in the search stage and will need topping
 * up — the sector has a long tail and new mirrors appear constantly.
 */
export const AGGREGATORS = [
  "cnpj.biz",
  "maiscnpj.com.br",
  "baseempresarial.com.br",
  "empresasdobrasil.com.br",
  "b2bleads.com.br",
  "cadastroempresa.com.br",
  "cnpj.faix.com.br",
  "faix.com.br",
  "cnpjbrasil.com",
  "consultacnpjgratis.com.br",
  "empresascnpj.com.br",
  "cnpj.rocks",
  "buscarcnpj.com.br",
  "empresas.serasaexperian.com.br",
  "cnpjcerto.com.br",
  "cnpja.com",
  "cnpj.info",
  "cnpjs.rocks",
  "casadosdados.com.br",
  "econodata.com.br",
  "empresascnpj.com",
  "consultacnpj.com",
  "cnpjinfo.com.br",
  "solutudo.com.br",
  "guiamais.com.br",
  "apontador.com.br",
  "telelistas.net",
  "kompass.com",
  "empresaqui.com.br",
  "informecadastral.com.br",
  "consultasocio.com",
  "seudinheiro.net",
  "cnpjopen.com",
  "receitaws.com.br",
  "situacaocadastral.com.br",
  "quemsomos.com.br",
  "listamais.com.br",
  "encontreinegocios.com.br",
  "boaslojas.com.br",
  "escavador.com",
  "jusbrasil.com.br",
];

/**
 * Court, litigation and public-record sites.
 *
 * Overlaps `AGGREGATORS` for escavador/jusbrasil, which do both; kept in both
 * lists so removing one reason does not silently remove the other.
 */
export const LEGAL = [
  "jusbrasil.com.br",
  "escavador.com",
  "jusbrasil.com",
  "tjsp.jus.br",
  "trf1.jus.br",
  "jus.br",
  "conjur.com.br",
  "migalhas.com.br",
  "consultaprocessos.com.br",
];

/**
 * Job boards and CV sites — a person's employment history, not a business.
 *
 * `linkedin.com` used to be here, and the reason was sound: a profile says where
 * somebody works, not what they run. What changed is the *disposition*, not the
 * reasoning — a MEI who tutors or consults often states the business in their
 * headline, so LinkedIn now gets its own kind and its own gates rather than
 * being dropped unread. The judgement about employers still stands, and it now
 * lives in the prompt where the model can apply it case by case.
 *
 * Do not put it back here without reading `domain/linkedin.ts` first.
 */
export const RESUME = [
  "indeed.com",
  "indeed.com",
  "catho.com.br",
  "vagas.com.br",
  "infojobs.com.br",
  "trabalhabrasil.com.br",
  "glassdoor.com.br",
];

/**
 * LinkedIn, including its own link shortener.
 *
 * `lnkd.in` matters more than it looks: unlisted it classifies as a plain
 * `"site"`, and a `"site"` hit is handed to the crawler at
 * `routers/enrichment.ts` — which would send `crawlSite` at linkedin.com, the
 * one host this feature must never request.
 */
export const LINKEDIN = ["linkedin.com", "lnkd.in"];

/**
 * Places a person's name appears in a document rather than a business.
 *
 * From a live run: an academic paper on ResearchGate by a different João Pedro
 * Carvalho Oliveira, an official notice from the basketball confederation, a
 * soy-growers' association bulletin, a state government gazette, court filings
 * uploaded to Scribd. Every one passed the name gate honestly — the name really
 * is on the page — and none of them is evidence that a cursinho exists.
 *
 * This is the general-web version of the LinkedIn identity problem: matching a
 * name finds documents about *a* person of that name. Gazettes are the worst
 * offenders because Brazilian public administration publishes names constantly.
 */
export const DOCUMENTS = [
  "gov.br",
  "jus.br",
  "oab.org.br",
  "scribd.com",
  "researchgate.net",
  "academia.edu",
  "passeidireto.com",
  "docplayer.com.br",
  "studylib.es",
  "yumpu.com",
  "issuu.com",
  "slideshare.net",
  "dou.gov.br",
  "in.gov.br",
];

const matches = (host: string, list: string[]) =>
  list.some((d) => host === d || host.endsWith(`.${d}`));

/**
 * What kind of thing did we find?
 *
 * - `aggregator` — our own data, reflected. Worthless, and dangerously
 *   convincing because the name always matches.
 * - `legal` — court records. Discarded on purpose, not for lack of signal.
 * - `resume` — a job profile. Says where the person works, not what they run.
 * - `social` — Instagram, Facebook, a link hub. For a MEI this is the finding,
 *   not a consolation prize; it is where the business actually lives.
 * - `site` — a domain of their own. The strongest result, and the only kind the
 *   crawler can read a page from.
 * - `unknown` — an unparseable URL.
 */
export type HitKind =
  "aggregator" | "legal" | "document" | "resume" | "linkedin" | "social" | "site" | "unknown";

export function classifyHit(url: string): HitKind {
  const host = hostOf(url);
  if (!host) return "unknown";
  // Legal before aggregator: jusbrasil and escavador appear in both lists (each
  // for its own reason, so that dropping one does not silently drop the other),
  // and "court record" is the more accurate label for what was found. Either
  // way it is excluded — only the recorded reason differs.
  if (matches(host, LEGAL)) return "legal";
  // Gazettes, papers and uploaded filings: the name is genuinely there, and it
  // is somebody being mentioned rather than somebody trading.
  if (matches(host, DOCUMENTS)) return "document";
  if (matches(host, AGGREGATORS)) return "aggregator";
  if (matches(host, RESUME)) return "resume";
  // LinkedIn before the link-hub check, and narrowed to actual profiles: a post
  // or a job ad on the same host is a different kind of document, and its title
  // puts the person's name in the middle rather than at the front — the one
  // position `domain/linkedin.ts` is able to trust. Those fall through to
  // `resume`, which is excluded, so the narrowing needs no kind of its own.
  if (matches(host, LINKEDIN)) {
    return isLinkedInProfileUrl(url) ? "linkedin" : "resume";
  }
  // Reuses the crawler's own list rather than a second copy of it. Note the
  // inversion: for an established company a link hub means "no real site", and
  // here it means "here is the business".
  //
  // Narrowed to profiles for the same reason LinkedIn is: `instagram.com/p/…` is
  // a post somebody wrote, and the name in it is usually somebody else's doing.
  // A live run stored four posts and a Facebook group thread as this company's
  // "social presence".
  if (isHub(host)) return isSocialProfileUrl(url) ? "social" : "document";
  return "site";
}

/**
 * Kinds worth recording.
 *
 * Renamed from `isUsefulKind`, which was ambiguous because it did two jobs: it
 * gated what got stored AND, because the prompt reads those same rows back, what
 * reached the model. Those are now separate questions — a LinkedIn profile whose
 * headline says nothing is worth keeping as an audit trail and worth nothing as
 * evidence. Storage is decided here; evidence is decided in `toScoreCandidate`,
 * where the company's own facts are in scope.
 */
export function isStorableKind(kind: HitKind): boolean {
  return kind === "social" || kind === "site" || kind === "linkedin";
}

/**
 * Search-engine chrome and our own infrastructure.
 *
 * Filtered before classification so a results page's internal links never
 * reach the name gate.
 */
const NON_RESULTS = [
  "google.com",
  "google.com.br",
  "duckduckgo.com",
  "bing.com",
  "webcache.googleusercontent.com",
  "translate.google.com",
  "policies.google.com",
  "support.google.com",
  "accounts.google.com",
];

export function isNonResult(url: string): boolean {
  const host = hostOf(url);
  return !host || matches(host, NON_RESULTS);
}

/**
 * Does this result read like a Receita mirror, whatever its domain?
 *
 * The host blocklist above is necessary and permanently incomplete. The sector
 * has a very long tail — a live run turned up `cadastroempresa.com.br`, which
 * nobody had heard of, and it sailed through the name gate with a perfect match
 * because its page is literally the company's Receita record.
 *
 * So domains are not the only test. These pages give themselves away by their
 * prose: they print a formatted CNPJ and talk about registration status, legal
 * nature, share capital — vocabulary a business writing about itself does not
 * use. A real bakery's page says what it sells.
 *
 * Two signals are required rather than one, because a legitimate site may well
 * print its own CNPJ in a footer that lands in the snippet. One registry phrase
 * beside a CNPJ is a mirror; a CNPJ on its own is just a Brazilian company being
 * a Brazilian company.
 */
const REGISTRY_PHRASES =
  /(situação cadastral|situacao cadastral|dados cadastrais|quadro societário|quadro societario|natureza jurídica|natureza juridica|capital social|razão social|razao social|é uma empresa de cnpj|e uma empresa de cnpj|consulta de cnpj|consultar cnpj|inscrição estadual|inscricao estadual|atividade econômica principal|atividade economica principal|data de abertura|cnae fiscal)/gi;

/** A CNPJ in either shape: 00.000.000/0000-00 or fourteen bare digits. */
const CNPJ_SHAPE = /(\d{2}\.\d{3}\.\d{3}(\/\d{4}-\d{2})?|\b\d{14}\b)/;

export function looksLikeRegistryMirror(hit: { title: string; description: string }): boolean {
  const text = `${hit.title} ${hit.description}`;
  const phrases = new Set((text.match(REGISTRY_PHRASES) ?? []).map((m) => m.toLowerCase()));
  if (phrases.size >= 2) return true;
  return phrases.size >= 1 && CNPJ_SHAPE.test(text);
}
