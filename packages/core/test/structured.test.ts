import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractJsonLd,
  extractMetaDescription,
  structuredText,
} from "../src/domain/structured";
import { runProbes } from "../src/domain/probes";

// --------------------------------------------------------------- meta tags

test("extractMetaDescription reads the description tag", () => {
  const html = `<html><head>
    <meta name="viewport" content="width=device-width">
    <meta name="description" content="Cursinho preparatório para concursos públicos em Manaus.">
    </head><body></body></html>`;
  assert.equal(
    extractMetaDescription(html),
    "Cursinho preparatório para concursos públicos em Manaus."
  );
});

test("extractMetaDescription falls back to og: then twitter:", () => {
  const og = `<meta property="og:description" content="Aulas particulares de matemática.">`;
  assert.equal(extractMetaDescription(og), "Aulas particulares de matemática.");

  const tw = `<meta name="twitter:description" content="Reforço escolar.">`;
  assert.equal(extractMetaDescription(tw), "Reforço escolar.");

  assert.equal(extractMetaDescription("<html><head></head></html>"), null);
});

// Attribute order is not fixed in the wild, and a `content` that comes first
// used to be missed entirely.
test("extractMetaDescription handles content before name", () => {
  const html = `<meta content="Preparatório militar." name="description">`;
  assert.equal(extractMetaDescription(html), "Preparatório militar.");
});

test("extractMetaDescription decodes the entities a real page carries", () => {
  const html = `<meta name="description" content="Refor&#231;o &amp; prepara&ccedil;&atilde;o &quot;top&quot;">`;
  const out = extractMetaDescription(html) ?? "";
  assert.match(out, /Refor√ßo|Reforço/);
  assert.match(out, /&/);
  assert.doesNotMatch(out, /&amp;/);
  assert.match(out, /"top"/);
});

test("an empty description tag is null, not an empty string", () => {
  assert.equal(extractMetaDescription(`<meta name="description" content="">`), null);
  assert.equal(extractMetaDescription(`<meta name="description" content="   ">`), null);
});

// ----------------------------------------------------------------- JSON-LD

const ldBlock = (payload: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(payload)}</script>`;

test("extractJsonLd pulls a LocalBusiness out of the page", () => {
  const html = `<html><head>${ldBlock({
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: "Cursinho do Zé",
    description: "Preparatório para ENEM e concursos.",
    telephone: "+5511998887777",
    url: "https://cursinhodoze.com.br",
    address: {
      "@type": "PostalAddress",
      streetAddress: "Rua das Flores, 10",
      addressLocality: "Manaus",
      addressRegion: "AM",
    },
    sameAs: ["https://instagram.com/cursinhodoze"],
  })}</head></html>`;

  const facts = extractJsonLd(html);
  assert.ok(facts);
  assert.equal(facts.type, "LocalBusiness");
  assert.equal(facts.name, "Cursinho do Zé");
  assert.equal(facts.description, "Preparatório para ENEM e concursos.");
  assert.equal(facts.telephone, "+5511998887777");
  assert.equal(facts.address, "Rua das Flores, 10, Manaus, AM");
  assert.equal(facts.sameAs.length, 1);
});

test("extractJsonLd walks an @graph wrapper", () => {
  const html = ldBlock({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", name: "site" },
      { "@type": "ProfessionalService", name: "Aulas da Ana", description: "Reforço escolar." },
    ],
  });
  const facts = extractJsonLd(html);
  assert.equal(facts?.name, "Aulas da Ana");
  assert.equal(facts?.type, "ProfessionalService");
});

test("extractJsonLd handles a bare array payload", () => {
  const html = ldBlock([
    { "@type": "BreadcrumbList" },
    { "@type": "Organization", name: "Escola X" },
  ]);
  assert.equal(extractJsonLd(html)?.name, "Escola X");
});

// The business node is what matters, and generators routinely put WebSite and
// BreadcrumbList ahead of it. Taking the first node would return neither.
test("extractJsonLd prefers a business node over whatever came first", () => {
  const html =
    ldBlock({ "@type": "BreadcrumbList", name: "migalhas" }) +
    ldBlock({ "@type": "WebSite", name: "o site" }) +
    ldBlock({ "@type": "School", name: "Colégio Real", description: "Ensino médio." });
  const facts = extractJsonLd(html);
  assert.equal(facts?.name, "Colégio Real");
  assert.equal(facts?.type, "School");
});

test("@type as an array still resolves", () => {
  const html = ldBlock({ "@type": ["LocalBusiness", "Store"], name: "Loja" });
  assert.equal(extractJsonLd(html)?.type, "LocalBusiness");
});

// A template that interpolates an unescaped quote produces a block no parser
// accepts. That must skip the block, not lose the page.
test("malformed JSON-LD returns null instead of throwing", () => {
  const html = `<script type="application/ld+json">{"@type": "LocalBusiness", name: oops}</script>`;
  assert.equal(extractJsonLd(html), null);
});

test("one malformed block does not hide a good one", () => {
  const html =
    `<script type="application/ld+json">{broken</script>` +
    ldBlock({ "@type": "Organization", name: "Boa" });
  assert.equal(extractJsonLd(html)?.name, "Boa");
});

test("no JSON-LD at all is null", () => {
  assert.equal(extractJsonLd("<html><body><p>oi</p></body></html>"), null);
});

// A node with a type we do not care about and no usable text is not a finding.
test("a structurally valid but empty node is null", () => {
  assert.equal(extractJsonLd(ldBlock({ "@type": "WebPage" })), null);
});

test("a string address is kept as-is", () => {
  const html = ldBlock({ "@type": "LocalBusiness", name: "X", address: "Av. Brasil, 100" });
  assert.equal(extractJsonLd(html)?.address, "Av. Brasil, 100");
});

test("sameAs is capped and keeps only http(s) entries", () => {
  const html = ldBlock({
    "@type": "Organization",
    name: "X",
    sameAs: ["https://a.com", "not-a-url", "https://b.com", "https://a.com"],
  });
  const same = extractJsonLd(html)?.sameAs ?? [];
  assert.deepEqual(same, ["https://a.com", "https://b.com"]);
});

// ------------------------------------------------------------ combined text

test("structuredText joins meta and JSON-LD, and dedupes a repeated sentence", () => {
  const facts = extractJsonLd(
    ldBlock({
      "@type": "LocalBusiness",
      name: "Cursinho X",
      description: "Preparatório militar.",
    })
  );
  assert.equal(
    structuredText(facts, "Preparatório militar."),
    "Preparatório militar. — Cursinho X"
  );
});

test("structuredText is null when there is nothing declared", () => {
  assert.equal(structuredText(null, null), null);
});

// The address and phone are facts, not vocabulary. A probe for "são paulo"
// matching "Rua São Paulo" would be a false positive dressed as a signal.
test("structuredText excludes the address and phone", () => {
  const facts = extractJsonLd(
    ldBlock({
      "@type": "LocalBusiness",
      name: "Escola",
      telephone: "+5511999998888",
      address: "Rua São Paulo, 1",
    })
  );
  const out = structuredText(facts, null) ?? "";
  assert.equal(out, "Escola");
  assert.doesNotMatch(out, /São Paulo/);
  assert.doesNotMatch(out, /9999/);
});

// The whole point of Part A: vocabulary that exists only in declared metadata
// is now findable, where before it was stripped with the <script> block.
test("a probe term present only in the declared text now matches", () => {
  const probes = [
    { key: "enem", label: "ENEM", terms: ["enem"], meaning: "positive" as const, weight: 1 },
  ];
  const facts = extractJsonLd(
    ldBlock({ "@type": "School", name: "Colégio", description: "Turmas para o ENEM." })
  );
  const declared = structuredText(facts, null);

  assert.deepEqual(runProbes(probes, "menu contato"), { enem: false });
  assert.deepEqual(runProbes(probes, `menu contato ${declared}`), { enem: true });
});
