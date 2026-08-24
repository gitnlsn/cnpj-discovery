import { unaccent } from "./probes";

/**
 * A Google address, split into the columns the Receita stores.
 *
 * This exists to bridge two spellings of the same street. Google returns
 * "R. Castro Alves, 1141 - Centro, São Caetano do Sul - SP, 09580-000"; the
 * Receita stores tipo "RUA", logradouro "CASTRO ALVES", numero "1141", bairro
 * "CENTRO", uf "SP" in separate columns, unaccented and upper case. Comparing the
 * raw strings would miss essentially every match, which is what makes the
 * address-to-CNPJ lookup possible or not.
 *
 * Originally written against Google Maps card text. It survived the switch to the
 * Places API because the problem it solves is the same one — a formatted address
 * on one side, columns on the other — and the API's `formattedAddress` is simply a
 * fuller version of what the card showed.
 */

/**
 * Street-type abbreviations, as Google writes them on the left and the Receita
 * writes them on the right.
 */
const STREET_TYPES = new Map<string, string>([
  ["r", "RUA"],
  ["rua", "RUA"],
  ["av", "AVENIDA"],
  ["avenida", "AVENIDA"],
  ["al", "ALAMEDA"],
  ["alameda", "ALAMEDA"],
  ["tv", "TRAVESSA"],
  ["trav", "TRAVESSA"],
  ["travessa", "TRAVESSA"],
  ["pc", "PRACA"],
  ["praca", "PRACA"],
  ["rod", "RODOVIA"],
  ["rodovia", "RODOVIA"],
  ["estr", "ESTRADA"],
  ["estrada", "ESTRADA"],
  ["lgo", "LARGO"],
  ["largo", "LARGO"],
  ["vl", "VILA"],
  ["vila", "VILA"],
  ["jd", "JARDIM"],
  ["jardim", "JARDIM"],
  ["mar", "MARGINAL"],
  ["via", "VIA"],
]);

export interface ParsedStreet {
  /** The Receita's `tipo_logradouro` form, or null when Google omitted it. */
  tipo: string | null;
  /** The street name, unaccented upper case, without the type. */
  logradouro: string;
  /** The number as written, or null — Google often omits it. */
  numero: string | null;
}

export interface ParsedPlaceAddress extends ParsedStreet {
  bairro: string | null;
  municipio: string | null;
  /** Two-letter UF. The lookup needs it, so it is extracted rather than inferred. */
  uf: string | null;
  /** Digits only, or null when there was no eight-digit CEP to find. */
  cep: string | null;
}

/** Receita comparison form: unaccented upper case, punctuation gone. */
const norm = (raw: string): string =>
  unaccent(raw)
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * One "street, number" fragment, in the Receita's shape.
 *
 * Returns null when nothing is left to compare, which is the honest answer for
 * the addresses that carry only a neighbourhood or only a city.
 */
export function parseStreet(raw: string | null | undefined): ParsedStreet | null {
  if (!raw) return null;

  // The number sits after the last comma: "R. São Paulo, 1890 B".
  const comma = raw.lastIndexOf(",");
  let streetPart = raw;
  let numero: string | null = null;
  if (comma > 0) {
    const tail = raw.slice(comma + 1).trim();
    // A tail has to START with digits to be a number; "Centro" is a
    // neighbourhood and must never become one.
    const m = /^(\d+[A-Za-z]?)/.exec(tail);
    if (m) {
      numero = m[1]!.toUpperCase();
      streetPart = raw.slice(0, comma);
    }
  }

  const tokens = norm(streetPart).split(" ").filter(Boolean);
  if (!tokens.length) return null;

  // Looked up against the RAW first token, because `norm` has already thrown the
  // dot away and a bare "R" is ambiguous with a street genuinely called "R".
  const rawFirst = streetPart.trim().split(/\s+/)[0] ?? "";
  const key = unaccent(rawFirst).toLowerCase().replace(/\./g, "");
  const tipo = STREET_TYPES.get(key) ?? null;
  const logradouro = (tipo ? tokens.slice(1) : tokens).join(" ");
  if (!logradouro) return null;

  return { tipo, logradouro, numero };
}

/** A Brazilian CEP, in either spelling. */
const CEP = /(\d{5})-?(\d{3})\b/;

/**
 * A full `formattedAddress` from the Places API.
 *
 * Google's Brazilian shape is
 * `"<rua>, <número> - <bairro>, <município> - <UF>, <CEP>"`, but every field after
 * the street is optional and the separators repeat, so this parses by *recognising*
 * each piece rather than by counting positions. A rural address with no
 * neighbourhood and no number still yields a município and a UF, which is what the
 * lookup needs most.
 */
export function parsePlaceAddress(raw: string | null | undefined): ParsedPlaceAddress | null {
  if (!raw) return null;

  let rest = raw;
  let cep: string | null = null;
  const cepMatch = CEP.exec(rest);
  if (cepMatch) {
    cep = `${cepMatch[1]}${cepMatch[2]}`;
    rest = rest.replace(cepMatch[0], " ");
  }

  // The UF is a two-letter token, and "- SP" is how Google writes it. Anchored to
  // a separator so a street called "Rua RS" cannot be mistaken for one.
  let uf: string | null = null;
  const ufMatch = /[-,]\s*([A-Z]{2})\b/.exec(rest);
  if (ufMatch) {
    uf = ufMatch[1]!;
    rest = rest.replace(ufMatch[0], " ");
  }

  // What is left is "<rua>, <número> - <bairro>, <município>". The street is
  // always first; the município is the last comma-separated chunk.
  const segments = rest
    .split(/\s+-\s+|,/)
    .map((s) => s.trim())
    .filter(Boolean);

  const street = parseStreet(segments[0] ?? null);
  // A street with a number spans two segments ("R. Castro Alves" + "1141"), so
  // re-join them before parsing when the second looks like a number.
  const joined =
    segments.length > 1 && /^\d+[A-Za-z]?$/.test(segments[1] ?? "")
      ? parseStreet(`${segments[0]}, ${segments[1]}`)
      : street;

  const consumed = joined?.numero ? 2 : 1;
  const tail = segments.slice(consumed);
  const municipio = tail.length ? norm(tail.at(-1)!) : null;
  const bairro = tail.length > 1 ? norm(tail[0]!) : null;

  if (!joined && !municipio && !uf) return null;

  return {
    tipo: joined?.tipo ?? null,
    logradouro: joined?.logradouro ?? "",
    numero: joined?.numero ?? null,
    bairro: bairro || null,
    municipio: municipio || null,
    uf,
    cep,
  };
}
