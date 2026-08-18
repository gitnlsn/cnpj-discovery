import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeCsvField, formatCsv, formatCsvForExcel, csvBody } from "../src/domain/csv";

test("fields containing the separator, quotes or newlines are quoted", () => {
  assert.equal(escapeCsvField("simples"), "simples");
  assert.equal(escapeCsvField("Silva, Souza & Cia"), '"Silva, Souza & Cia"');
  assert.equal(escapeCsvField('diz "olá"'), '"diz ""olá"""');
  assert.equal(escapeCsvField("linha1\nlinha2"), '"linha1\nlinha2"');
});

test("a hook with a comma cannot shift the columns", () => {
  // Hooks are free text written by a model and routinely contain commas; an
  // unescaped one silently moves every later column by a field.
  const csv = formatCsv(
    ["cnpj", "gancho", "status"],
    [["11222333000181", "Vi que vocês usam ClassApp, Qmágico e SAS", "flagged"]]
  );
  const line = csv.trim().split("\n")[1]!;
  assert.equal(line, '11222333000181,"Vi que vocês usam ClassApp, Qmágico e SAS",flagged');
  assert.equal(line.split('"')[2], ",flagged", "o status continua sendo o último campo");
});

test("null becomes empty, never the string 'null'", () => {
  const csv = formatCsv(["a", "b"], [["x", null]]);
  assert.equal(csv.trim().split("\n")[1], "x,");
});

test("csvBody coerces booleans to sim/nao and missing keys to empty", () => {
  const rows = csvBody(["nome", "mei", "faltando"], [{ nome: "X", mei: true }, { nome: "Y", mei: false }]);
  assert.deepEqual(rows, [["X", "sim", ""], ["Y", "nao", ""]]);
});

test("the Excel variant carries a BOM so a double-click opens it correctly", () => {
  const csv = formatCsvForExcel(["nome"], [["Colégio São João"]]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /Colégio São João/);
});
