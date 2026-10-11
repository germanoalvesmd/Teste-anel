// Abre lab/saida/index.html no Chromium com um Bluetooth falso (R09 simulado),
// conecta, baixa os 7 dias e tira prints em lab/saida/prints/.
import { build } from "esbuild";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const pagina = join(raiz, "lab/saida/index.html");
if (!existsSync(pagina)) throw new Error("Rode antes: npm run build:lab");

const falso = await build({
  stdin: {
    contents: `
      import { AnelSimulado, bluetoothFalso } from "./src/lib/anel/testes/anel-simulado";
      import { paredeAgora } from "./src/lib/anel/cliente";
      const anel = new AnelSimulado({ agoraParede: paredeAgora(), atrasoMs: 2 });
      Object.defineProperty(navigator, "bluetooth", { value: bluetoothFalso(anel), configurable: true });
    `,
    resolveDir: raiz,
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  write: false,
});

const executavel = [
  "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell",
  "/opt/pw-browsers/chromium_headless_shell-1194/chrome-headless-shell-linux64/chrome-headless-shell",
].find(existsSync);
const navegador = await chromium.launch(executavel ? { executablePath: executavel } : {});
const prints = join(raiz, "lab/saida/prints");
mkdirSync(prints, { recursive: true });
const problemas = [];

for (const [nome, largura] of [["computador", 1200], ["celular", 390]]) {
  const ctx = await navegador.newContext({ viewport: { width: largura, height: 900 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => problemas.push(`${nome}: ${e.message}`));
  p.on("console", (m) => m.type() === "error" && !/fonts\.g/.test(m.text()) && problemas.push(`${nome}: ${m.text()}`));
  await p.addInitScript({ content: falso.outputFiles[0].text });
  await p.goto(pathToFileURL(pagina).href);
  await p.getByRole("button", { name: "Conectar anel" }).click();
  await p.getByText("76%", { exact: true }).waitFor({ timeout: 5000 });
  await p.getByRole("button", { name: "Baixar 7 dias" }).click();
  await p.getByRole("status").filter({ hasText: /Pronto\. Confira/ }).waitFor({ timeout: 30000 });
  await p.getByRole("button", { name: /Temperatura/ }).click();
  await p.getByRole("status").filter({ hasText: /bytes guardados/ }).waitFor({ timeout: 5000 });
  const linhas = await p.locator("tbody tr").count();
  if (linhas !== 7) problemas.push(`${nome}: tabela com ${linhas} linhas`);
  const rolagem = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (rolagem) problemas.push(`${nome}: a página rola para o lado`);
  const relatorio = await p.getByLabel("Relatório").inputValue();
  if (!/firmware 3\.10\.21/.test(relatorio) || !/Temperatura \(0x25/.test(relatorio)) problemas.push(`${nome}: relatório incompleto`);
  await p.screenshot({ path: join(prints, `${nome}.png`), fullPage: true });
  await ctx.close();
}
await navegador.close();

if (problemas.length) {
  console.error("Problemas:\n- " + problemas.join("\n- "));
  process.exit(1);
}
console.log("Página conferida no Chromium (computador e celular). Prints em lab/saida/prints/");
