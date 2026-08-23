/**
 * What a page declares about itself, as opposed to what it renders.
 *
 * `extractText` strips every `<script>` block before stripping tags, and a
 * `<meta>` tag disappears in the same pass with its `content` attribute. That
 * is the right call for prose — a JSON blob in the middle of a probe haystack
 * is noise — but it throws away the two places a thin page keeps its
 * description: JSON-LD and the meta/OpenGraph tags.
 *
 * It matters most exactly where the page text is worst. A MEI's `.negocio.site`
 * page or a React shell renders almost nothing, and the one sentence saying
 * what the business does is in `<meta name="description">`.
 *
 * This is deliberately NOT merged into `textExcerpt`. Two things downstream
 * read that field's *length* as a measurement of how much prose was read:
 * `CONCLUSIVE_TEXT_CHARS` decides whether a probe miss is real evidence, and
 * only the first `PAGE_EXCERPT_CHARS` reach the model. Padding it with declared
 * metadata would make "read the whole page and the term never appeared" fire on
 * a page whose prose was never read.
 */

/**
 * The schema.org fields worth keeping.
 *
 * A fixed projection, not the raw parsed object: this is untrusted markup from
 * an arbitrary host, and the same argument that keeps model-authored regexes
 * out of `runProbes` applies to anything derived from page content.
 */
export interface JsonLdFacts {
  type: string | null;
  name: string | null;
  description: string | null;
  telephone: string | null;
  address: string | null;
  url: string | null;
  /** Profile links a business declares — often the Instagram a MEI actually uses. */
  sameAs: string[];
}

/** Per-field cap. Long enough for a real description, short enough to bound the row. */
const FIELD_CHARS = 600;

/** How much of the document is scanned for `<script type="application/ld+json">`. */
const SCAN_CHARS = 400_000;

/** A single JSON-LD block above this size is ignored rather than parsed. */
const MAX_BLOCK_CHARS = 100_000;

/** Cap on `sameAs`, which some generators emit with dozens of entries. */
const MAX_SAME_AS = 8;

/** The schema.org types that describe a business rather than a page or a widget. */
const USEFUL_TYPES =
  /^(Organization|LocalBusiness|ProfessionalService|Store|Restaurant|School|EducationalOrganization|Corporation|Person|HealthAndBeautyBusiness|SportsActivityLocation|EntertainmentBusiness|FinancialService|HomeAndConstructionBusiness|MedicalBusiness|LegalService|AutomotiveBusiness|FoodEstablishment|LodgingBusiness)$/i;

function clean(v: unknown): string | null {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, FIELD_CHARS) : null;
}

/**
 * Decodes the entities that survive into an attribute value.
 *
 * Only the handful a real page uses. Anything else is left as-is rather than
 * guessed at — a mangled description is still readable, an over-eager decoder
 * that turns `&lt;script&gt;` back into markup is not.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#0*(\d{2,5});/g, (_, d: string) => {
      const code = Number(d);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : " ";
    })
    .replace(/&amp;/gi, "&");
}

/**
 * The `content` of a `<meta>` tag, by name or property.
 *
 * Attribute order is not fixed in the wild — `content` before `name` is common
 * — so both orders are tried rather than assuming the tidy one.
 */
function metaContent(html: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attr = `(?:name|property)=["']${k}["']`;
  const patterns = [
    new RegExp(`<meta[^>]+${attr}[^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attr}`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    const value = clean(m?.[1] ? decodeEntities(m[1]) : null);
    if (value) return value;
  }
  return null;
}

/**
 * The page's own one-line description.
 *
 * `og:description` is the fallback rather than the primary because a CMS that
 * writes both tends to put the human sentence in `description` and a truncated
 * social variant in the OpenGraph one.
 */
export function extractMetaDescription(html: string): string | null {
  const head = html.slice(0, 200_000); // same window analyzeHtml uses for meta tags
  return (
    metaContent(head, "description") ??
    metaContent(head, "og:description") ??
    metaContent(head, "twitter:description")
  );
}

/** `@type` may be a string or an array; take the first useful one. */
function typeOf(node: Record<string, unknown>): string | null {
  const raw = node["@type"];
  const list = Array.isArray(raw) ? raw : [raw];
  for (const t of list) {
    const s = clean(t);
    if (s) return s;
  }
  return null;
}

/**
 * Flattens the shapes JSON-LD actually arrives in.
 *
 * A block is an object, an array of objects, or an object whose `@graph` holds
 * the real nodes — and generators nest all three. Depth is bounded because this
 * walks parsed input from an arbitrary host.
 */
function flatten(node: unknown, depth = 0, out: Record<string, unknown>[] = []) {
  if (depth > 6 || out.length > 200 || !node) return out;
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, depth + 1, out);
    return out;
  }
  if (typeof node !== "object") return out;

  const obj = node as Record<string, unknown>;
  out.push(obj);
  if (obj["@graph"]) flatten(obj["@graph"], depth + 1, out);
  return out;
}

/** A postal address is either a string or a nested PostalAddress object. */
function addressOf(node: Record<string, unknown>): string | null {
  const raw = node.address;
  if (!raw) return null;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first === "string") return clean(first);
  if (!first || typeof first !== "object") return null;

  const a = first as Record<string, unknown>;
  const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode]
    .map(clean)
    .filter(Boolean);
  return parts.length ? parts.join(", ").slice(0, FIELD_CHARS) : null;
}

function sameAsOf(node: Record<string, unknown>): string[] {
  const raw = node.sameAs;
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const v of list) {
    const s = clean(v);
    if (s && /^https?:\/\//i.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= MAX_SAME_AS) break;
  }
  return out;
}

/**
 * The best business node in the page's JSON-LD, or null.
 *
 * Malformed JSON is common — a template that interpolates an unescaped quote
 * produces a block no parser accepts — so every block is parsed in isolation
 * and a failure skips that block rather than losing the page.
 */
export function extractJsonLd(html: string): JsonLdFacts | null {
  const scanned = html.slice(0, SCAN_CHARS);
  const blocks = scanned.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  const nodes: Record<string, unknown>[] = [];
  for (const block of blocks) {
    const body = block[1]?.trim();
    if (!body || body.length > MAX_BLOCK_CHARS) continue;
    try {
      // Some CMSs wrap the payload in a CDATA guard.
      const stripped = body.replace(/^\/\*\s*<!\[CDATA\[\s*\*\/|\/\*\s*\]\]>\s*\*\/$/g, "");
      flatten(JSON.parse(stripped), 0, nodes);
    } catch {
      continue;
    }
    if (nodes.length > 200) break;
  }
  if (!nodes.length) return null;

  // A business node beats whatever came first: generators routinely emit
  // WebSite and BreadcrumbList ahead of the Organization that matters.
  const useful = nodes.find((n) => {
    const t = typeOf(n);
    return t && USEFUL_TYPES.test(t);
  });
  const node = useful ?? nodes.find((n) => clean(n.name) || clean(n.description));
  if (!node) return null;

  const facts: JsonLdFacts = {
    type: typeOf(node),
    name: clean(node.name) ?? clean(node.legalName),
    description: clean(node.description),
    telephone: clean(node.telephone),
    address: addressOf(node),
    url: clean(node.url),
    sameAs: sameAsOf(node),
  };

  const hasAnything =
    facts.name || facts.description || facts.telephone || facts.address || facts.sameAs.length;
  return hasAnything ? facts : null;
}

/**
 * The declared text, as one haystack for probes.
 *
 * Name and description only. An address and a phone number are facts the page
 * states, not vocabulary a probe should match — "Rua São Paulo" matching a
 * probe for "são paulo" would be a false positive, not a signal.
 */
export function structuredText(
  facts: JsonLdFacts | null,
  metaDescription: string | null
): string | null {
  const parts = [metaDescription, facts?.name, facts?.description]
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p));

  if (!parts.length) return null;

  // Deduplicated: a CMS commonly writes the same sentence into the meta tag and
  // the JSON-LD description, and a doubled sentence tells the model nothing.
  const seen = new Set<string>();
  const unique = parts.filter((p) => {
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.join(" — ").slice(0, 2000);
}
