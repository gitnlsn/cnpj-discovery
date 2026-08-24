/**
 * Builds the local Receita dataset: download → filter → Parquet.
 *
 * Runs in the terminal, never inside the web app. A full national sync is
 * 30–90 minutes, and a Next dev-server restart would kill it halfway.
 *
 *   pnpm data:sync                           # part 0 — where the recent companies are
 *   pnpm data:sync --parts 0,1,2,3,4,5,6,7,8,9
 *   pnpm data:sync --dry-run                 # sizes only, downloads nothing
 *   pnpm data:sync --fresh --offline --parts 0,1   # rebuild from the ZIPs on disk
 *   pnpm data:sync --drop-intermediates      # delete empresas/simples when done
 *
 * Establishments are DENORMALISED: razão social, natureza jurídica, capital,
 * porte, simples and MEI are written into each row instead of joined at query
 * time. So `empresas` and `simples` are converted first and completely, and the
 * establishments conversion joins against them. They are inputs, not query
 * tables — nothing reads them after the sync, and `--drop-intermediates` removes
 * them. Converting establishments against an incomplete `empresas` bakes a
 * missing razão social into the files, which is why the run ends by measuring the
 * coverage and complaining below 95%.
 *
 * Establishments with no e-mail are dropped. The Receita publishes no website
 * column, so the registered domain is the only thing a crawl can aim at.
 *
 * `--fresh` empties the Parquet directories before writing. Two reasons to need
 * it: the establishments converter APPENDs, so re-running without it doubles
 * every row; and a column added to the layout changes the file schema, which
 * DuckDB refuses to read alongside the old one. A download whose size already
 * matches is skipped, so rebuilding after a layout change costs conversion time
 * and no bandwidth.
 *
 * `--offline` goes further and never touches the network: the period is read
 * from the downloads directory and the ZIPs are taken as they are. That skips
 * the size check that normally catches a truncated download, so it is opt-in
 * rather than something the script decides for you.
 *
 * The ten Estabelecimentos parts are NOT a uniform split. Part 0 is ~6x the
 * size of the others and holds the recent registrations: measured on 2026-08,
 * its first 250 MB alone carry 470k companies opened in 2025 and 373k in 2026,
 * while all of part 1 stops in May 2021. Anything sorted newest-first needs
 * part 0; parts 1-9 are the historical tail.
 */
import { mkdir, stat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { scratchConnection, paths, dataRoot } from "../packages/data/src/duck";
import {
  periodUrl,
  latestPeriod,
  listPeriod,
  download,
  fmtBytes,
} from "../packages/data/src/sync/mirror";
import {
  convertEstabelecimentos,
  convertEmpresas,
  convertSimples,
  convertRef,
  type FilterStats,
} from "../packages/data/src/sync/convert";

interface Args {
  period?: string;
  parts: number[];
  only?: string[];
  dryRun: boolean;
  keepZips: boolean;
  fresh: boolean;
  offline: boolean;
  dropIntermediates: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const parts = (get("--parts") ?? "0")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 9);
  if (parts.length === 0) throw new Error("--parts precisa de números entre 0 e 9");
  return {
    period: get("--period"),
    parts,
    only: get("--only")
      ?.split(",")
      .map((s) => s.trim()),
    dryRun: argv.includes("--dry-run"),
    keepZips: argv.includes("--keep-zips"),
    fresh: argv.includes("--fresh"),
    offline: argv.includes("--offline"),
    dropIntermediates: argv.includes("--drop-intermediates"),
  };
}

const wants = (args: Args, name: string) => !args.only || args.only.includes(name);

/** The newest YYYY-MM directory under data/downloads. Used only by --offline. */
async function localPeriod(): Promise<string> {
  const entries = await readdir(paths.downloads(), { withFileTypes: true }).catch(() => []);
  const months = entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  if (!months.length) {
    throw new Error(`Nenhuma pasta YYYY-MM em ${paths.downloads()}. Passe --period.`);
  }
  return months.at(-1)!;
}

/** The ZIPs already in the period directory, by name and size on disk. */
async function localSizes(dir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && e.name.toLowerCase().endsWith(".zip")) {
      out.set(e.name, (await stat(join(dir, e.name))).size);
    }
  }
  return out;
}

/** Bytes of a single file, 0 if it is not there. */
async function fileSize(path: string): Promise<number> {
  return await stat(path)
    .then((st) => st.size)
    .catch(() => 0);
}

async function dirSize(path: string): Promise<number> {
  let total = 0;
  const walk = async (p: string): Promise<void> => {
    for (const e of await readdir(p, { withFileTypes: true })) {
      const child = join(p, e.name);
      if (e.isDirectory()) await walk(child);
      else total += (await stat(child)).size;
    }
  };
  try {
    await walk(path);
  } catch {
    return 0;
  }
  return total;
}

function progressLine(label: string, text: string): void {
  process.stdout.write(`\r  ${label} ${text}`.padEnd(78).slice(0, 78));
}

/**
 * How many establishments actually carry a razão social.
 *
 * `Empresas` and `Estabelecimentos` are both split into ten parts, and it is
 * natural to assume part N of one pairs with part N of the other. It does not:
 * measured on parts 0 and 1 of 2026-08, 13,1 million establishments joined
 * against 33,5 million companies and only 60% found a name.
 *
 * This used to be a LEFT JOIN measured after the fact. Now the name is written
 * into the establishments row, so a gap here is not a column that fills itself in
 * when more Empresas parts arrive — it is baked into the Parquet until the next
 * `--fresh`. That makes the warning below more important than it was, not less.
 *
 * A missing razão social is a blank column for a normal company — but for a MEI
 * it is the owner's civil name, which is the only thing the web search has to
 * look for, so those companies cannot be enriched at all.
 */
async function reportRazaoCoverage(
  conn: Awaited<ReturnType<typeof scratchConnection>>
): Promise<number | null> {
  const estab = join(paths.estabelecimentos(), "**", "*.parquet");
  try {
    const reader = await conn.runAndReadAll(`
      SELECT count(*) AS total, count(razao_social) AS com_razao
      FROM read_parquet('${estab}', hive_partitioning = true)
    `);
    const [row] = reader.getRowObjects() as { total: bigint; com_razao: bigint }[];
    if (!row) return null;
    const total = Number(row.total);
    const named = Number(row.com_razao);
    if (!total) return null;
    const pct = (100 * named) / total;
    console.log(
      `\nRazão social: ${named.toLocaleString("pt-BR")} de ${total.toLocaleString("pt-BR")} (${pct.toFixed(1)}%)`
    );
    if (pct < 95) {
      console.log(
        `  As partes de Empresas NÃO pareiam com as de Estabelecimentos, e agora a\n` +
          `  razão social é gravada dentro de cada linha: essa lacuna só sai com um\n` +
          `  --fresh depois de converter Empresas0..9. Sem razão social um MEI não tem\n` +
          `  nome para procurar na web, porque a razão social dele é o nome do dono.\n\n` +
          `    pnpm data:sync --only empresas --parts 0,1,2,3,4,5,6,7,8,9\n` +
          `    pnpm data:sync --only estabelecimentos --fresh --offline`
      );
    }
    return pct;
  } catch {
    // A partial run (--only empresas) may have no establishments to measure.
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const period = args.period ?? (args.offline ? await localPeriod() : await latestPeriod());
  const base = periodUrl(period).replace(/\/$/, "");
  const dl = join(paths.downloads(), period);
  await mkdir(dl, { recursive: true });

  console.log(`Receita Federal · período ${period}`);
  console.log(`  origem   ${base}`);
  console.log(`  destino  ${dataRoot()}`);
  console.log(`  partes   ${args.parts.join(",")}\n`);

  const files: string[] = [];
  if (wants(args, "ref")) files.push("Cnaes.zip", "Municipios.zip");
  if (wants(args, "estabelecimentos"))
    files.push(...args.parts.map((p) => `Estabelecimentos${p}.zip`));
  if (wants(args, "empresas")) files.push(...args.parts.map((p) => `Empresas${p}.zip`));
  if (wants(args, "simples")) files.push("Simples.zip");

  // Always price the download before starting it. Socios is never in this list:
  // it is 2.3 GB of CPF data with no use here.
  const available = args.offline ? await localSizes(dl) : await listPeriod(period);
  const missing = files.filter((f) => !available.has(f));
  if (missing.length) {
    throw new Error(
      args.offline
        ? `Não estão em ${dl}: ${missing.join(", ")}. Rode sem --offline para baixar.`
        : `Não existem em ${period}: ${missing.join(", ")}`
    );
  }
  let planned = 0;
  console.log(args.offline ? "Vou reconverter (nada será baixado):" : "Vou baixar:");
  for (const f of files) {
    const size = available.get(f)!;
    planned += size;
    console.log(`  ${f.padEnd(26)} ${fmtBytes(size).padStart(10)}`);
  }
  console.log(`  ${"total".padEnd(26)} ${fmtBytes(planned).padStart(10)}\n`);
  if (args.dryRun) {
    console.log("--dry-run: nada foi baixado.");
    return;
  }

  if (args.fresh) {
    // Only what this run is about to rewrite. Wiping `simples` or the reference
    // tables during an `--only estabelecimentos` run would leave the dataset
    // half-built with no way to tell.
    const targets: string[] = [];
    if (wants(args, "estabelecimentos")) targets.push(paths.estabelecimentos());
    if (wants(args, "empresas")) targets.push(paths.empresas());
    for (const dir of targets) await rm(dir, { recursive: true, force: true });
    console.log(`--fresh: apaguei ${targets.length} diretório(s) antes de reconverter.\n`);
  }

  const conn = await scratchConnection();
  const t0 = Date.now();
  const totals: Record<string, FilterStats> = {};

  const fetchOne = async (name: string): Promise<string> => {
    const dest = join(dl, name);
    // Already verified present by the listing above.
    if (args.offline) return dest;
    await download(`${base}/${name}`, dest, (got, total) =>
      progressLine(name, `${fmtBytes(got)} / ${fmtBytes(total)}`)
    );
    process.stdout.write("\n");
    return dest;
  };

  const tick = (name: string) => (s: FilterStats) =>
    progressLine(
      name,
      `${s.read.toLocaleString("pt-BR")} lidas · ${s.kept.toLocaleString("pt-BR")} mantidas`
    );

  if (wants(args, "ref")) {
    const cnaes = await fetchOne("Cnaes.zip");
    await convertRef(conn, cnaes, join(dl, "t-cnaes.csv"), paths.cnaes(), [
      "codigo",
      "descricao",
    ]);
    const mun = await fetchOne("Municipios.zip");
    await convertRef(conn, mun, join(dl, "t-mun.csv"), paths.municipios(), [
      "codigo",
      "descricao",
    ]);
    console.log("  referências prontas (cnaes, municípios)\n");
  }

  // Order matters now. Establishments carry razão social, porte, capital,
  // natureza, simples and MEI in the row, so their conversion joins against the
  // finished `empresas` and `simples` Parquet — which therefore have to exist,
  // complete, first. Downloads may still interleave; only the conversion is
  // ordered.
  for (const p of args.parts) {
    if (wants(args, "empresas")) {
      const name = `Empresas${p}.zip`;
      const zip = await fetchOne(name);
      const s = await convertEmpresas(
        conn,
        zip,
        join(dl, `t-emp-${p}.csv`),
        paths.empresas(),
        `p${p}`,
        tick(name)
      );
      process.stdout.write("\n");
      totals[name] = s;
    }
  }

  if (wants(args, "simples")) {
    const zip = await fetchOne("Simples.zip");
    const s = await convertSimples(
      conn,
      zip,
      join(dl, "t-simples.csv"),
      paths.simples(),
      tick("Simples.zip")
    );
    process.stdout.write("\n");
    totals["Simples.zip"] = s;
  }

  for (const p of args.parts) {
    if (wants(args, "estabelecimentos")) {
      const name = `Estabelecimentos${p}.zip`;
      const zip = await fetchOne(name);
      const s = await convertEstabelecimentos(
        conn,
        zip,
        join(dl, `t-estab-${p}.csv`),
        paths.estabelecimentos(),
        `p${p}`,
        { empresasDir: paths.empresas(), simplesFile: paths.simples() },
        tick(name)
      );
      process.stdout.write("\n");
      totals[name] = s;
    }
  }

  // The numbers that decide whether this approach is viable at national scale.
  const estabBytes = await dirSize(paths.estabelecimentos());
  const empBytes = await dirSize(paths.empresas());
  const secs = ((Date.now() - t0) / 1000).toFixed(0);

  console.log(`\nPronto em ${secs}s.\n`);
  console.log("Filtragem:");
  for (const [name, s] of Object.entries(totals)) {
    const pct = s.read ? ((s.kept / s.read) * 100).toFixed(1) : "0";
    console.log(
      `  ${name.padEnd(26)} ${s.read.toLocaleString("pt-BR").padStart(12)} lidas → ` +
        `${s.kept.toLocaleString("pt-BR").padStart(12)} mantidas (${pct}%)` +
        (s.withPhone
          ? ` · ${((s.withPhone / (s.kept || 1)) * 100).toFixed(1)}% com telefone`
          : "")
    );
    // The secondary-CNAE line is what answers "was that column worth the
    // reconversion". It gets its own line because the fields above are listed
    // one by one rather than iterated, so a new counter is invisible until
    // somebody prints it.
    if (s.withCnaeSecundaria) {
      const pctSec = ((s.withCnaeSecundaria / (s.kept || 1)) * 100).toFixed(1);
      const avg = (s.cnaeSecundariaCodes / s.withCnaeSecundaria).toFixed(2);
      console.log(
        `  ${"".padEnd(26)} ${pctSec.padStart(12)}% com CNAE secundário ` +
          `(média ${avg} códigos)`
      );
    }
  }
  const simplesBytes = await fileSize(paths.simples());
  console.log("\nParquet em disco:");
  console.log(`  estabelecimentos  ${fmtBytes(estabBytes).padStart(10)}`);
  console.log(`  empresas          ${fmtBytes(empBytes).padStart(10)}  (intermediário)`);
  console.log(`  simples           ${fmtBytes(simplesBytes).padStart(10)}  (intermediário)`);
  // No national projection from a subset: the parts are not equal in size, so
  // scaling one of them by ten would be a made-up number.
  if (args.parts.length < 10) {
    console.log(`\n  Parcial: partes ${args.parts.join(",")} de 0-9.`);
  }

  const razaoPct = await reportRazaoCoverage(conn);

  // `empresas` and `simples` are consumed by the establishments conversion and
  // read by nothing at query time. Deleting them is where the disk saving of the
  // fold actually lands — but it is opt-in, because a later
  // `--only estabelecimentos` needs them back (and says so, loudly, instead of
  // writing nulls).
  //
  // Never dropped after a run whose razão social came out short: that is exactly
  // when the ZIPs have to be reconverted, and deleting the inputs would throw
  // away both the fix and the evidence of the problem.
  const intermediates = empBytes + simplesBytes;
  const razaoOk = razaoPct === null || razaoPct >= 95;
  if (args.dropIntermediates && !razaoOk) {
    console.log(
      `\n  --drop-intermediates recusado: a razão social ficou em ` +
        `${razaoPct!.toFixed(1)}%.\n` +
        `  empresas e simples são o que conserta isso, então ficam onde estão.`
    );
  } else if (args.dropIntermediates) {
    if (wants(args, "estabelecimentos")) {
      await rm(paths.empresas(), { recursive: true, force: true });
      await rm(paths.simples(), { force: true });
      console.log(
        `\n  --drop-intermediates: apaguei empresas e simples (${fmtBytes(intermediates)}).`
      );
    } else {
      console.log(
        `\n  --drop-intermediates ignorado: esta rodada não converteu estabelecimentos,\n` +
          `  então apagar empresas/simples deixaria a base sem como ser reconstruída.`
      );
    }
  } else if (intermediates > 0) {
    console.log(
      `\n  empresas + simples somam ${fmtBytes(intermediates)} e nenhuma consulta os lê:\n` +
        `  são entrada da conversão de estabelecimentos. --drop-intermediates apaga.`
    );
  }

  if (!args.keepZips) {
    console.log(
      `\n  Os ZIPs continuam em ${dl} (apague à vontade; --keep-zips é o padrão hoje).`
    );
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
