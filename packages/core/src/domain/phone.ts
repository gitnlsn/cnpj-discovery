import { parsePhoneNumber, type CountryCode } from "libphonenumber-js/max";

/**
 * Receita Federal stores phone numbers in the pre-2016 eight-digit format,
 * from before Brazil's "nono dígito" migration. libphonenumber correctly
 * rejects an 8-digit Brazilian mobile as invalid, so those numbers would all
 * be misread as landlines — in practice that is ~70% of the usable leads.
 *
 * In the 8-digit era the subscriber number told you the line type:
 *   starts with 6, 7, 8, 9  -> mobile   (modern form: prepend "9")
 *   starts with 2, 3, 4, 5  -> landline (unchanged)
 *
 * So an 8-digit number beginning 6-9 is upgraded to its 9-digit equivalent
 * before validation. Numbers already 9 digits are left alone.
 */
export function normalizeBrazilianLocal(local: string): string {
  const d = local.replace(/\D/g, "");
  if (d.length === 8 && /^[6-9]/.test(d)) return `9${d}`;
  return d;
}

/** Valid Brazilian area codes. Anything else is a data-entry error. */
const VALID_DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

/**
 * Builds an E.164 number from Receita's separate DDD and telefone columns,
 * repairing the legacy 8-digit mobile format on the way.
 */
export function classifyReceitaPhone(
  ddd: string,
  telefone: string
): { e164: string; isMobile: boolean } | null {
  const areaCode = ddd.replace(/\D/g, "");
  const local = normalizeBrazilianLocal(telefone);

  if (!areaCode || !VALID_DDD.has(Number(areaCode))) return null;
  if (local.length !== 8 && local.length !== 9) return null;

  return classifyPhone(`+55${areaCode}${local}`, "BR");
}

export function classifyPhone(
  rawNumber: string,
  defaultCountry?: string
): { e164: string; isMobile: boolean } | null {
  try {
    const parsed = parsePhoneNumber(rawNumber, defaultCountry as CountryCode | undefined);
    if (!parsed || !parsed.isValid()) return null;

    const type = parsed.getType();
    const isMobile = type === "MOBILE" || type === "FIXED_LINE_OR_MOBILE";

    return { e164: parsed.format("E.164"), isMobile };
  } catch {
    return null;
  }
}

export function buildWaMeLink(e164: string): string {
  const digits = e164.replace("+", "");
  return `https://wa.me/${digits}`;
}
