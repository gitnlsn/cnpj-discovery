/**
 * Reads the LinkedIn pages the search already found, and stores what they say.
 *
 *   pnpm linkedin:enrich                # do it
 *   pnpm linkedin:enrich --dry-run      # show the plan, fetch nothing
 *   pnpm linkedin:enrich --limit 5      # smaller ceiling than the default
 *
 * ## Turn this on deliberately or not at all
 *
 * Requires `LINKEDIN_ENABLED=1`, and being signed in is not enough to enable it.
 * The reasons are in `@cnpj/serp/linkedin`, and the short version is that this
 * fetches pages LinkedIn's robots.txt forbids, from a signed-in account, and
 * LinkedIn answers automation by restricting the account permanently rather than
 * throttling an IP temporarily. Sign in with a throwaway account —
 * `pnpm serp:login` says so every time it runs.
 *
 * ## Why a script and not a button
 *
 * Pacing. Forty to seventy-five seconds between pages, with longer stops every
 * fifth one, means twenty pages is most of an hour — and a person has to be
 * nearby, because a sign-in wall needs somebody to clear it. That is a terminal
 * job you leave running, not a click you wait on in a browser tab. The loop
 * itself is `enrichLinkedIn` in `@cnpj/core`, so wiring it to a job later is a
 * matter of supplying the same two ports.
 */
import { getSqlite } from "../packages/db/src/index";
import {
  enrichLinkedIn,
  planFetch,
  type LinkedInCandidate,
  type LinkedInPageResult,
} from "../packages/core/src/index";
import { createLinkedInDriver } from "../packages/serp/src/index";

/**
 * The default ceiling, in pages per run.
 *
 * Twelve, not two hundred. At this pacing twelve pages is roughly fifteen
 * minutes of wall clock, which is about as long as somebody will actually sit
 * near a terminal waiting to clear a login wall. Raising it is the first thing
 * that will get the account noticed, which is why it is an argument rather than
 * a constant somebody edits upward in a hurry.
 */
const DEFAULT_LIMIT = 12;

function enabled(): boolean {
  return process.env.LINKEDIN_ENABLED === "1" || process.env.LINKEDIN_ENABLED === "true";
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/**
 * The work list: verified LinkedIn hits with no page row yet.
 *
 * The LEFT JOIN is what makes the script safe to re-run. A row in
 * `linkedin_pages` means we already have an answer — including "we were blocked",
 * which is deliberately *not* retried here: retrying a refusal automatically is
 * how a warning becomes a restriction. Clearing the row is a person's decision.
 */
const WORK = `
  SELECT h.cnpj, h.url, h.kind, h.title,
         c.razao_social  AS razaoSocial,
         c.nome_fantasia AS nomeFantasia
    FROM search_hits h
    JOIN companies c ON c.cnpj = h.cnpj
    LEFT JOIN linkedin_pages p ON p.cnpj = h.cnpj
   WHERE h.kind IN ('linkedin', 'linkedin_company')
     AND p.cnpj IS NULL
   GROUP BY h.cnpj, h.url
   ORDER BY h.checked_at DESC
`;

/** The `/in/<slug>` half, which `linkedInEntitySlug` deliberately does not match. */
function profileSlug(url: string): string | null {
  try {
    return (
      /^\/(?:[a-z]{2}\/)?(?:in|pub)\/([^/]+)/.exec(new URL(url).pathname.toLowerCase())?.[1] ??
      null
    );
  } catch {
    return null;
  }
}

/** Flattens a result into the row shape, so every outcome writes exactly once. */
function toRow(cnpj: string, r: LinkedInPageResult): Record<string, unknown> {
  const base = {
    cnpj,
    url: r.url,
    kind: r.status === "ok" ? r.mode : "entity",
    // The slug is LinkedIn's own stable key for the entity, and it is the one
    // field that survives a rename: a company that changes its display name
    // keeps the slug, so it is what a later run should match on.
    slug: linkedInEntitySlug(r.url) ?? profileSlug(r.url),
    name: null as string | null,
    description: null as string | null,
    industry: null as string | null,
    employees_min: null as number | null,
    employees_max: null as number | null,
    employees_on_linkedin: null as number | null,
    headquarters: null as string | null,
    website: null as string | null,
    founded: null as string | null,
    followers: null as number | null,
    headline: null as string | null,
    location: null as string | null,
    error: null as string | null,
  };

  if (r.status === "gone") return { ...base, error: "página não existe" };
  if (r.status === "blocked") return { ...base, error: `${r.wall}: ${r.reason}` };

  if (r.mode === "entity") {
    const f = r.facts;
    return {
      ...base,
      name: f.name,
      description: f.description,
      industry: f.industry,
      employees_min: f.employeeRange?.min ?? null,
      employees_max: f.employeeRange?.max ?? null,
      employees_on_linkedin: f.employeesOnLinkedIn,
      headquarters: f.headquarters,
      website: f.website,
      founded: f.founded,
      followers: f.followers,
    };
  }
  const f = r.facts;
  return {
    ...base,
    name: f.name,
    headline: f.headline,
    location: f.location,
    description: f.about,
  };
}

async function main(): Promise<void> {
  if (!enabled()) {
    console.error(
      `LINKEDIN_ENABLED não está ligado, então não vou buscar nada.\n` +
        `\n` +
        `  Isto busca páginas que o robots.txt do LinkedIn proíbe, usando uma conta\n` +
        `  logada. O LinkedIn responde a automação restringindo a CONTA, e a\n` +
        `  restrição dele costuma ser permanente — não é como o bloqueio de IP do\n` +
        `  Google, que passa sozinho.\n` +
        `\n` +
        `  Se você aceita isso, use uma conta descartável (\`pnpm serp:login\`) e\n` +
        `  ligue com LINKEDIN_ENABLED=1.`
    );
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  const limit = Number(arg("--limit")) || DEFAULT_LIMIT;
  const sqlite = getSqlite();

  const rows = sqlite.prepare(WORK).all() as LinkedInCandidate[];
  const plans = rows.map(planFetch).filter((p): p is NonNullable<typeof p> => p !== null);

  if (!plans.length) {
    console.log(
      `Nada a buscar: ${rows.length} hit(s) do LinkedIn em search_hits, nenhum passou os ` +
        `portões de identidade (ou todos já têm página gravada).\n` +
        `\n` +
        `  Se este número é zero, é esperado: o DuckDuckGo quase nunca devolve\n` +
        `  linkedin.com. Os hits do LinkedIn aparecem quando o Google roda\n` +
        `  (SERP_GOOGLE=on), e é ele que alimenta esta fila.`
    );
    return;
  }

  console.log(`${plans.length} página(s) na fila, teto de ${limit} nesta rodada.`);
  if (dryRun) {
    for (const p of plans.slice(0, limit)) console.log(`  ${p.mode.padEnd(7)} ${p.url}`);
    console.log(`\n--dry-run: não busquei nada.`);
    return;
  }

  const driver = createLinkedInDriver({
    // Raise-only, enforced by the driver: a value below its floor is ignored
    // rather than honoured. Going faster here is what gets the account noticed.
    minGapMs: Number(process.env.LINKEDIN_MIN_GAP_MS) || undefined,
    onWall: ({ url, waitingMs }) =>
      console.log(
        `⚠️  O LinkedIn pediu login. A janela do Chrome está aberta — entre lá e eu sigo ` +
          `sozinho (espero até ${Math.round(waitingMs / 60000)} min). Página: ${url}`
      ),
    onWallResolved: ({ outcome, waitedMs }) =>
      console.log(`   login ${outcome} após ${Math.round(waitedMs / 1000)}s`),
    onPacing: ({ ms, reason }) =>
      console.log(
        reason === "long-pause"
          ? `   pausa longa de ${Math.round(ms / 1000)}s (de propósito: ritmo constante é o que parece robô)`
          : `   esperando ${Math.round(ms / 1000)}s`
      ),
  });

  const insert = sqlite.prepare(`
    INSERT INTO linkedin_pages (cnpj, url, kind, slug, name, description, industry,
      employees_min, employees_max, employees_on_linkedin, headquarters, website,
      founded, followers, headline, location, error)
    VALUES (@cnpj, @url, @kind, @slug, @name, @description, @industry,
      @employees_min, @employees_max, @employees_on_linkedin, @headquarters, @website,
      @founded, @followers, @headline, @location, @error)
    ON CONFLICT (cnpj, url) DO UPDATE SET
      kind = excluded.kind, name = excluded.name, description = excluded.description,
      industry = excluded.industry, employees_min = excluded.employees_min,
      employees_max = excluded.employees_max,
      employees_on_linkedin = excluded.employees_on_linkedin,
      headquarters = excluded.headquarters, website = excluded.website,
      founded = excluded.founded, followers = excluded.followers,
      headline = excluded.headline, location = excluded.location,
      error = excluded.error, checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);

  try {
    const stats = await enrichLinkedIn(
      plans,
      driver,
      { save: async (cnpj, result) => void insert.run(toRow(cnpj, result)) },
      {
        budget: limit,
        onProgress: ({ done, total, url }) => console.log(`[${done + 1}/${total}] ${url}`),
        onStop: ({ because, reason }) => console.log(`\nparei (${because}): ${reason}`),
      }
    );

    console.log(
      `\n${stats.fetched} lida(s), ${stats.gone} inexistente(s), ${stats.blocked} recusada(s). ` +
        `${stats.improved.length} empresa(s) ganharam fato novo` +
        (stats.improved.length ? ` — vale re-pontuar: ${stats.improved.join(", ")}` : ".")
    );
  } finally {
    await driver.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
