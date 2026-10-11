// Monta a página em UM arquivo: lab/saida/index.html (JS e CSS dentro do HTML).
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");

const js = await build({
  entryPoints: [join(raiz, "lab/entrada.tsx")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "chrome100",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
  legalComments: "none",
});
const codigo = js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

const css = execFileSync(
  join(raiz, "node_modules/.bin/tailwindcss"),
  ["-c", join(raiz, "tailwind.config.cjs"), "-i", join(raiz, "lab/estilos.css"), "--minify"],
  { cwd: raiz, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
);

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Laboratório do anel · Onni</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800&family=Nunito+Sans:wght@400;600&display=swap">
<style>${css}</style>
</head>
<body class="bg-nevoa">
<div id="raiz"></div>
<script>${codigo}</script>
</body>
</html>
`;

mkdirSync(join(raiz, "lab/saida"), { recursive: true });
writeFileSync(join(raiz, "lab/saida/index.html"), html);
console.log(`lab/saida/index.html pronto (${Math.round(html.length / 1024)} KB)`);
