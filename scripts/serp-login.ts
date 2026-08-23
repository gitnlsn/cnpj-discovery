/**
 * Opens the crawler's Chrome profile so a person can sign in.
 *
 * ## Why this is a separate script and not a flag on the crawler
 *
 * Google's sign-in flow refuses browsers driven by the DevTools protocol — you
 * reach "este navegador ou app pode não ser seguro" and the flow dead-ends. The
 * two anti-automation flags in `index.ts` do not clear that gate, and no
 * reasonable amount of flag-tuning does: it is checked server-side against
 * signals we are not going to fake.
 *
 * So the login happens in a Chrome that Puppeteer never touches. Same profile
 * directory, same binary, no CDP port, no `--enable-automation`, nothing
 * listening. Chrome writes the session cookies into `Default/Cookies` exactly as
 * it would for any other window, and the next crawl inherits them because it
 * opens the same `userDataDir`.
 *
 * ## What signing in buys, and what it costs
 *
 * Buys: fewer interstitials on Google, and on LinkedIn it is the difference
 * between an auth wall and a page — LinkedIn shows almost nothing to a signed-out
 * client.
 *
 * Costs: every request is now attributable to one identity. A signed-out block is
 * IP reputation that decays on its own; a signed-in block is an account that gets
 * restricted, and LinkedIn restricts permanently rather than temporarily. That is
 * why the guidance below says throwaway account, and why it is printed every time
 * rather than buried in a README nobody re-reads.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { profileDir, chromePath, MAC_CHROME } from "@cnpj/serp";
import { sessionStatus } from "@cnpj/serp";

/**
 * Is some other Chrome already holding this profile?
 *
 * Two Chromes cannot share a `user-data-dir`: the second either refuses to start
 * or attaches to the first and exits immediately, and in both cases the person
 * ends up typing their password into a window that is not the one we opened.
 * Checking the process table is cruder than reading Chrome's own lock file but
 * works regardless of how the holder was started — which matters because the
 * usual holder is a Puppeteer run that is still going.
 */
function profileHolder(dir: string): string | null {
  try {
    const out = execFileSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (!line.includes(dir)) continue;
      if (!/Google Chrome|chrome/i.test(line)) continue;
      // The helper processes carry the same directory on their command line;
      // only the browser process is worth naming, and it is the one without a
      // --type= flag.
      if (line.includes("--type=")) continue;
      const pid = line.trim().split(/\s+/)[0];
      if (pid) return pid;
    }
    return null;
  } catch {
    // No `ps`, or it refused. Not a reason to block the login — Chrome itself
    // will refuse if the profile is genuinely busy.
    return null;
  }
}

function main(): void {
  const dir = profileDir();
  const chrome = chromePath();

  if (!chrome) {
    console.error(
      `não encontrei o Chrome.\n` +
        `  esperado em: ${MAC_CHROME}\n` +
        `  defina SERP_CHROME_PATH se ele estiver em outro lugar.`
    );
    process.exit(1);
  }

  const holder = profileHolder(dir);
  if (holder) {
    console.error(
      `o perfil já está aberto em outro Chrome (pid ${holder}).\n` +
        `\n` +
        `  Duas instâncias não podem dividir o mesmo perfil: a segunda janela ou\n` +
        `  não abre, ou é a primeira que aparece — e aí você digita a senha na\n` +
        `  janela errada e o login não vai para este perfil.\n` +
        `\n` +
        `  Pare a busca que está rodando (ou feche aquela janela) e rode de novo.`
    );
    process.exit(1);
  }

  console.log(
    `\nAbrindo o perfil do crawler para você entrar nas contas.\n` +
      `  perfil: ${dir}\n` +
      `  chrome: ${chrome}\n` +
      `\n` +
      `USE UMA CONTA DESCARTÁVEL, não a sua.\n` +
      `  O LinkedIn responde a automação restringindo a conta, e a restrição dele\n` +
      `  é permanente — diferente do Google, onde o bloqueio é do IP e passa\n` +
      `  sozinho. A conta que abrir esta janela é a que assume esse risco.\n` +
      `\n` +
      `Entre no Google e/ou no LinkedIn nas abas que vão abrir, e FECHE o Chrome\n` +
      `quando terminar. Eu confiro os cookies depois que ele fechar.\n`
  );

  // No automation flags of any kind, on purpose — see the docblock. `--lang` and
  // the first-run suppressors match the crawler's launch so the profile does not
  // flip locale between a login and a run.
  const child = spawn(
    chrome,
    [
      `--user-data-dir=${dir}`,
      "--profile-directory=Default",
      "--lang=pt-BR",
      "--no-first-run",
      "--no-default-browser-check",
      "https://accounts.google.com/",
      "https://www.linkedin.com/login",
    ],
    { stdio: "ignore", detached: false }
  );

  child.on("error", (err) => {
    console.error(`não consegui abrir o Chrome: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", () => {
    // Chrome flushes cookies on exit, so this has to run after it closes — a
    // check while it is still open reports the state from before the login.
    const status = sessionStatus(dir);
    if (!status) {
      console.log(`\nChrome fechou. Não consegui ler os cookies do perfil para conferir.`);
      return;
    }
    console.log(`\nChrome fechou. Situação do perfil:`);
    for (const { label, signedIn } of status) {
      console.log(`  ${signedIn ? "✅" : "—"} ${label}: ${signedIn ? "logado" : "sem sessão"}`);
    }
    const linkedin = status.find((s) => s.label === "LinkedIn");
    if (linkedin?.signedIn) {
      console.log(
        `\nO crawler do LinkedIn ainda precisa de LINKEDIN_ENABLED=1 para rodar —\n` +
          `estar logado não liga a feature, e isso é de propósito.`
      );
    }
  });
}

main();
