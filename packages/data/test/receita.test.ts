import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { paths, query as rawQuery } from "../src/duck";
import {
  describeCnae,
  listCompanies,
  countReach,
  cnaeReach,
  searchCnaes,
  findByAddress,
} from "../src/receita";
import { FREE_MAIL } from "@cnpj/core/domain";
import { websiteFromEmail } from "@cnpj/core";

/**
 * These run against the real Parquet dataset, not a fixture.
 *
 * What they cover is precisely what TypeScript cannot: that the SQL is right,
 * that partition pruning does not change the answer, and that the ordering is
 * the one claimed. With no dataset built they skip rather than fail — a fresh
 * clone has no `data/parquet` and should still be able to run `pnpm test`.
 *
 * A dataset built before the current layout is the same situation: present, but
 * not something these queries can read. It skips with its own reason instead of
 * failing every test with the same DatasetStaleError, which said nothing a
 * reader of the failure could act on.
 *
 * The reason carries the error's own text rather than a guess at which layout
 * change is missing. There have been two now — the `empresas`/`simples` fold and
 * the secondary-CNAE column — and a hardcoded message names whichever one the
 * author had in mind, which is the wrong one as soon as there is a third.
 */
const skipReason = await (async (): Promise<string | false> => {
  if (!existsSync(paths.estabelecimentos())) return "rode pnpm data:sync";
  try {
    await countReach({ cnae: ["8520100"] });
    return false;
  } catch (e) {
    if ((e as Error).name === "DatasetStaleError") {
      // First line only: the full message is a multi-line recipe, and a skip
      // reason is printed on one line.
      const first = (e as Error).message.split("\n")[0];
      return `base desatualizada — ${first}`;
    }
    throw e;
  }
})();

describe("consultas na base da Receita", { skip: skipReason }, () => {
  test("um código de 7 dígitos resolve para a descrição oficial", async () => {
    assert.equal(await describeCnae("8520100"), "Ensino médio");
  });

  test("um prefixo válido NÃO é tratado como inventado", async () => {
    // The bug this guards: the dictionary holds only 7-digit leaf codes, so a
    // legitimate 4-digit group like 8599 resolved to null and the UI accused it
    // of being a hallucination — the opposite of the error being guarded against.
    const d = await describeCnae("8599");
    assert.ok(d, "8599 é um grupo real e precisa de descrição");
    assert.match(d, /subclasses/);
  });

  test("um código realmente inventado resolve para null", async () => {
    assert.equal(await describeCnae("9999999"), null);
  });

  test("o modelo confunde 8599 com ensino médio — são coisas diferentes", async () => {
    const medio = await describeCnae("8520100");
    const outro = await describeCnae("8599");
    assert.notEqual(medio, outro);
    assert.doesNotMatch(outro ?? "", /Ensino médio/);
  });

  test("a listagem ordena por data de abertura, mais novas primeiro", async () => {
    const rows = await listCompanies({
      filters: { cnae: ["8520100"], uf: ["SP"] },
      order: "founded-desc",
      limit: 25,
    });
    assert.ok(rows.length > 0, "esperava escolas de ensino médio em SP");
    const dates = rows.map((r) => r.dataInicioAtividade).filter((d): d is string => Boolean(d));
    const sorted = [...dates].sort().reverse();
    assert.deepEqual(dates, sorted, "as datas precisam vir em ordem decrescente");
  });

  test("a base é recente — a parte 0 é a que tem as empresas novas", async () => {
    const rows = await listCompanies({
      filters: { cnae: ["8520100"] },
      order: "founded-desc",
      limit: 1,
    });
    const newest = rows[0]?.dataInicioAtividade;
    assert.ok(newest, "esperava pelo menos uma empresa com data");
    // Built from parts 1-9 this would be 2021 and would look fine.
    assert.ok(newest >= "2025-01-01", `empresa mais nova é de ${newest} — baixou a parte 0?`);
  });

  test("o telefone é classificado na leitura, com o reparo do nono dígito", async () => {
    const rows = await listCompanies({
      filters: { cnae: ["8520100"], hasPhone: true },
      limit: 100,
    });
    const withPhone = rows.filter((r) => r.phone);
    assert.ok(withPhone.length > 0, "hasPhone precisa devolver telefones");
    for (const r of withPhone) {
      assert.match(r.phone!.e164, /^\+55\d{10,11}$/);
      assert.equal(r.phone!.waMe, `https://wa.me/${r.phone!.e164.slice(1)}`);
    }
  });

  test("os filtros só estreitam a contagem, nunca a aumentam", async () => {
    const all = await countReach({ cnae: ["8520100"] });
    const sp = await countReach({ cnae: ["8520100"], uf: ["SP"] });
    const spPhone = await countReach({ cnae: ["8520100"], uf: ["SP"], hasPhone: true });
    assert.ok(all.total >= sp.total);
    assert.ok(sp.total >= spPhone.total);
    assert.ok(spPhone.total > 0);
    assert.ok(all.recent <= all.total);
  });

  test("cnaeReach devolve uma linha por código, inclusive para os inexistentes", async () => {
    const out = await cnaeReach(["8520100", "9999999"]);
    assert.equal(out.length, 2);
    assert.ok(out[0]!.total > 0);
    assert.equal(out[1]!.descricao, null);
    assert.equal(out[1]!.total, 0);
  });
});

/**
 * The secondary CNAE, checked against the real base rather than a fixture.
 *
 * A synthetic Parquet would encode whatever this author assumed about a field
 * whose real shape is the risk: 7-digit codes always, 56,7% of rows populated,
 * up to 99 codes in one row. Those are the assumptions worth testing, and only
 * the real file can falsify them.
 */
describe("CNAE secundário", { skip: skipReason }, () => {
  // 8599 is the project's own reference CNAE and the one with the measured
  // yield; 6201 is the one where the secondary reach is largest.
  const targets = ["8599", "6201"];

  test("desligado, não muda nenhuma contagem", async () => {
    for (const cnae of targets) {
      const off = await countReach({ cnae: [cnae] });
      const explicit = await countReach({ cnae: [cnae], includeCnaeSecundaria: false });
      assert.deepEqual(off, explicit);
      // O padrão é o que sempre foi: tudo é principal, nada é secundário.
      assert.equal(off.secundaria, 0);
      assert.equal(off.principal, off.total);
    }
  });

  test("ligado só acrescenta, e as duas metades somam o total", async () => {
    for (const cnae of targets) {
      const off = await countReach({ cnae: [cnae] });
      const on = await countReach({ cnae: [cnae], includeCnaeSecundaria: true });
      assert.ok(
        on.total >= off.total,
        `${cnae}: ligado (${on.total}) deveria alcançar ao menos o desligado (${off.total})`
      );
      // A garantia que faz "63 principal + 412 secundário" poder ser lido como
      // soma: as duas metades são disjuntas e fecham o total.
      assert.equal(on.principal + on.secundaria, on.total);
      // E o lado principal não muda por ligar a flag.
      assert.equal(on.principal, off.total);
    }
  });

  test("a origem do casamento concorda com o código da linha", async () => {
    const rows = await listCompanies({
      filters: { cnae: ["8599"], includeCnaeSecundaria: true },
      limit: 400,
    });
    assert.ok(rows.length > 0);
    for (const c of rows) {
      if (c.cnaeMatch === "principal") {
        assert.ok(
          c.cnae.startsWith("8599"),
          `${c.cnpj} diz principal mas o CNAE é ${c.cnae}`
        );
        continue;
      }
      // O desempate: quem casou pelo secundário NÃO pode casar pelo principal,
      // senão os dois números se sobrepõem.
      assert.ok(
        !c.cnae.startsWith("8599"),
        `${c.cnpj} diz secundária mas o CNAE principal ${c.cnae} também casa`
      );
      // E tem de dizer POR QUAL código foi alcançada — é a única coisa na linha
      // que explica por que ela está ali, já que `cnae` mostra outra atividade.
      assert.ok(
        c.cnaeSecundariaMatch.length > 0,
        `${c.cnpj} casou pela secundária sem dizer por qual código`
      );
      for (const code of c.cnaeSecundariaMatch) {
        assert.ok(code.startsWith("8599"), `código casado ${code} não começa com 8599`);
      }
    }
  });

  test("pelo menos uma linha é alcançada só pela secundária", async () => {
    // Se isto falhar, a feature não está fazendo nada — e os números medidos
    // (+76% a +295%) dizem que deveria.
    const rows = await listCompanies({
      filters: { cnae: ["8599"], includeCnaeSecundaria: true },
      limit: 1000,
    });
    assert.ok(rows.some((c) => c.cnaeMatch === "secundaria"));
  });

  test("prefixo alcança ao menos o que o código completo alcança", async () => {
    const prefix = await countReach({ cnae: ["8599"], includeCnaeSecundaria: true });
    const leaf = await countReach({ cnae: ["8599604"], includeCnaeSecundaria: true });
    assert.ok(
      prefix.secundaria >= leaf.secundaria,
      `8599 (${prefix.secundaria}) deveria alcançar ao menos 8599604 (${leaf.secundaria})`
    );
  });

  test("cnaeReach separa as duas metades, e o inventado fica em zero", async () => {
    const out = await cnaeReach(["8599", "8599604", "9999999"], {
      includeCnaeSecundaria: true,
    });
    assert.equal(out.length, 3);
    const [prefix, leaf, fake] = out;
    assert.ok(prefix!.secundaria > 0, "esperava alcance secundário para 8599");
    assert.ok(prefix!.secundaria >= leaf!.secundaria);
    // "Não existe" e "existe e não tem ninguém" continuam sendo fatos distintos.
    assert.equal(fake!.descricao, null);
    assert.equal(fake!.total, 0);
    assert.equal(fake!.secundaria, 0);
    // As metades secundárias nunca podem passar do que a metade delas com
    // telefone/recentes reporta.
    for (const r of out) {
      assert.ok(r.secundariaWithPhone <= r.secundaria);
      assert.ok(r.secundariaRecent <= r.secundaria);
    }
  });

  test("todo código guardado tem exatamente 7 dígitos", async () => {
    // Estrutural, e é o teste que avisa se a Receita mudar o formato do campo:
    // sem isso, um código de outro tamanho faria o filtro por prefixo
    // sub-alcançar em silêncio.
    const [row] = await rawQuery<{ n: number | bigint }>(
      `SELECT count(*) AS n FROM estabelecimentos
       WHERE cnae_secundaria IS NOT NULL
         AND len(list_filter(cnae_secundaria, x -> length(x) <> 7)) > 0`
    );
    assert.equal(Number(row?.n ?? 0), 0);
  });
});

/**
 * A ponte reversa: endereço → CNPJ, que é o que o cartão do Maps permite.
 *
 * As sondas são endereços REAIS tirados da própria base, porque a pergunta é se
 * o casamento acha o que existe. Um fixture inventado testaria a minha suposição
 * sobre como a Receita escreve endereço, e é justamente ela que erra.
 */
describe("busca por endereço", { skip: skipReason }, () => {
  const sample = async (n: number) =>
    rawQuery<Record<string, unknown>>(
      `SELECT logradouro, numero, uf, cnpj FROM estabelecimentos
       WHERE cnae_div = '47' AND logradouro IS NOT NULL AND numero IS NOT NULL
         AND regexp_replace(numero, '[^0-9]', '', 'g') <> ''
       LIMIT ${n}`
    );

  test("acha a empresa que mora no endereço, em lote", async () => {
    const rows = await sample(30);
    const probes = rows.map((r, i) => ({
      ref: `p${i}`,
      logradouro: String(r.logradouro),
      numero: String(r.numero),
      uf: String(r.uf),
    }));
    const out = await findByAddress(probes);
    assert.equal(out.length, probes.length, "toda sonda tem de voltar com resposta");

    let achou = 0;
    for (const lookup of out) {
      const src = rows[Number(lookup.ref.slice(1))]!;
      if (lookup.companies.some((c) => c.cnpj === String(src.cnpj))) achou++;
      // A invariante que importa: perder é permitido, perder em silêncio não.
      if (!lookup.companies.some((c) => c.cnpj === String(src.cnpj))) {
        assert.ok(
          lookup.ambiguous || lookup.skipped,
          `${lookup.ref} não achou a própria origem e não disse por quê`
        );
      }
    }
    assert.ok(achou > probes.length / 2, `recall baixo demais: ${achou}/${probes.length}`);
  });

  test("um endereço de prédio comercial é marcado como ambíguo, não escolhido", async () => {
    // Um endereço amostrado tinha 1.985 estabelecimentos ativos. Escolher um
    // deles seria sortear e apresentar como verificado.
    const [row] = await rawQuery<Record<string, unknown>>(
      `SELECT logradouro, numero, uf, count(*) AS n FROM estabelecimentos
       WHERE logradouro IS NOT NULL AND numero IS NOT NULL
         AND regexp_replace(numero, '[^0-9]', '', 'g') <> ''
       GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 1`
    );
    const out = await findByAddress([
      {
        ref: "torre",
        logradouro: String(row!.logradouro),
        numero: String(row!.numero),
        uf: String(row!.uf),
      },
    ]);
    assert.equal(out[0]!.ambiguous, true);
  });

  test("cada recusa tem nome, e nenhuma consulta é feita à toa", async () => {
    const out = await findByAddress([
      { ref: "a", logradouro: "CASTRO ALVES", numero: null, uf: "SP" },
      { ref: "b", logradouro: "B", numero: "10", uf: "SP" },
      { ref: "c", logradouro: "CASTRO ALVES", numero: "10", uf: null },
    ]);
    assert.deepEqual(
      out.map((l) => l.skipped),
      ["sem-numero", "rua-curta", "sem-uf"]
    );
    assert.ok(out.every((l) => l.companies.length === 0));
  });

  test("lote vazio não vira consulta", async () => {
    assert.deepEqual(await findByAddress([]), []);
  });
});

describe("busca de CNAE", { skip: skipReason }, () => {
  test("acha por código", async () => {
    const out = await searchCnaes("85201");
    assert.ok(out.some((c) => c.codigo === "8520100"));
  });

  test("acha por descrição SEM acento", async () => {
    // Ninguém digita "Educação" numa caixa de busca.
    const out = await searchCnaes("educacao infantil");
    assert.ok(out.length > 0, 'esperava resultados para "educacao infantil"');
    assert.ok(out.every((c) => /educa/i.test(c.descricao)));
  });

  test("acha por descrição COM acento também", async () => {
    const out = await searchCnaes("educação infantil");
    assert.ok(out.length > 0);
  });

  test("código bate antes de descrição", async () => {
    const out = await searchCnaes("8520");
    assert.equal(out[0]?.codigo.startsWith("8520"), true);
  });

  test("busca vazia não devolve o dicionário inteiro", async () => {
    assert.deepEqual(await searchCnaes(""), []);
    assert.deepEqual(await searchCnaes("   "), []);
  });
});

describe("filtros novos", { skip: skipReason }, () => {
  const base = { cnae: ["8599605"] };

  test("excluir MEI reduz o total, e MEI + não-MEI fecham a conta", async () => {
    const todas = await countReach(base);
    const semMei = await countReach({ ...base, mei: false });
    const soMei = await countReach({ ...base, mei: true });
    assert.ok(semMei.total < todas.total, "excluir MEI tem de tirar alguém");
    assert.equal(semMei.total + soMei.total, todas.total);
  });

  test("e-mail de domínio próprio é bem mais raro que ter e-mail", async () => {
    // É o motivo de o filtro existir: quase todo micronegócio registra gmail, e
    // um gmail não diz nada sobre o site.
    const comEmail = await countReach({ ...base, hasEmail: true });
    const proprio = await countReach({ ...base, ownDomainEmail: true });
    assert.ok(proprio.total > 0);
    assert.ok(proprio.total < comEmail.total);
  });

  test("nenhum resultado de domínio próprio é de provedor gratuito", async () => {
    const rows = await listCompanies({
      filters: { ...base, ownDomainEmail: true },
      limit: 40,
    });
    assert.ok(rows.length > 0);
    for (const r of rows) {
      const domain = (r.email ?? "").split("@")[1] ?? "";
      assert.ok(domain, `esperava e-mail em ${r.cnpj}`);
      assert.ok(!FREE_MAIL.has(domain), `${domain} é provedor gratuito e passou`);
    }
  });

  test("só celular devolve apenas celular", async () => {
    const rows = await listCompanies({
      filters: { ...base, isMobile: true, hasPhone: true },
      limit: 40,
    });
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(r.phone?.isMobile, true, `${r.cnpj} não é celular`);
    }
  });

  test("porte restringe às faixas pedidas", async () => {
    const rows = await listCompanies({ filters: { ...base, porte: ["03"] }, limit: 30 });
    for (const r of rows) assert.equal(r.porte, "03");
  });

  test("só matriz exclui filiais", async () => {
    const todas = await countReach(base);
    const matriz = await countReach({ ...base, matrizOnly: true });
    assert.ok(matriz.total <= todas.total);
  });

  test("capital mínimo só deixa passar quem tem", async () => {
    const rows = await listCompanies({
      filters: { ...base, minCapitalSocial: 100000 },
      limit: 30,
    });
    for (const r of rows) assert.ok((r.capitalSocial ?? 0) >= 100000);
  });
});

describe("o filtro de site concorda com o crawler", { skip: skipReason }, () => {
  test("tudo que passa por ownDomainEmail o crawler aceita visitar", async () => {
    // A regressão que isto trava: filtrar só por provedor gratuito deixava
    // passar 43% de domínios de escritório de contabilidade, que o
    // `websiteFromEmail` recusa. O filtro prometia um site alcançável e
    // entregava o domínio do contador — e a empresa voltava do pipeline sem
    // nota nenhuma.
    const rows = await listCompanies({
      filters: { cnae: ["8599"], ownDomainEmail: true, mei: false },
      limit: 300,
    });
    assert.ok(rows.length > 50, "esperava amostra suficiente");
    const recusados = rows.filter((r) => !websiteFromEmail(r.email));
    assert.deepEqual(
      recusados.map((r) => r.email),
      [],
      "o filtro passou domínios que o crawler não visitaria"
    );
  });

  test("o filtro é mais estreito que 'tem e-mail'", async () => {
    const comEmail = await countReach({ cnae: ["8599"], hasEmail: true });
    const comSite = await countReach({ cnae: ["8599"], ownDomainEmail: true });
    assert.ok(comSite.total > 0);
    assert.ok(comSite.total < comEmail.total);
  });
});

describe("exclusão de já-adicionadas", { skip: skipReason }, () => {
  test("excludeCnpjs tira exatamente as empresas pedidas", async () => {
    const antes = await listCompanies({
      filters: { cnae: ["8599"], hasPhone: true },
      order: "founded-desc",
      limit: 20,
    });
    assert.ok(antes.length >= 5);
    const excluir = antes.slice(0, 3).map((r) => r.cnpj);

    const depois = await listCompanies({
      filters: { cnae: ["8599"], hasPhone: true, excludeCnpjs: excluir },
      order: "founded-desc",
      limit: 20,
    });
    for (const c of excluir) {
      assert.ok(!depois.some((r) => r.cnpj === c), `${c} deveria ter saído da lista`);
    }
  });

  test("a contagem cai junto, para o cabeçalho não mentir", async () => {
    const rows = await listCompanies({
      filters: { cnae: ["8599"], hasPhone: true },
      limit: 5,
    });
    const excluir = rows.map((r) => r.cnpj);
    const todas = await countReach({ cnae: ["8599"], hasPhone: true });
    const menos = await countReach({ cnae: ["8599"], hasPhone: true, excludeCnpjs: excluir });
    assert.equal(menos.total, todas.total - excluir.length);
  });
});
