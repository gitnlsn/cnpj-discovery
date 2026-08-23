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
