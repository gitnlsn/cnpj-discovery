import "server-only";
import { deriveAddress, type DerivedAddress } from "@cnpj/core";
import type { Company } from "@cnpj/data";
import type { companies } from "@cnpj/db";

/**
 * One place that turns a base row into a `companies` insert.
 *
 * There were two copies of this literal — the "add these CNPJs" mutation in
 * `discovery.ts` and the one-at-a-time insert in `continuous.ts` — and they had
 * to agree field for field. They are the same reason `candidate.ts` exists: a
 * column added to one path and forgotten in the other produces companies that
 * are missing data depending on which button was pressed, which looks like bad
 * source data rather than a bug.
 */
export function toCompanyRow(
  c: Company,
  projectId: string,
  sourcePeriod?: string | null
): typeof companies.$inferInsert {
  return {
    projectId,
    cnpj: c.cnpj,
    razaoSocial: c.razaoSocial,
    nomeFantasia: c.nomeFantasia,
    cnae: c.cnae,
    cnaeDescricao: c.cnaeDescricao,
    uf: c.uf,
    municipio: c.municipio,
    bairro: c.bairro,
    tipoLogradouro: c.tipoLogradouro,
    logradouro: c.logradouro,
    numero: c.numero,
    complemento: c.complemento,
    cep: c.cep,
    dataInicioAtividade: c.dataInicioAtividade,
    porte: c.porte,
    capitalSocial: c.capitalSocial,
    naturezaJuridica: c.naturezaJuridica,
    mei: c.mei,
    simples: c.simples,
    email: c.email,
    sourcePeriod: sourcePeriod ?? null,
  };
}

/**
 * A stored company row with its address composed, the way the Parquet layer
 * already hands one back.
 *
 * The four street columns are raw in both stores, so the screen would otherwise
 * have to know how to assemble an address — and would assemble it differently
 * from the CSV and from the base.
 */
export function withAddress<T extends Parameters<typeof deriveAddress>[0]>(
  row: T
): T & { endereco: DerivedAddress | null } {
  return { ...row, endereco: deriveAddress(row) };
}
