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

export const isHub = (host: string) =>
  LINK_HUBS.some((h) => host === h || host.endsWith(`.${h}`));

export const isBuilder = (host: string) => FREE_BUILDERS.some((s) => host.endsWith(s));

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
