/**
 * What a hostname tells you on its own.
 *
 * These lists started inside `usecases/crawl.ts`, where they answered one
 * question: is this URL worth fetching. They moved here because a second caller
 * needs them for the opposite reason — when a web search turns up an Instagram
 * profile for a company with no website, "link in bio" stops being a shrug and
 * becomes the only digital presence there is.
 *
 * So `LINK_HUBS` is read two ways now, and both are correct: a negative signal
 * for an established company that ought to have a site of its own, and a
 * positive one for a MEI who was never going to have one.
 */

/** Hosts that mean "they have no real website, just a link in bio". */
export const LINK_HUBS = [
  "linktr.ee",
  "linktree.com",
  "beacons.ai",
  "bio.link",
  "linkbio.co",
  "lnk.bio",
  "campsite.bio",
  "linkme.bio",
  "instagram.com",
  "facebook.com",
  "fb.com",
  "m.facebook.com",
  "wa.me",
  "api.whatsapp.com",
  "chat.whatsapp.com",
  "youtube.com",
  "tiktok.com",
];

/** Free-subdomain builders — a strong "cheap or abandoned site" signal. */
export const FREE_BUILDERS = [
  ".wixsite.com",
  ".negocio.site", // Google's free BR site builder
  ".business.site", // deprecated 2024 → these are usually dead
  ".wordpress.com",
  ".blogspot.com",
  ".webnode.page",
  ".webnode.com.br",
  ".weebly.com",
  ".jimdosite.com",
  ".godaddysites.com",
  ".mystrikingly.com",
];

/** Bare hostname, lowercased, `www.` dropped. Empty string when unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Second-level suffixes that belong to a registry, so the name is one label deeper.
 *
 * Brazil puts almost every company under a two-label suffix — `com.br` — which is
 * why this list exists at all: without it `padaria.com.br` and `loja.com.br` would
 * both reduce to `com.br` and every Brazilian business would be the same lead.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  // Brasil (CGI.br). Só os que aparecem em site de empresa; a lista completa tem
  // mais de cem e a maioria nunca vai ser vista aqui.
  "com.br",
  "net.br",
  "org.br",
  "ind.br",
  "eco.br",
  "cnt.br",
  "art.br",
  "esp.br",
  "adm.br",
  "adv.br",
  "arq.br",
  "eng.br",
  "med.br",
  "odo.br",
  "vet.br",
  "psi.br",
  "srv.br",
  "tur.br",
  "agr.br",
  "emp.br",
  "blog.br",
  "nom.br",
  "coop.br",
  "gov.br",
  "edu.br",
  "jus.br",
  "mil.br",
  "leg.br",
  "mp.br",
  // Vizinhos e alguns estrangeiros que aparecem em resultado brasileiro.
  "com.ar",
  "com.pt",
  "com.mx",
  "com.uy",
  "com.py",
  "com.co",
  "co.uk",
]);

export const isHub = (host: string) =>
  LINK_HUBS.some((h) => host === h || host.endsWith(`.${h}`));

export const isBuilder = (host: string) => FREE_BUILDERS.some((s) => host.endsWith(s));

/**
 * The registrable domain — who a site belongs to, rather than which machine it is.
 *
 * `hostOf` answers the second question, and that is not enough to identify a
 * business: `blog.padaria.com.br` and `padaria.com.br` are one company, and
 * counting them twice means one lead shows up as two.
 *
 * Hand-rolled rather than a public-suffix dependency, and the honest way to read
 * that decision is as a judgement about which errors are affordable here:
 *
 * - **False merge** — two businesses collapse into one key, so one lead is
 *   silently dropped. Happens for any multi-label suffix missing from the set
 *   above: `*.github.io`, `*.vercel.app`, `*.netlify.app`, `*.pages.dev`, and
 *   every foreign ccTLD second level not listed. Partly headed off by the
 *   `isBuilder` check, which is what stops every free-builder site in
 *   Brazil from merging into `wixsite.com`.
 * - **False split** — one business becomes two keys and shows up twice. Happens
 *   for a suffix wrongly in the set, or a company genuinely running
 *   `loja.x.com.br` next to `x.com.br` as separate brands.
 *
 * A false split costs one wasted crawl; a false merge costs one missed lead.
 * Both are visible in the tab and neither touches the Receita side, which is why
 * a list that is knowingly incomplete is the right trade here — and would not be
 * for anything security-shaped. Top it up from what real runs surface, the same
 * way `AGGREGATORS` is maintained.
 */
export function apexOf(url: string): string {
  const host = hostOf(url);
  if (!host) return "";

  // An IP address is its own apex: there is no registry level to climb to.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;

  // On a free builder the SUBDOMAIN is the identity — `alfa.wixsite.com` is one
  // business and `beta.wixsite.com` is another. Reusing `FREE_BUILDERS` rather
  // than restating those hosts keeps one answer to "what does this host mean".
  if (isBuilder(host)) return host;

  const parts = host.split(".");
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join(".");
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

/**
 * Paths on a social host that are content, not somebody's profile.
 *
 * Measured from a live run, which is the only reason this list is right: of seven
 * hits stored as "social presence", five were an Instagram post, a reel, a
 * Facebook *group* post and a YouTube video. A post that mentions a name is not
 * that person's profile — the name matched because somebody else wrote it.
 *
 * This is the same mistake `isLinkedInProfileUrl` was written to avoid, and it
 * was live on Instagram and Facebook the whole time.
 */
const NOT_A_PROFILE =
  /^\/(?:p|reel|reels|tv|stories|s|explore|watch|shorts|video|groups|events|posts|photo|photos|permalink|share|hashtag|marketplace|notes)(?:\/|$)/i;

/**
 * Is this social URL a profile rather than a piece of content?
 *
 * A profile is the handle at the root of the host — `instagram.com/padariadoze`,
 * `facebook.com/artepaocdm`. Deep paths are posts, and a `wa.me/5511…` link is a
 * phone number, which is always about its owner.
 */
export function isSocialProfileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const host = hostOf(parsed.href);
  // A WhatsApp link is a number, and a number belongs to one person.
  if (/^(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)$/.test(host)) return true;

  const path = parsed.pathname.replace(/\/+$/, "");
  if (!path || path === "/") return false;
  if (NOT_A_PROFILE.test(path)) return false;

  // Facebook's numeric profile form.
  if (path === "/profile.php" && parsed.searchParams.has("id")) return true;

  const segments = path.split("/").filter(Boolean);
  // A handle sits at the root. YouTube spells channels one level deeper.
  if (segments.length === 1) return true;
  return segments.length === 2 && /^(c|channel|user|@[\w.-]+)$/i.test(segments[0] ?? "");
}
