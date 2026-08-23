/**
 * Fills in the street columns for companies pulled into a project before those
 * columns existed.
 *
 *   pnpm db:backfill-address            # do it
 *   pnpm db:backfill-address --dry-run  # count only, writes nothing
 *
 * A one-off, and deliberately not part of `db:migrate`: the migration touches
 * only the schema and has to keep working with no Receita dataset on disk,
 * while this reads the Parquet base to find the values. Safe to run twice — it
 * only looks at rows whose `logradouro` is still null.
 *
 * A company that is no longer in the base is left exactly as it was. That
 * happens when a project was built from an older snapshot than the one now on
 * disk, and inventing an address for it would be worse than leaving it empty.
 */
import { getSqlite } from "../packages/db/src/index";
import { listCompaniesByCnpj } from "../packages/data/src/receita";

const dryRun = process.argv.includes("--dry-run");

/** The base lookup builds one `IN (...)` per call, so it goes in chunks. */
const CHUNK = 500;

async function main(): Promise<void> {
  const sqlite = getSqlite();

  const pending = sqlite
    .prepare(`SELECT DISTINCT cnpj FROM companies WHERE logradouro IS NULL`)
    .all() as { cnpj: string }[];

  if (pending.length === 0) {
    console.log("Nada a fazer: toda empresa já tem logradouro.");
    return;
  }

  const rows = sqlite
    .prepare(`SELECT count(*) n FROM companies WHERE logradouro IS NULL`)
    .get() as { n: number };

  console.log(
    `${rows.n} linha(s) sem logradouro, ${pending.length} CNPJ(s) distintos.` +
      (dryRun ? " --dry-run: não vou escrever nada." : "")
  );
  if (dryRun) return;

  // One statement, reused. `logradouro IS NULL` in the WHERE keeps the run
  // idempotent and stops it overwriting an address someone corrected by hand.
  const update = sqlite.prepare(`
    UPDATE companies
       SET tipo_logradouro = @tipoLogradouro,
           logradouro      = @logradouro,
           numero          = @numero,
           complemento     = @complemento,
           cep             = @cep
     WHERE cnpj = @cnpj AND logradouro IS NULL
  `);

  const cnpjs = pending.map((r) => r.cnpj);
  let filled = 0;
  let missing = 0;

  for (let i = 0; i < cnpjs.length; i += CHUNK) {
    const chunk = cnpjs.slice(i, i + CHUNK);
    const found = await listCompaniesByCnpj(chunk);
    missing += chunk.length - found.length;

    // One transaction per chunk: a crash halfway leaves whole chunks done
    // rather than a half-written row.
    filled += sqlite.transaction((batch: typeof found) => {
      let n = 0;
      for (const c of batch) {
        n += update.run({
          cnpj: c.cnpj,
          tipoLogradouro: c.tipoLogradouro,
          logradouro: c.logradouro,
          numero: c.numero,
          complemento: c.complemento,
          cep: c.cep,
        }).changes;
      }
      return n;
    })(found);

    process.stdout.write(
      `\r  ${Math.min(i + CHUNK, cnpjs.length)}/${cnpjs.length} consultados · ` +
        `${filled} preenchidos`.padEnd(30)
    );
  }
  process.stdout.write("\n");

  const left = (
    sqlite.prepare(`SELECT count(*) n FROM companies WHERE logradouro IS NULL`).get() as {
      n: number;
    }
  ).n;

  console.log(`Pronto: ${filled} linha(s) preenchidas.`);
  if (missing) {
    console.log(
      `  ${missing} CNPJ(s) não estão na base atual — provavelmente vieram de outro ` +
        `período. Ficaram como estavam.`
    );
  }
  if (left) console.log(`  ${left} linha(s) continuam sem logradouro.`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
