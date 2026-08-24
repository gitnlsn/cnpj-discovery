import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseStreet, parsePlaceAddress } from "../src/domain/placeAddress";
import {
  createGooglePlaces,
  discoveryQuery,
  DISCOVERY_FIELD_MASK,
  PLACES_MAX_RESULTS,
} from "../src/adapters/googlePlaces";
import type { HttpPort } from "../src/ports/index";

describe("endereço do Google na forma da Receita", () => {
  test("rua e número, com o tipo expandido", () => {
    assert.deepEqual(parseStreet("R. Castro Alves, 1141"), {
      tipo: "RUA",
      logradouro: "CASTRO ALVES",
      numero: "1141",
    });
    assert.deepEqual(parseStreet("Av. Pres. Kennedy, 1555"), {
      tipo: "AVENIDA",
      logradouro: "PRES KENNEDY",
      numero: "1555",
    });
  });

  test("número com letra continua junto", () => {
    assert.equal(parseStreet("R. São Paulo, 1890 B")!.numero, "1890");
  });

  test("bairro depois da vírgula NÃO vira número", () => {
    // Sem esta regra "Centro" entraria como número e o casamento nunca fecharia.
    assert.deepEqual(parseStreet("R. Castro Alves, Centro"), {
      tipo: "RUA",
      logradouro: "CASTRO ALVES CENTRO",
      numero: null,
    });
  });

  test("tipo desconhecido mantém o nome inteiro", () => {
    const p = parseStreet("Shopping Ibirapuera, 3103")!;
    assert.equal(p.tipo, null);
    assert.equal(p.logradouro, "SHOPPING IBIRAPUERA");
  });

  test("o formattedAddress completo vira colunas", () => {
    // A forma que a API devolve de verdade no Brasil.
    const a = parsePlaceAddress(
      "R. Castro Alves, 1141 - Centro, São Caetano do Sul - SP, 09580-000"
    )!;
    assert.equal(a.logradouro, "CASTRO ALVES");
    assert.equal(a.numero, "1141");
    assert.equal(a.bairro, "CENTRO");
    assert.equal(a.municipio, "SAO CAETANO DO SUL");
    assert.equal(a.uf, "SP");
    assert.equal(a.cep, "09580000");
  });

  test("endereço sem bairro nem número ainda entrega município e UF", () => {
    // É o que a busca reversa mais precisa; desistir aqui perderia o lead todo.
    const a = parsePlaceAddress("Rodovia BR 116 - Curitiba - PR, 81690-000")!;
    assert.equal(a.municipio, "CURITIBA");
    assert.equal(a.uf, "PR");
    assert.equal(a.numero, null);
  });

  test("uma rua chamada 'RS' não é confundida com a UF", () => {
    const a = parsePlaceAddress("Rua RS, 200 - Centro, Porto Alegre - RS, 90000-000")!;
    assert.equal(a.uf, "RS");
    assert.equal(a.municipio, "PORTO ALEGRE");
    assert.ok(a.logradouro.includes("RS"));
  });

  test("lixo devolve null em vez de campos vazios", () => {
    assert.equal(parsePlaceAddress(null), null);
    assert.equal(parsePlaceAddress(""), null);
    assert.equal(parseStreet("R."), null);
  });
});

describe("a consulta de descoberta", () => {
  test("junta atividade e lugar em texto simples", () => {
    assert.equal(
      discoveryQuery("padaria artesanal", "São Paulo SP"),
      "padaria artesanal em São Paulo SP"
    );
    assert.equal(discoveryQuery("padaria artesanal", null), "padaria artesanal");
    assert.equal(discoveryQuery("  ", "São Paulo"), "");
  });
});

describe("busca de negócios no Places", () => {
  const page = {
    places: [
      {
        id: "PLACE1",
        websiteUri: "https://padariaalfa.com.br/",
        displayName: { text: "Padaria Alfa" },
        formattedAddress: "R. Castro Alves, 1141 - Centro, São Caetano do Sul - SP, 09580-000",
      },
      { id: "PLACE2", displayName: { text: "Padaria Beta" }, formattedAddress: "R. B, 2 - SP" },
      // Sem id: não tem como deduplicar entre rodadas, então não entra.
      { websiteUri: "https://sem-id.com.br" },
    ],
    nextPageToken: "TOKEN2",
  };

  const stub = (capture?: (init: RequestInit) => void): HttpPort => ({
    fetch: async (_url, init) => {
      capture?.(init as RequestInit);
      return new Response(JSON.stringify(page), { status: 200 });
    },
  });

  test("uma chamada devolve os negócios com site, nome e endereço", async () => {
    const places = createGooglePlaces({ apiKey: "k", http: stub() });
    const out = await places.searchBusinesses("padaria em São Paulo");
    assert.equal(out.businesses.length, 2, "a entrada sem id tem de ser descartada");
    assert.deepEqual(out.businesses[0], {
      placeId: "PLACE1",
      websiteUrl: "https://padariaalfa.com.br/",
      name: "Padaria Alfa",
      address: "R. Castro Alves, 1141 - Centro, São Caetano do Sul - SP, 09580-000",
    });
    // Um negócio sem site é resposta legítima, não falha.
    assert.equal(out.businesses[1]!.websiteUrl, null);
    assert.equal(out.nextPageToken, "TOKEN2");
  });

  test("pede a máscara de descoberta e no máximo 20", async () => {
    let init: RequestInit | undefined;
    const places = createGooglePlaces({ apiKey: "k", http: stub((i) => (init = i)) });
    await places.searchBusinesses("x", { maxResults: 99 });
    const headers = init!.headers as Record<string, string>;
    assert.equal(headers["X-Goog-FieldMask"], DISCOVERY_FIELD_MASK);
    const body = JSON.parse(String(init!.body));
    assert.equal(body.maxResultCount, PLACES_MAX_RESULTS);
    assert.equal(body.regionCode, "BR");
  });

  test("locationBias vai como círculo com coordenadas de verdade", async () => {
    // Cidade no texto é só uma dica, e no Maps ela derivou de fato: uma busca
    // por São Paulo devolveu resultados do ABC.
    let init: RequestInit | undefined;
    const places = createGooglePlaces({ apiKey: "k", http: stub((i) => (init = i)) });
    await places.searchBusinesses("x", {
      locationBias: { latitude: -23.55, longitude: -46.63, radiusMeters: 20000 },
    });
    const body = JSON.parse(String(init!.body));
    assert.deepEqual(body.locationBias, {
      circle: { center: { latitude: -23.55, longitude: -46.63 }, radius: 20000 },
    });
  });

  test("conta a chamada mesmo quando não veio nada, porque foi cobrada", async () => {
    let before = 0;
    let after = 0;
    const empty: HttpPort = {
      fetch: async () => new Response(JSON.stringify({ places: [] }), { status: 200 }),
    };
    const places = createGooglePlaces({
      apiKey: "k",
      http: empty,
      beforeRequest: () => void before++,
      afterRequest: () => void after++,
    });
    const out = await places.searchBusinesses("nada");
    assert.deepEqual(out, { businesses: [], nextPageToken: null });
    assert.equal(before, 1);
    assert.equal(after, 1);
  });

  test("o teto do orçamento para a chamada antes de gastar", async () => {
    const places = createGooglePlaces({
      apiKey: "k",
      http: { fetch: async () => new Response("{}", { status: 200 }) },
      beforeRequest: () => {
        throw new Error("cota esgotada");
      },
    });
    await assert.rejects(() => places.searchBusinesses("x"), /cota esgotada/);
  });
});
