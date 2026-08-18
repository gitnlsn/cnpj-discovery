import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { paths } from "../src/duck";
import { describeCnae, listCompanies, countReach, cnaeReach } from "../src/receita";

/**
 * These run against the real Parquet dataset, not a fixture.
 *
 * What they cover is precisely what TypeScript cannot: that the SQL is right,
 * that partition pruning does not change the answer, and that the ordering is
 * the one claimed. With no dataset built they skip rather than fail — a fresh
 * clone has no `data/parquet` and should still be able to run `pnpm test`.
 */
const hasDataset = existsSync(paths.estabelecimentos());

describe("consultas na base da Receita", { skip: hasDataset ? false : "rode pnpm data:sync" }, () => {
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
