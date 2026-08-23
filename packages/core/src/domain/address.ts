/**
 * The postal address, as the Receita stores it and as a human reads it.
 *
 * The Receita splits the street across four columns and writes all of them in
 * unaccented upper case — `RUA` / `MENINO MARCELO` / `8551B` / `LOTE  2
 * QUADRAF`. That is fine to store and unreadable to show, so the raw columns
 * are kept verbatim and every reshaping happens here, at read time. Same
 * reasoning as `phone.ts`: the file is the record, the formatting is a view of
 * it, and mixing the two means a display decision can never be revised without
 * a re-sync.
 */

/** The four street columns plus the locality ones, all optional. */
export interface RawAddress {
  tipoLogradouro?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  municipio?: string | null;
  uf?: string | null;
  cep?: string | null;
}

/**
 * Words that stay lower case inside a Brazilian street name.
 *
 * Kept to connectives only. Anything longer is a real word and title-casing it
 * is right: "AVENIDA DOS ESTADOS UNIDOS" must come back as "Avenida dos Estados
 * Unidos", not "Avenida Dos Estados Unidos".
 */
const PARTICLES = new Set(["de", "da", "do", "das", "dos", "e", "em", "a", "o", "à"]);

/**
 * Highway markers: `BR`, `KM`, and the two-letter state codes that name a state
 * road. 2,3% of active establishments sit on one — "RODOVIA BR 282 KM 345" is
 * an ordinary address here — and title-casing turns it into the meaningless
 * "Rodovia Br 282 Km 345".
 *
 * Only counted when a number follows, which is what makes it a highway. Without
 * that guard "RUA SÃO PAULO" would keep an upper-case "SP" that was never a
 * state code, and the cure would be worse than the disease.
 */
const HIGHWAY_MARKERS = new Set([
  "BR",
  "KM",
  ...["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG"],
  ...["PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"],
]);

/**
 * A Roman numeral, which 0,7% of street names end in — "Avenida XV de
 * Novembro", "Avenida Dom Pedro II". Title-casing those gives "Xv" and "Ii".
 */
const ROMAN = /^(?=[IVXLCDM]{2,}$)M*(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

/**
 * Upper case to title case, for text that is upper case only because the source
 * file is.
 *
 * A token whose *core* is not alphabetic is left exactly as it came: `8551B` is
 * a house number and `1242/A` is a subdivision — title-casing either produces
 * something that was never written anywhere. Surrounding punctuation is not
 * part of that core, because 3,3% of rows (436k) put a whole word in brackets —
 * "CARDOSO (BARREIRO)" — and treating "(BARREIRO)" as unalphabetic leaves a
 * shouted word in the middle of an otherwise readable address.
 */
export function titleCasePtBr(raw: string): string {
  const words = raw.split(/\s+/).filter(Boolean);
  return words
    .map((word, i) => {
      // Split off the punctuation so the decision is made about the word.
      const [, open = "", core = "", close = ""] =
        /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(word) ?? [];
      const upper = core.toUpperCase();

      // A highway marker only counts as one when a number follows it.
      if (HIGHWAY_MARKERS.has(upper) && /^\d/.test(words[i + 1] ?? "")) return word;
      if (ROMAN.test(upper)) return word;

      const lower = core.toLowerCase();
      if (!/^[a-zà-ÿ]+$/.test(lower)) return word;
      const cased =
        i > 0 && PARTICLES.has(lower) ? lower : lower[0]!.toUpperCase() + lower.slice(1);
      return `${open}${cased}${close}`;
    })
    .join(" ");
}

/** Trims and collapses the runs of spaces the fixed-width source leaves behind. */
function clean(v: string | null | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim();
}

/** "sem número" in any of the spellings the file uses. */
function isSemNumero(numero: string): boolean {
  return /^s\s*\/?\s*n\.?$/i.test(numero);
}

/**
 * `89136000` → `89136-000`.
 *
 * Returns null rather than a half-formatted string when the value is not eight
 * digits — measured at 3.2% of active establishments, and a mangled CEP in a
 * maps query is worse than no CEP at all.
 */
export function formatCep(cep: string | null | undefined): string | null {
  const digits = clean(cep).replace(/\D/g, "");
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

/**
 * The street line: "Avenida Menino Marcelo, 8551B — Lote 2 Quadra F".
 *
 * `numero` is never empty in the source and is literally `S/N` for 14.6% of
 * active establishments, so that case is spelled out rather than dropped: a
 * missing number and an explicitly numberless address are different facts, and
 * only the second one is safe to hand to a courier.
 */
export function formatStreet(a: RawAddress): string | null {
  const logradouro = clean(a.logradouro);
  if (!logradouro) return null;

  // 1,28% of rows (169k) already carry the type inside the name — tipo "RUA"
  // with logradouro "RUA ALEXANDRE ANTONELO". Prepending blindly gives "Rua Rua
  // Alexandre Antonelo", which reads as a data error to anyone who sees it.
  const tipo = clean(a.tipoLogradouro);
  const repeats = tipo !== "" && logradouro.toUpperCase().startsWith(`${tipo.toUpperCase()} `);
  let line = titleCasePtBr(tipo && !repeats ? `${tipo} ${logradouro}` : logradouro);

  const numero = clean(a.numero);
  if (numero) line += isSemNumero(numero) ? ", s/n" : `, ${numero.toUpperCase()}`;

  const complemento = clean(a.complemento);
  if (complemento) line += ` — ${titleCasePtBr(complemento)}`;

  return line;
}

/**
 * The whole address on one line, in the order Google expects:
 *
 *   "Rua Tucaneira, 30 - Dos Lagos, Jaraguá do Sul - SC, 89136-000"
 *
 * That exact shape matters — it is what goes into a Maps query and, later, into
 * a Places text search, which is the only free way to find a website for a
 * company that never registered an own-domain e-mail. Any part that is missing
 * is left out entirely rather than rendered as an empty separator.
 */
export function formatAddress(a: RawAddress): string | null {
  const street = formatStreet(a);
  const bairro = clean(a.bairro);
  const municipio = clean(a.municipio);
  const uf = clean(a.uf).toUpperCase();
  const cep = formatCep(a.cep);

  // "street - bairro", then "município - UF", then CEP: three groups joined by
  // commas, matching the way the address is written on an envelope here.
  const head = [street, bairro ? titleCasePtBr(bairro) : null].filter(Boolean).join(" - ");
  const city = [municipio ? titleCasePtBr(municipio) : null, uf || null]
    .filter(Boolean)
    .join(" - ");

  const parts = [head || null, city || null, cep].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** The three derived forms, or null when the Receita recorded no address. */
export interface DerivedAddress {
  /** The street on its own: "Rua Tucaneira, 30". Null if only the city is known. */
  linha: string | null;
  /** The whole thing on one line, in the order Google expects. */
  completo: string;
  /** A Maps search for `completo`. */
  maps: string;
}

/**
 * Everything a reader needs from an address, computed once.
 *
 * Both the Parquet layer and the SQLite layer hold the same four raw columns and
 * both have to present the same three derived forms, so the derivation lives
 * here rather than being written out twice with a chance of drifting.
 */
export function deriveAddress(a: RawAddress): DerivedAddress | null {
  const completo = formatAddress(a);
  if (!completo) return null;
  // `mapsUrl` is non-null exactly when `formatAddress` is — it is built from it.
  return { linha: formatStreet(a), completo, maps: mapsUrl(a)! };
}

/**
 * A Google Maps link for the address.
 *
 * Search rather than a pin: the Receita's address is accurate enough to find
 * the place and not accurate enough to assert a coordinate, and a search that
 * lands slightly off is obviously a search, while a wrong pin looks like a fact.
 */
export function mapsUrl(a: RawAddress): string | null {
  const full = formatAddress(a);
  if (!full) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(full)}`;
}
