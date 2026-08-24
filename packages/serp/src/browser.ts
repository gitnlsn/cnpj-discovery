import { launch, type Browser, type Page } from "puppeteer-core";

/**
 * Opening the real Chrome, once, in one place.
 *
 * Extracted when a second driver needed it. The flags and the `navigator.webdriver`
 * patch are not preferences — they are the difference between a session that looks
 * like a person's and one that announces itself — so two copies drifting apart
 * would mean one driver quietly being more detectable than the other. Same
 * argument as `company-row.ts`: a field added to one path and forgotten in the
 * other looks like bad luck rather than a bug.
 */
export interface LaunchOptions {
  userDataDir: string;
  executablePath?: string;
  headless?: boolean;
}

export async function launchProfileBrowser(opts: LaunchOptions): Promise<Browser> {
  return launch({
    headless: opts.headless ?? false,
    // The installed Chrome, not a downloaded Chromium: puppeteer-core ships no
    // browser, which keeps ~300 MB out of the install.
    channel: opts.executablePath ? undefined : "chrome",
    executablePath: opts.executablePath,
    userDataDir: opts.userDataDir,
    defaultViewport: null,
    args: [
      "--lang=pt-BR",
      "--disable-blink-features=AutomationControlled",
      // Puppeteer's defaults include flags no ordinary Chrome ever sets; these
      // two are the ones that show up in fingerprinting.
      "--no-default-browser-check",
      "--no-first-run",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });
}

/**
 * The one property worth hiding.
 *
 * `navigator.webdriver` is set by the DevTools protocol itself, so the launch
 * flag does not clear it, and it is the single most-checked property there is.
 *
 * This is where the stealth work stops, on purpose. Patching something trivially
 * observable is housekeeping; shipping a fingerprint-spoofing plugin is a
 * treadmill that breaks on somebody else's release schedule and still loses to IP
 * reputation. If Google keeps refusing, the answer is to ask less often.
 */
export async function hardenPage(page: Page): Promise<void> {
  await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
}

/** A profile can only be opened by one Chrome at a time — see `JobLane`. */
export class ProfileBusyError extends Error {
  constructor(dir: string) {
    super(
      `O perfil ${dir} já está aberto em outro Chrome. Feche-o, ou use um ` +
        `userDataDir diferente — o Puppeteer não abre o mesmo perfil duas vezes.`
    );
    this.name = "ProfileBusyError";
  }
}
