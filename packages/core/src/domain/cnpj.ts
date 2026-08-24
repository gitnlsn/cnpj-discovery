/**
 * Reading a CNPJ out of text somebody else wrote.
 *
 * This exists for one job: the open-internet sweep turns up registry-mirror pages
 * — `cnpj.biz`, `casadosdados.com.br` and the forty others in `AGGREGATORS` — and
 * those pages print the CNPJ in the snippet. For the presence search a mirror is
 * noise, our own data reflected back. For discovery it is the opposite: a mirror
 * page about a business is evidence the business IS in the Receita base, with the
 * number handed over, and no scan needed to find it.
 *
 * The danger is the same one that makes the rest of this project careful. A
 * fourteen-digit run in a snippet is not a CNPJ — it can be a phone number and a
 * CEP that happen to sit next to each other, or a protocol number. Attributing a
 * wrong CNPJ to a site is worse than attributing none: it files a real company's
 * registry row under somebody else's website, and it does it silently.
 *
 * So nothing here guesses. A candidate has to survive the check digits, and the
 * caller still has to confirm the name matches before the link is believed.
 */

/**
 * A COMPLETE CNPJ, in either spelling. Fourteen digits or nothing.
 *
 * Deliberately not the shape `searchNoise.ts` uses to detect a mirror page: that
 * one accepts the eight-digit root with the branch optional, because for
 * *recognising a registry page* a partial number is plenty of signal. Here the
 * number is going to be used as a key, and a root without its branch identifies a
 * company but not an establishment — several rows share it. Matching it would
 * hand back an ambiguous key that looks exact.
 */
const CNPJ_FULL = /\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})\b/g;

/** Digits only, so the two spellings compare equal. */
export const cnpjDigits = (raw: string): string => raw.replace(/\D/g, "");

/**
 * The two check digits (módulo 11), which is what separates a CNPJ from any
 * other fourteen-digit number.
 *
 * There was no validator anywhere in this project before this — every CNPJ it
 * handled came from the Receita's own files, where it is correct by
 * construction. The moment a number arrives from a web page that stops being
 * true.
 *
 * Measured, because the size of the gap matters: all 2.000 CNPJs sampled from the
 * base pass, flipping one digit fails all 500 tried, and **0,975% of random
 * fourteen-digit runs still pass** — about one in a hundred. So this is a filter,
 * not a proof. It throws out the phone-number-beside-a-CEP coincidences, and it is
 * why the caller must still confirm the company's name before believing the link:
 * check digits alone would attribute a wrong CNPJ once every hundred tries.
 */
export function isCnpjValid(raw: string): boolean {
  const d = cnpjDigits(raw);
  if (d.length !== 14) return false;
  // A repeated digit passes the arithmetic and is never a real registration.
  if (/^(\d)\1{13}$/.test(d)) return false;

  const digit = (upTo: number): number => {
    // Weights run 2..9 from the right, restarting at 2 — the standard schedule.
    let sum = 0;
    let weight = 2;
    for (let i = upTo - 1; i >= 0; i--) {
      sum += Number(d[i]) * weight;
      weight = weight === 9 ? 2 : weight + 1;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  return digit(12) === Number(d[12]) && digit(13) === Number(d[13]);
}

/**
 * Every valid, complete CNPJ in a search result, deduplicated.
 *
 * Returns digits, not the formatted spelling, because that is the shape the
 * Parquet stores and the shape a lookup needs. An empty array is the common
 * answer and means only that: no number we can trust appeared in this text.
 */
export function cnpjsFromHit(hit: {
  title?: string | null;
  description?: string | null;
}): string[] {
  const text = `${hit.title ?? ""} ${hit.description ?? ""}`;
  const found = new Set<string>();
  for (const match of text.matchAll(CNPJ_FULL)) {
    const digits = cnpjDigits(match[0]);
    if (isCnpjValid(digits)) found.add(digits);
  }
  return [...found];
}
