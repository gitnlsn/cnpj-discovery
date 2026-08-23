import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatCep,
  formatStreet,
  formatAddress,
  mapsUrl,
  titleCasePtBr,
} from "../src/domain/address";

/**
 * Every literal here is a real value shape, taken from Estabelecimentos1.zip of
 * the 2026-08 period. The percentages in the comments are measured over 47.269
 * active establishments in that file.
 */

describe("titleCasePtBr", () => {
  it("title-cases the unaccented upper case the Receita writes", () => {
    assert.equal(titleCasePtBr("MENINO MARCELO"), "Menino Marcelo");
  });

  it("keeps connectives lower case, but not other short words", () => {
    assert.equal(titleCasePtBr("AVENIDA DOS ESTADOS UNIDOS"), "Avenida dos Estados Unidos");
    assert.equal(titleCasePtBr("RUA DA PAZ"), "Rua da Paz");
  });

  it("never lower-cases the first word, even a connective", () => {
    assert.equal(titleCasePtBr("DOS LAGOS"), "Dos Lagos");
  });

  it("keeps highway markers upper case when a number follows", () => {
    // 2,3% of active establishments. "Rodovia Br 282 Km 345" means nothing.
    assert.equal(titleCasePtBr("RODOVIA BR 282 KM 345"), "Rodovia BR 282 KM 345");
    assert.equal(titleCasePtBr("RODOVIA SP 270"), "Rodovia SP 270");
  });

  it("does not treat a state code as a highway when no number follows", () => {
    assert.equal(titleCasePtBr("RUA SAO PAULO"), "Rua Sao Paulo");
    assert.equal(titleCasePtBr("AVENIDA CEARA"), "Avenida Ceara");
  });

  it("keeps Roman numerals upper case", () => {
    // 0,7% of street names. "Avenida Xv de Novembro" is the alternative.
    assert.equal(titleCasePtBr("AVENIDA XV DE NOVEMBRO"), "Avenida XV de Novembro");
    assert.equal(titleCasePtBr("AVENIDA DOM PEDRO II"), "Avenida Dom Pedro II");
  });

  it("title-cases a bracketed word instead of shouting it", () => {
    // 3,3% of rows (436k) bracket a qualifier: "CARDOSO (BARREIRO)".
    assert.equal(titleCasePtBr("CARDOSO (BARREIRO)"), "Cardoso (Barreiro)");
    assert.equal(
      titleCasePtBr("CHACARA SANTO ANTONIO (ZONA SUL)"),
      "Chacara Santo Antonio (Zona Sul)"
    );
  });

  it("leaves a token that is not purely alphabetic exactly as it came", () => {
    // 3% of numbers are alphanumeric; "8551B" must not become "8551b".
    assert.equal(titleCasePtBr("LOTE 2 QUADRA F"), "Lote 2 Quadra F");
    assert.equal(titleCasePtBr("KM 12"), "KM 12");
  });
});

describe("formatCep", () => {
  it("hyphenates eight digits", () => {
    assert.equal(formatCep("89136000"), "89136-000");
  });

  it("refuses anything that is not eight digits", () => {
    // 3,2% of active rows. A half-formatted CEP in a maps query is worse than none.
    assert.equal(formatCep("8913600"), null);
    assert.equal(formatCep(""), null);
    assert.equal(formatCep(null), null);
    assert.equal(formatCep("0"), null);
  });

  it("accepts a CEP that already carries its punctuation", () => {
    assert.equal(formatCep("89136-000"), "89136-000");
  });
});

describe("formatStreet", () => {
  it("joins type, name and number", () => {
    assert.equal(
      formatStreet({ tipoLogradouro: "RUA", logradouro: "TUCANEIRA", numero: "30" }),
      "Rua Tucaneira, 30"
    );
  });

  it("keeps an alphanumeric number upper case", () => {
    assert.equal(
      formatStreet({
        tipoLogradouro: "AVENIDA",
        logradouro: "MENINO MARCELO",
        numero: "8551B",
      }),
      "Avenida Menino Marcelo, 8551B"
    );
  });

  it("collapses the space runs the fixed-width source leaves in complemento", () => {
    // 15,6% of non-empty complementos carry a run of spaces.
    assert.equal(
      formatStreet({
        tipoLogradouro: "AVENIDA",
        logradouro: "MENINO MARCELO",
        numero: "8551B",
        complemento: "LOTE  2                   QUADRAF",
      }),
      "Avenida Menino Marcelo, 8551B — Lote 2 Quadraf"
    );
  });

  it("spells out an explicitly numberless address", () => {
    // 14,6% of active rows. "no number recorded" and "there is no number" are
    // different facts and only the second is safe to give a courier.
    assert.equal(
      formatStreet({ tipoLogradouro: "RODOVIA", logradouro: "BR 101", numero: "S/N" }),
      "Rodovia BR 101, s/n"
    );
    assert.equal(
      formatStreet({ tipoLogradouro: "RUA", logradouro: "DAS FLORES", numero: "SN" }),
      "Rua das Flores, s/n"
    );
  });

  it("does not repeat a type the name already carries", () => {
    // 1,28% of active rows — 169k of them — store tipo "RUA" alongside a
    // logradouro that already begins with "RUA".
    assert.equal(
      formatStreet({ tipoLogradouro: "RUA", logradouro: "RUA GAIVOTA", numero: "1359" }),
      "Rua Gaivota, 1359"
    );
    assert.equal(
      formatStreet({
        tipoLogradouro: "FAZENDA",
        logradouro: "FAZENDA SAO JOAO",
        numero: "S/N",
      }),
      "Fazenda Sao Joao, s/n"
    );
  });

  it("still prepends when the name merely starts with the same letters", () => {
    assert.equal(
      formatStreet({ tipoLogradouro: "RUA", logradouro: "RUAZINHA DO SOL", numero: "10" }),
      "Rua Ruazinha do Sol, 10"
    );
  });

  it("works without a tipo_logradouro", () => {
    // 6% of active rows have the column empty.
    assert.equal(formatStreet({ logradouro: "QUADRA 12", numero: "5" }), "Quadra 12, 5");
  });

  it("is null when there is no street at all", () => {
    assert.equal(formatStreet({ numero: "30", bairro: "CENTRO" }), null);
    assert.equal(formatStreet({}), null);
  });
});

describe("formatAddress", () => {
  it("writes the whole address the way Google expects it", () => {
    assert.equal(
      formatAddress({
        tipoLogradouro: "RUA",
        logradouro: "TUCANEIRA",
        numero: "30",
        bairro: "DOS LAGOS",
        municipio: "JARAGUA DO SUL",
        uf: "SC",
        cep: "89136000",
      }),
      "Rua Tucaneira, 30 - Dos Lagos, Jaragua do Sul - SC, 89136-000"
    );
  });

  it("drops missing parts instead of rendering empty separators", () => {
    assert.equal(
      formatAddress({ tipoLogradouro: "RUA", logradouro: "TUCANEIRA", numero: "30", uf: "SC" }),
      "Rua Tucaneira, 30, SC"
    );
  });

  it("still gives the locality when the street is missing", () => {
    assert.equal(
      formatAddress({ municipio: "SAO PAULO", uf: "SP", cep: "01310100" }),
      "Sao Paulo - SP, 01310-100"
    );
  });

  it("is null when nothing at all is known", () => {
    assert.equal(formatAddress({}), null);
    assert.equal(formatAddress({ cep: "0" }), null);
  });
});

describe("mapsUrl", () => {
  it("builds a search, not a pin", () => {
    const url = mapsUrl({
      tipoLogradouro: "RUA",
      logradouro: "TUCANEIRA",
      numero: "30",
      municipio: "JARAGUA DO SUL",
      uf: "SC",
    });
    assert.ok(url?.startsWith("https://www.google.com/maps/search/?api=1&query="));
    assert.ok(url?.includes(encodeURIComponent("Rua Tucaneira, 30")));
  });

  it("is null when there is no address to search for", () => {
    assert.equal(mapsUrl({}), null);
  });
});
