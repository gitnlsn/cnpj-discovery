import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describeFetchError, isDnsFailure } from "@cnpj/core/domain";

/**
 * The Receita Federal publishes the monthly bulk files through a public
 * Nextcloud share that speaks WebDAV. This is the primary source: it carries
 * the current month, and there is no third party between us and the data.
 *
 * The CDN mirror some tools use (dados-abertos-rf-cnpj.casadosdados.com.br)
 * serves the identical bytes but lags a month, so it is only a fallback.
 */
const RF_DAV_DEFAULT =
  "https://arquivos.receitafederal.gov.br/public.php/dav/files/YggdBLfdninEJX9/";

/**
 * Where the bulk files are fetched from, overridable with `RF_DAV_ROOT`.
 *
 * An override exists because this host has disappeared before: the share is a
 * Nextcloud instance on a subdomain the Receita controls, and when that
 * subdomain stops resolving there is nothing wrong with the code and no way to
 * carry on without editing it. Whatever is set has to speak the same WebDAV
 * PROPFIND, and must end in a slash.
 */
export const RF_DAV_ROOT = (process.env.RF_DAV_ROOT || RF_DAV_DEFAULT).replace(
  /\/*$/,
  "/"
);

/**
 * A network failure with its reason named, and the host it happened to.
 *
 * `fetch` says only "fetch failed" — the same string whether the domain has
 * ceased to exist or a certificate expired. The crawler learned to look in
 * `cause` long ago; the sync had not, so a dead host looked like a bug in the
 * script.
 */
export class MirrorUnreachableError extends Error {
  readonly dns: boolean;
  constructor(url: string, cause: unknown) {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    const why = describeFetchError(cause, 0);
    const dns = isDnsFailure(cause);
    super(
      `Não consegui falar com ${host}: ${why}.` +
        (dns
          ? `\n\n  O host não resolve. Isso não é problema do seu código nem da sua rede —` +
            `\n  o compartilhamento da Receita já mudou de endereço antes.` +
            `\n\n  · para reconverter o que já está em disco:  pnpm data:sync --fresh --offline` +
            `\n  · para apontar para outro espelho:           RF_DAV_ROOT=https://… pnpm data:sync`
          : "")
    );
    this.name = "MirrorUnreachableError";
    this.dns = dns;
    this.cause = cause;
  }
}

const UA = "cnpj-discovery/0.1";

/** One `<d:response>` per entry; we only need the name and the size. */
function parsePropfind(xml: string): { name: string; size: number | null }[] {
  const out: { name: string; size: number | null }[] = [];
  for (const chunk of xml.split(/<\/[a-z]*:?response>/i)) {
    const href = /<[a-z]*:?href>(.*?)<\/[a-z]*:?href>/i.exec(chunk);
    if (!href?.[1]) continue;
    const name = decodeURIComponent(href[1].replace(/\/+$/, "").split("/").pop() ?? "");
    const len = /<[a-z]*:?getcontentlength>(\d+)<\/[a-z]*:?getcontentlength>/i.exec(chunk);
    if (name) out.push({ name, size: len?.[1] ? Number(len[1]) : null });
  }
  return out;
}

async function propfind(url: string): Promise<{ name: string; size: number | null }[]> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PROPFIND",
      headers: { Depth: "1", "User-Agent": UA },
    });
  } catch (err) {
    throw new MirrorUnreachableError(url, err);
  }
  if (!res.ok && res.status !== 207) {
    throw new Error(`PROPFIND ${url} falhou (${res.status})`);
  }
  return parsePropfind(await res.text());
}

/** The most recent `YYYY-MM` folder published on the share. */
export async function latestPeriod(): Promise<string> {
  const entries = await propfind(RF_DAV_ROOT);
  const months = entries
    .map((e) => e.name)
    .filter((n) => /^\d{4}-\d{2}$/.test(n))
    .sort();
  if (months.length === 0) {
    throw new Error(`Nenhuma pasta YYYY-MM em ${RF_DAV_ROOT}. Passe --period.`);
  }
  return months.at(-1)!;
}

export function periodUrl(period: string): string {
  return `${RF_DAV_ROOT}${period}/`;
}

/** Names and sizes of the ZIPs in a month, without downloading anything. */
export async function listPeriod(period: string): Promise<Map<string, number>> {
  const entries = await propfind(periodUrl(period));
  const out = new Map<string, number>();
  for (const e of entries) {
    if (e.name.toLowerCase().endsWith(".zip") && e.size !== null) out.set(e.name, e.size);
  }
  return out;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

export async function remoteSize(url: string): Promise<number> {
  let head: Response;
  try {
    head = await fetch(url, { method: "HEAD", headers: { "User-Agent": UA } });
  } catch (err) {
    throw new MirrorUnreachableError(url, err);
  }
  if (!head.ok) throw new Error(`HEAD ${url} falhou (${head.status})`);
  return Number(head.headers.get("content-length") ?? 0);
}

/**
 * Downloads with resume. These files run to gigabytes over a link that will
 * drop at least once, so a restart must not mean starting from zero.
 */
export async function download(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const total = await remoteSize(url);
  const existing = await fileSize(dest);

  if (existing !== undefined && total > 0 && existing === total) {
    onProgress?.(total, total);
    return;
  }

  const headers: Record<string, string> = { "User-Agent": UA };
  let flags: "w" | "a" = "w";
  let received = 0;
  if (existing !== undefined && existing > 0 && existing < total) {
    headers.Range = `bytes=${existing}-`;
    flags = "a";
    received = existing;
  }

  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new MirrorUnreachableError(url, err);
  }
  if (!res.ok && res.status !== 206) throw new Error(`GET ${url} falhou (${res.status})`);
  if (!res.body) throw new Error(`GET ${url} não devolveu corpo`);

  let lastTick = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastTick > 500) {
      lastTick = now;
      onProgress?.(received, total);
    }
  });

  await pipeline(body, createWriteStream(dest, { flags }));
  onProgress?.(total, total);
}

/**
 * Streams the lines out of a ZIP without ever materialising the CSV on disk.
 * Shells out to `unzip -p` because the archives are far larger than memory and
 * the RF text is latin1, which has to be transcoded before it can be split.
 */
export function streamZipLines(zipPath: string): Readable {
  const child = spawn("unzip", ["-p", zipPath], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));

  let remainder = "";
  const out = new Readable({ objectMode: true, read() {} });

  child.stdout.on("data", (chunk: Buffer) => {
    const text = remainder + chunk.toString("latin1");
    const lines = text.split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) out.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  });

  child.stdout.on("end", () => {
    if (remainder.length > 0) out.push(remainder);
    out.push(null);
  });

  child.on("error", (err) => out.destroy(err));
  child.on("close", (code) => {
    if (code !== 0) {
      out.destroy(new Error(`unzip ${zipPath} saiu com ${code}: ${stderr.slice(0, 300)}`));
    }
  });

  return out;
}
