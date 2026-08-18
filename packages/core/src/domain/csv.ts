/**
 * CSV formatting. Pure string work, no filesystem.
 *
 * Lives in the domain so the export route and anything else that needs a CSV
 * share one implementation. The previous project carried two byte-for-byte
 * copies of this because importing it would have dragged the database pool
 * across an app boundary.
 */

export function escapeCsvField(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

export function formatCsv(header: string[], rows: (string | null)[][]): string {
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(row.map((v) => escapeCsvField(v ?? "")).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Shared cell coercion: null becomes empty, booleans become sim/nao. */
export function csvBody(header: string[], rows: Record<string, unknown>[]): (string | null)[][] {
  return rows.map((r) =>
    header.map((h) => {
      const v = r[h];
      if (v === null || v === undefined) return "";
      if (typeof v === "boolean") return v ? "sim" : "nao";
      return String(v);
    })
  );
}

/**
 * The same CSV, prefixed with a UTF-8 BOM.
 *
 * Excel on a pt-BR install opens a plain UTF-8 CSV with the accents mangled and
 * — depending on the locale's list separator — every row in a single column.
 * The BOM is what makes a double-click work, which is the only way this file is
 * ever going to be opened.
 */
export function formatCsvForExcel(header: string[], rows: (string | null)[][]): string {
  return `\uFEFF${formatCsv(header, rows)}`;
}
