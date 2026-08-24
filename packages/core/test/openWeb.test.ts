import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { apexOf, hostOf } from "../src/domain/hosts";
import { isCnpjValid, cnpjsFromHit, cnpjDigits } from "../src/domain/cnpj";
import { isNonBusinessHost } from "../src/domain/searchNoise";
import {
  buildDiscoveryQueries,
  termsFromCnaeLabel,
  classifyWebLeadVerdict,
  verifyMirrorLink,
  apexLabel,
} from "../src/domain/openWeb";
import type { ProjectSpec } from "../src/domain/spec";

describe("apexOf — a chave de identidade de um negócio na web", () => {
  test("subdomínios do mesmo negócio caem na mesma chave", () => {
    // A razão de existir: sem isto, um lead apareceria três vezes.
    assert.equal(apexOf("https://padaria.com.br/"), "padaria.com.br");
    assert.equal(apexOf("https://blog.padaria.com.br/post/1"), "padaria.com.br");
    assert.equal(apexOf("https://www.loja.padaria.com.br"), "padaria.com.br");
  });

  test("sufixos brasileiros de dois rótulos mantêm três", () => {
    for (const s of ["ind.br", "eco.br", "cnt.br", "nom.br", "adv.br", "org.br"]) {
      assert.equal(apexOf(`https://alfa.${s}/x`), `alfa.${s}`, s);
    }
  });

  test("sufixo de um rótulo mantém dois", () => {
    assert.equal(apexOf("https://alfa.com/x"), "alfa.com");
    assert.equal(apexOf("https://sub.alfa.com/x"), "alfa.com");
    // Registro direto sob .br existe e tem dois rótulos.
    assert.equal(apexOf("https://alfa.br"), "alfa.br");
  });

  test("num construtor grátis o subdomínio É o negócio", () => {
    // Sem esta regra, todo site de Wix do Brasil viraria um único lead.
    assert.equal(apexOf("https://alfa.wixsite.com/site"), "alfa.wixsite.com");
    assert.notEqual(apexOf("https://beta.wixsite.com"), apexOf("https://alfa.wixsite.com"));
    assert.equal(apexOf("https://alfa.negocio.site"), "alfa.negocio.site");
  });

  test("um IP é o próprio ápice, e o inválido devolve vazio", () => {
    assert.equal(apexOf("http://192.168.15.10/x"), "192.168.15.10");
    assert.equal(apexOf("não é url"), "");
    assert.equal(apexOf(""), "");
  });

  test("concorda com hostOf em todo host de dois rótulos", () => {
    for (const u of ["https://alfa.com", "https://alfa.com.br", "https://alfa.br"]) {
      const host = hostOf(u);
      if (host.split(".").length === 2) assert.equal(apexOf(u), host, u);
    }
  });
});

describe("CNPJ vindo de texto de terceiro", () => {
  // Um CNPJ real da base, e o mesmo com um dígito trocado.
  const real = "66771150000107";

  test("aceita o real, nas duas grafias", () => {
    assert.ok(isCnpjValid(real));
    assert.ok(isCnpjValid("66.771.150/0001-07"));
    assert.equal(cnpjDigits("66.771.150/0001-07"), real);
  });

  test("recusa dígito verificador errado e dígito repetido", () => {
    assert.ok(!isCnpjValid(real.slice(0, 13) + "8"));
    assert.ok(!isCnpjValid("11111111111111"));
    assert.ok(!isCnpjValid("00000000000000"));
  });

  test("recusa o que não tem 14 dígitos", () => {
    assert.ok(!isCnpjValid("6677115000010"));
    assert.ok(!isCnpjValid("667711500001077"));
    assert.ok(!isCnpjValid(""));
  });

  test("extrai do snippet e ignora número que não é CNPJ", () => {
    const hits = cnpjsFromHit({
      title: `PADARIA ALFA LTDA - 66.771.150/0001-07 | cnpj.biz`,
      // Telefone e CEP colados dariam 14 dígitos; o dígito verificador barra.
      description: `Telefone 11987654321, CEP 01310100. Protocolo 12345678901234.`,
    });
    assert.deepEqual(hits, [real]);
  });

  test("a raiz de 12 dígitos NÃO é extraída", () => {
    // Uma raiz identifica a empresa mas não o estabelecimento: vários
    // compartilham. Devolvê-la seria entregar chave ambígua com cara de exata.
    assert.deepEqual(cnpjsFromHit({ title: "66.771.150", description: "" }), []);
  });

  test("dois CNPJs distintos no mesmo texto vêm os dois, sem repetir", () => {
    const out = cnpjsFromHit({
      title: `${real} e 64.662.548/0001-80`,
      description: real,
    });
    assert.equal(out.length, 2);
    assert.ok(out.includes(real));
  });
});

describe("hosts que nunca são o negócio", () => {
  test("marketplace, imprensa, avaliação e portal caem fora", () => {
    for (const u of [
      "https://www.mercadolivre.com.br/anuncio",
      "https://olx.com.br/x",
      "https://g1.globo.com/materia",
      "https://pt.wikipedia.org/wiki/Padaria",
      "https://www.reclameaqui.com.br/empresa/x",
      "https://sebrae.com.br/artigo",
      "https://www.ifood.com.br/delivery/x",
    ]) {
      assert.ok(isNonBusinessHost(u), u);
    }
  });

  test("o site de uma empresa passa", () => {
    assert.ok(!isNonBusinessHost("https://padariaalfa.com.br"));
    assert.ok(!isNonBusinessHost("https://alfa.wixsite.com/site"));
  });
});

describe("planejar as consultas", () => {
  const spec = (probes: ProjectSpec["probes"]): ProjectSpec =>
    ({
      schemaVersion: 1,
      summary: "",
      buyer: "",
      problem: "",
      targeting: { cnaePrefixes: [], cnaeExclude: [], ufs: ["SP"] },
      probes,
      rubric: {
        axes: [],
        recommendations: [],
        notes: [],
        siteSignals: "full",
        hookBad: [],
        hookGood: [],
      },
      icpCoverage: [],
    }) as unknown as ProjectSpec;

  test("o roll-up de prefixo é quebrado, não pesquisado como frase", () => {
    // `describeCnae` sintetiza isto para um prefixo, e buscar a frase inteira
    // não acha nada.
    const terms = termsFromCnaeLabel("3 subclasses — Ensino médio; Cursos de idiomas; Creches");
    assert.deepEqual(terms, ["Ensino médio", "Cursos de idiomas", "Creches"]);
  });

  test("qualificador entre parênteses sai do termo", () => {
    assert.deepEqual(termsFromCnaeLabel("Cursos preparatórios (exceto pilotagem)"), [
      "Cursos preparatórios",
    ]);
  });

  test("é determinístico e respeita o teto", () => {
    const input = {
      spec: spec([]),
      cnaeLabels: ["Ensino médio", "Creches", "Cursos de idiomas"],
      places: ["São Paulo SP", "Campinas SP"],
      max: 4,
    };
    const a = buildDiscoveryQueries(input);
    const b = buildDiscoveryQueries(input);
    assert.equal(a.length, 4);
    assert.deepEqual(a, b);
  });

  test("varre termos antes de varrer cidades", () => {
    // Com orçamento de 3, três atividades na melhor cidade dizem muito mais
    // que uma atividade em três cidades.
    const out = buildDiscoveryQueries({
      spec: spec([]),
      cnaeLabels: ["Ensino médio", "Creches", "Cursos de idiomas"],
      places: ["São Paulo SP", "Campinas SP", "Santos SP"],
      max: 3,
    });
    assert.deepEqual(
      out.map((q) => q.place),
      ["São Paulo SP", "São Paulo SP", "São Paulo SP"]
    );
    assert.equal(new Set(out.map((q) => q.term)).size, 3);
  });

  test("o termo vai entre aspas e o lugar não", () => {
    const [q] = buildDiscoveryQueries({
      spec: spec([]),
      cnaeLabels: ["Ensino médio"],
      places: ["São Paulo SP"],
      max: 1,
    });
    assert.equal(q!.query, '"Ensino médio" São Paulo SP');
  });

  test("probe negativa NUNCA vira consulta", () => {
    const out = buildDiscoveryQueries({
      spec: spec([
        { key: "a", label: "", terms: ["condomínio"], meaning: "positive", weight: 1 },
        { key: "b", label: "", terms: ["franquia"], meaning: "negative", weight: 1 },
      ]),
      cnaeLabels: [],
      places: ["SP"],
      max: 10,
    });
    const terms = out.map((q) => q.term);
    assert.ok(terms.includes("condomínio"));
    assert.ok(!terms.includes("franquia"), "gastaria orçamento achando quem a rubrica reprova");
  });

  test("nationwide tira a cidade E não cai na UF", () => {
    // Cair na UF reinstalaria em silêncio justamente o recorte que o chamador
    // pediu para remover.
    const out = buildDiscoveryQueries({
      spec: spec([]),
      cnaeLabels: ["Ensino médio", "Creches"],
      places: ["São Paulo SP", "Campinas SP"],
      max: 2,
      nationwide: true,
    });
    assert.deepEqual(
      out.map((q) => q.place),
      ["", ""]
    );
    assert.deepEqual(
      out.map((q) => q.query),
      ['"Ensino médio"', '"Creches"']
    );
  });

  test("sem lugar nenhum, sobra o termo; sem termo, não há consulta", () => {
    const noPlace = buildDiscoveryQueries({
      spec: spec([]),
      cnaeLabels: ["Ensino médio"],
      places: [],
      max: 2,
    });
    // O spec ainda tem UF, então cai nela.
    assert.equal(noPlace[0]!.place, "SP");
    assert.deepEqual(
      buildDiscoveryQueries({ spec: spec([]), cnaeLabels: [], places: [], max: 5 }),
      []
    );
    assert.deepEqual(
      buildDiscoveryQueries({
        spec: spec([]),
        cnaeLabels: ["Ensino médio"],
        places: [],
        max: 0,
      }),
      []
    );
  });
});

describe("o veredito, e os três fatos que não podem colapsar", () => {
  const targeting = { cnaePrefixes: ["8599", "8520"], cnaeExclude: ["8599605"], ufs: ["SP"] };

  test("dentro do alcance é o que o projeto já achava", () => {
    const v = classifyWebLeadVerdict({ company: { cnae: "8599604", uf: "SP" }, targeting });
    assert.deepEqual(v, { verdict: "in_reach", by: null });
  });

  test("CNAE fora da mira é o prêmio, e diz que foi o CNAE", () => {
    const v = classifyWebLeadVerdict({ company: { cnae: "4711302", uf: "SP" }, targeting });
    assert.deepEqual(v, { verdict: "out_of_reach", by: "cnae" });
  });

  test("CNAE excluído pelo próprio spec também está fora", () => {
    const v = classifyWebLeadVerdict({ company: { cnae: "8599605", uf: "SP" }, targeting });
    assert.deepEqual(v, { verdict: "out_of_reach", by: "cnae" });
  });

  test("UF fora da mira diz que foi a UF", () => {
    const v = classifyWebLeadVerdict({ company: { cnae: "8599604", uf: "RJ" }, targeting });
    assert.deepEqual(v, { verdict: "out_of_reach", by: "uf" });
  });

  test("sem empresa casada é 'não achamos', e nada mais", () => {
    const v = classifyWebLeadVerdict({ company: null, targeting });
    // O gêmeo em TypeScript do CHECK do banco: veredito e CNPJ não discordam.
    assert.deepEqual(v, { verdict: "unmatched", by: null });
  });

  test("projeto que não mira nada não pode 'já alcançar' ninguém", () => {
    const v = classifyWebLeadVerdict({
      company: { cnae: "8599604", uf: "SP" },
      targeting: { cnaePrefixes: [], cnaeExclude: [], ufs: [] },
    });
    assert.equal(v.verdict, "out_of_reach");
  });
});

describe("acreditar no CNPJ que um espelho traz", () => {
  const company = { razaoSocial: "COMERCIO DE PAES ALFA LTDA", nomeFantasia: "PADARIA ALFA" };

  test("aceita quando o título do site corresponde ao nome fantasia", () => {
    assert.ok(
      verifyMirrorLink({
        siteUrl: "https://xyz.com.br",
        siteTitle: "Padaria Alfa — pães artesanais",
        company,
      })
    );
  });

  test("aceita quando o domínio soletra o nome", () => {
    assert.ok(
      verifyMirrorLink({ siteUrl: "https://padaria-alfa.com.br", siteTitle: null, company })
    );
  });

  test("aceita marca de uma palavra distintiva", () => {
    assert.ok(
      verifyMirrorLink({
        siteUrl: "https://zangari.com.br",
        siteTitle: null,
        company: { razaoSocial: "ZANGARI ADMINISTRACAO DE BENS LTDA", nomeFantasia: null },
      })
    );
  });

  test("RECUSA o CNPJ do resultado vizinho", () => {
    // A armadilha central da feature: o espelho está na mesma página de
    // resultados que o site, e nada liga os dois. Acreditar arquivaria o site
    // da padaria sob o CNPJ da autopeças ao lado — com um CNPJ válido de
    // verdade, o que faz parecer verificado.
    assert.ok(
      !verifyMirrorLink({
        siteUrl: "https://autopecasbeta.com.br",
        siteTitle: "Auto Peças Beta — freios e suspensão",
        company,
      })
    );
  });

  test("recusa palavra curta e genérica", () => {
    assert.ok(
      !verifyMirrorLink({
        siteUrl: "https://casa.com.br",
        siteTitle: null,
        company: { razaoSocial: "CASA DE CARNES BOI BOM LTDA", nomeFantasia: null },
      })
    );
  });

  test("sem nome utilizável na Receita, não acredita", () => {
    assert.ok(
      !verifyMirrorLink({
        siteUrl: "https://padaria-alfa.com.br",
        siteTitle: "Padaria Alfa",
        company: { razaoSocial: null, nomeFantasia: null },
      })
    );
  });

  test("apexLabel devolve a marca legível", () => {
    assert.equal(apexLabel("https://padaria-alfa.com.br/x"), "padaria alfa");
    assert.equal(apexLabel("https://www.zangari.com.br"), "zangari");
  });
});
