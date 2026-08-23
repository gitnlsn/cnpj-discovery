import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Which accounts this profile is signed into.
 *
 * The point of asking is that a sign-in can silently land in the *wrong*
 * profile — a person clicks through Google's flow in their everyday Chrome, sees
 * "welcome back", and the crawler's profile is untouched. Without this check the
 * only symptom is that the crawler behaves exactly as it did before, which is
 * indistinguishable from the login not having helped.
 *
 * Only cookie *names* are read. Chrome encrypts the values against a key in the
 * macOS Keychain and nothing here tries to decrypt them: presence of the name is
 * the whole question, and decrypting a session token to print it would be a
 * gratuitous way to leak one into a terminal buffer.
 */

/**
 * The cookie that means "this browser holds a signed-in session".
 *
 * One per host, chosen as the one that is (a) set only after a completed login
 * and (b) stable across LinkedIn's and Google's redesigns. `li_at` is
 * LinkedIn's session token; `SID` is the oldest and least-renamed of Google's.
 */
const AUTH_COOKIES: { label: string; hostLike: string; names: string[] }[] = [
  { label: "Google", hostLike: "%google.com", names: ["SID", "__Secure-1PSID"] },
  { label: "LinkedIn", hostLike: "%linkedin.com", names: ["li_at"] },
];

export interface SessionStatus {
  label: string;
  signedIn: boolean;
}

/**
 * Reads the profile's cookie store, or reports nothing when it cannot.
 *
 * Returns `signedIn: false` rather than throwing when the file is missing or
 * locked: this is a diagnostic, and a diagnostic that can fail the run it is
 * diagnosing is worse than no diagnostic. Chrome must be closed for the read to
 * succeed, which is why the login script calls this only after Chrome exits.
 */
export function sessionStatus(profileDir: string): SessionStatus[] | null {
  const cookies = join(profileDir, "Default", "Cookies");
  if (!existsSync(cookies)) return null;

  let db: Database.Database | null = null;
  try {
    db = new Database(cookies, { readonly: true, fileMustExist: true });
    return AUTH_COOKIES.map(({ label, hostLike, names }) => {
      const placeholders = names.map(() => "?").join(",");
      const row = db!
        .prepare(
          `SELECT count(*) AS n FROM cookies
             WHERE host_key LIKE ? AND name IN (${placeholders})`
        )
        .get(hostLike, ...names) as { n: number } | undefined;
      return { label, signedIn: Boolean(row?.n) };
    });
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
