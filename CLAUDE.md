# Laboratório do anel — Onni Health Hub

Contexto para o Claude Code. Leia inteiro antes de mexer no código.

## Quem e o quê

- **Onni Health Hub** é um app de saúde da família (exames, vacinas, crescimento, composição corporal, remédios) do Dr. Germano Alves, médico em Cuiabá. Empresa: GP SERVIÇOS E SAÚDE LTDA. Domínio: onnihub.com.br.
- O app principal é feito no **Lovable** (TanStack Start com renderização no servidor + Supabase, projeto `healthmem-dev`). Repositório: `germanoalvesmd/healthmem`, ramo `main` (o Lovable lê desse ramo — **nunca** envie nada para o `main` sem o Germano pedir).
- **Este repositório** é um laboratório separado: ler o anel inteligente do Germano direto pelo Bluetooth, sem o app do fabricante, e só depois levar o código para o Onni.

## Como conversar com o Germano

- Sempre em **português**, com passos simples e numerados. Ele se descreve como "meio lento" com tecnologia.
- **Uma pergunta por vez.** Não invente respostas; quando não souber, diga e proponha como descobrir.
- Ele é médico e nutricionista: termos clínicos são ok; termos de programação, explique em uma frase.
- Nunca peça para ele colar senha ou chave na conversa.

## O anel

- Modelo **R09_F301** (Colmi R09, família "QRing"), firmware **3.10.21**. O app do fabricante é o QRing (Shenzhen Qingcheng / Yawell).
- O QRing grava quase nada no app Saúde do iPhone, por isso a decisão foi ler o anel direto (caminho 2). Mais tarde, com a empresa maior, negociar o SDK oficial com o fabricante (caminho 3).
- O anel conversa com **um aparelho por vez**: para testar, fechar o QRing no celular ou desligar o Bluetooth do celular.
- Guarda uns **7 dias** de histórico e depois sobrescreve.
- O R09 tem sensor de **temperatura da pele**. O formato não é público; há um botão experimental que pede o tipo Big Data `0x25` (suspeita, não confirmada) e guarda os bytes crus no relatório.

## Arquitetura

```
src/lib/anel/protocolo.ts      bytes: monta pedidos e lê respostas (sem Bluetooth, sem tela)
src/lib/anel/cliente.ts        ClienteAnel: um pedido por vez, prazos, cancelamento ao desconectar,
                               "hora de parede", relatório. Depende só da interface ConexaoAnel.
src/lib/anel/web-bluetooth.ts  ConexaoAnel pelo Web Bluetooth (Chrome/Edge no computador, Chrome no Android)
src/components/anel/LaboratorioAnel.tsx   página de teste (React + Tailwind)
src/lib/anel/testes/           anel simulado (também vira um navigator.bluetooth falso para o check:lab)
ui/                            teste da página com o anel simulado (jsdom)
lab/                           monta a página em UM arquivo HTML (lab/saida/index.html) e confere no Chromium
```

- No iPhone nenhum navegador tem Web Bluetooth. A etapa do iPhone será um adaptador `ConexaoAnel` com `@capacitor-community/bluetooth-le` dentro de um app Capacitor — o resto do código não muda.
- Dois canais GATT: comandos de 16 bytes (`6e40fff0-…`, escrita `6e400002`, notificação `6e400003`) e "Big Data" para sono/oxigenação (`de5bf728-…`, escrita `de5bf72a`, notificação `de5bf729`).

## Regras que não se negociam

1. **Só leitura.** Nunca acertar o relógio do anel (o QRing faz isso) e nunca gravar configuração nele.
2. **Hora de parede.** O anel guarda o horário que o QRing ajustou (hora local). Datas do anel são tratadas como hora de parede, guardadas nos campos UTC de `Date`. Veja `paredeAgora`, `meiaNoiteParede`, `textoDia`, `textoHora` em `cliente.ts`. Os testes rodam em vários fusos (`TZ=America/Cuiaba`, `Asia/Tokyo`, `UTC`) e precisam continuar passando.
3. **Licenças.** O protocolo foi adaptado de dois projetos MIT (openring e colmi_r02_client); mantenha `src/lib/anel/CREDITOS.md` junto do código. **Não copie** código do Gadgetbridge (AGPL — obrigaria abrir o Onni inteiro) nem do ring-set (licença não comercial). Ler para entender o protocolo é ok; o código tem que ser nosso.
4. **Nada é salvo** nesta etapa. O relatório leva números e bytes, sem nome, e-mail ou dados de cadastro.
5. **Visual da marca:** petróleo `#0B4D5B`, menta `#3DCA98`, lavanda `#B6A8F0`, névoa `#F3F8F7`, menta clara `#DDF5EC`, lavanda clara `#EEEAFD`, texto menta `#13704F`, cinza `#4A6870`, âmbar `#9A4A0B` sobre `#FDF0E1`, borda `#D7E3E2`. Fontes Nunito e Nunito Sans. **Nunca vermelho.** Botões com 44 px de altura no mínimo.
6. Números do anel são **estimativas de um aparelho de bem-estar**, não exames. Dado de saúde é dado sensível na LGPD.

## Comandos

```bash
npm install
npm test             # 35 testes (protocolo, cliente com anel simulado, página)
npm run test:fusos   # os mesmos testes em America/Cuiaba, Asia/Tokyo e UTC
npm run typecheck
npm run build:lab    # gera lab/saida/index.html (um arquivo só, ~180 KB)
npm run check:lab    # abre a página no Chromium com um "Bluetooth falso" (R09 simulado) e tira prints
```

Antes de entregar qualquer mudança: `npm test`, `npm run typecheck`, `npm run build:lab` e `npm run check:lab` sem erros.

## Onde estamos

- [x] Protocolo, cliente e página reconstruídos (out/2026) e testados com anel simulado. A captura real do R02 e `docs/` antigos não vieram para este repositório.
- Sem confirmação no R09: cabeçalho dos passos, HRV (0x39) e estresse (0x37) com o byte de "dias atrás", e a temperatura 0x25.
- [ ] **Testar com o anel de verdade** (R09_F301). O Germano abre a página no Chrome do computador, conecta, baixa os dados e manda o "relatório" (botão Copiar relatório). Compare os números com o app QRing.
- [ ] Publicar a página num link fixo (ideia: repositório público `onni-laboratorio-anel` com GitHub Pages). Web Bluetooth exige https; não funciona dentro da pré-visualização do Lovable (iframe).
- [ ] Decifrar a temperatura do R09 a partir dos bytes crus do relatório.
- [ ] Pendências conhecidas: passos com cabeçalho dizendo 0 registros (formato não confirmado; hoje vira espera até o prazo); anéis sem HRV fazem a busca de 7 dias pular o HRV depois da primeira falha; unidade das calorias não confirmada (não mostramos calorias).

## Próximas etapas (depois que o anel real funcionar)

1. **Levar para o Onni** (instruções em `docs/levar-para-o-onni.md`): rota `/laboratorio/anel` só para super admin, renderizada só no cliente.
2. **Salvar no Supabase** e mostrar no bloco "Seus números" da tela inicial (um número aparece uma vez só). Sincronizar pelo menos a cada 7 dias; aviso em "Para agora" se passar de 3 dias sem sincronizar. Gravar a versão do firmware em cada leitura.
3. **App do iPhone** com Capacitor: o Onni usa TanStack Start (SSR) — o Capacitor precisa de build estático (modo SPA) ou de abrir o site remoto; risco de rejeição da Apple (regra 4.2) para app que é só site embrulhado, e o Bluetooth/HealthKit ajudam a justificar. Regras da Apple para dados de saúde: nada de propaganda com eles, nada no iCloud.

Pesquisa e fontes: `docs/pesquisa.md`.
