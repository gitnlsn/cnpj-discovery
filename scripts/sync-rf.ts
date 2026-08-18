/**
 * Builds the local Receita dataset: download → filter → Parquet.
 *
 * Runs in the terminal, never inside the web app. A full national sync is
 * 30–90 minutes, and a Next dev-server restart would kill it halfway.
 *
 *   pnpm data:sync                           # part 0 — where the recent companies are
 *   pnpm data:sync --parts 0,1,2,3,4,5,6,7,8,9
 *   pnpm data:sync --dry-run                 # sizes only, downloads nothing
 *
 * The ten Estabelecimentos parts are NOT a uniform split. Part 0 is ~6x the
 * size of the others and holds the recent registrations: measured on 2026-08,
 * its first 250 MB alone carry 470k companies opened in 2025 and 373k in 2026,
 * while all of part 1 stops in May 2021. Anything sorted newest-first needs
 * part 0; parts 1-9 are the historical tail.
 */
import { mkdir, stat, readdir } from "node:fs/promises";
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
  };
}

const wants = (args: Args, name: string) => !args.only || args.only.includes(name);

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const period = args.period ?? (await latestPeriod());
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
  const available = await listPeriod(period);
  const missing = files.filter((f) => !available.has(f));
  if (missing.length) {
    throw new Error(`Não existem em ${period}: ${missing.join(", ")}`);
  }
  let planned = 0;
  console.log("Vou baixar:");
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

  const conn = await scratchConnection();
  const t0 = Date.now();
  const totals: Record<string, FilterStats> = {};

  const fetchOne = async (name: string): Promise<string> => {
    const dest = join(dl, name);
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
        tick(name)
      );
      process.stdout.write("\n");
      totals[name] = s;
    }
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
  }
  console.log("\nParquet em disco:");
  console.log(`  estabelecimentos  ${fmtBytes(estabBytes).padStart(10)}`);
  console.log(`  empresas          ${fmtBytes(empBytes).padStart(10)}`);
  // No national projection from a subset: the parts are not equal in size, so
  // scaling one of them by ten would be a made-up number.
  if (args.parts.length < 10) {
    console.log(`\n  Parcial: partes ${args.parts.join(",")} de 0-9.`);
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
