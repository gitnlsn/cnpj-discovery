import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Where the browser profile lives, resolved the same way by everybody.
 *
 * Two callers need this answer and they must agree: the search driver, which
 * launches Chrome under Puppeteer, and `scripts/serp-login.ts`, which launches
 * the same profile *without* Puppeteer so a person can sign in. If they
 * disagreed by one directory the login would land in a profile the crawler never
 * opens, and the symptom would be a silent "still not logged in" rather than an
 * error.
 */

/**
 * The workspace root, not the cwd.
 *
 * Same reasoning as `dbPath()` in `@cnpj/db`, learned the same way: under
 * `next dev` the cwd is `apps/web`, so a cwd-relative default put a 147 MB
 * Chrome profile inside the app directory, where eslint then tried to lint
 * Chrome's own bundled JavaScript. The profile belongs beside `app.db` and
 * `data/` — one per repository, not one per whichever package happened to start.
 */
export function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** The Chrome profile directory. `SERP_PROFILE_DIR` overrides it. */
export function profileDir(): string {
  return process.env.SERP_PROFILE_DIR ?? join(repoRoot(), ".serp-profile");
}

/**
 * The installed Chrome, or whatever `SERP_CHROME_PATH` points at.
 *
 * Returns null when nothing is configured and the default is absent, so the
 * caller can say so instead of spawning a path that does not exist. Puppeteer
 * resolves the `chrome` channel by itself and does not need this — the login
 * script, which spawns Chrome directly, does.
 */
export const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function chromePath(): string | null {
  const configured = process.env.SERP_CHROME_PATH;
  if (configured) return existsSync(configured) ? configured : null;
  return existsSync(MAC_CHROME) ? MAC_CHROME : null;
}
