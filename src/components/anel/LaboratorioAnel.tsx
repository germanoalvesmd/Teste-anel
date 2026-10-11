import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ClienteAnel,
  horasMinutos,
  resumirDias,
  textoMinuto,
  type ConexaoAnel,
  type Dia,
} from "../../lib/anel/cliente";
import { bluetoothDisponivel, conectarWebBluetooth } from "../../lib/anel/web-bluetooth";

type Estado = "desconectado" | "conectando" | "conectado" | "baixando";

export interface PropsLaboratorio {
  /** Abre a conexão. Padrão: Web Bluetooth. Nos testes: anel simulado. */
  conectar?: (todos: boolean) => Promise<ConexaoAnel>;
  temBluetooth?: boolean;
  prazoMs?: number;
}

const botao =
  "min-h-[44px] rounded-xl px-5 font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";
const botaoPrincipal = `${botao} bg-petroleo text-white hover:bg-petroleo/90`;
const botaoSecundario = `${botao} border border-borda bg-white text-petroleo hover:bg-nevoa`;

export function LaboratorioAnel({
  conectar = (todos) => conectarWebBluetooth({ todos }),
  temBluetooth = bluetoothDisponivel(),
  prazoMs,
}: PropsLaboratorio) {
  const [estado, setEstado] = useState<Estado>("desconectado");
  const [mensagem, setMensagem] = useState<string>("");
  const [erro, setErro] = useState<string>("");
  const [dias, setDias] = useState<Dia[]>([]);
  const [relatorio, setRelatorio] = useState("");
  const [copiado, setCopiado] = useState(false);
  const [, forcar] = useState(0);
  const cliente = useRef<ClienteAnel | null>(null);

  useEffect(() => () => void cliente.current?.desconectar(), []);

  const atualizarRelatorio = () => cliente.current && setRelatorio(cliente.current.relatorio());

  async function aoConectar(todos = false) {
    setErro("");
    setEstado("conectando");
    setMensagem("Escolha o anel na janela do Chrome…");
    try {
      const conexao = await conectar(todos);
      const c = new ClienteAnel(conexao, { prazoMs });
      cliente.current = c;
      conexao.aoDesconectar(() => {
        setEstado("desconectado");
        setMensagem("O anel desconectou.");
        atualizarRelatorio();
      });
      setEstado("conectado");
      setMensagem("Conectado. Lendo bateria…");
      await c.lerInfo();
      try {
        await c.lerBateria();
        setMensagem("Conectado.");
      } catch (e) {
        setMensagem(`Conectado, mas a bateria não respondeu: ${(e as Error).message}`);
      }
      atualizarRelatorio();
      forcar((n) => n + 1);
    } catch (e) {
      const texto = (e as Error).message ?? String(e);
      setEstado("desconectado");
      setMensagem("");
      setErro(
        /cancel/i.test(texto)
          ? "Nenhum anel escolhido. Se ele não apareceu, use “Não achei meu anel”."
          : `Não consegui conectar: ${texto}`,
      );
    }
  }

  async function aoBaixar() {
    const c = cliente.current;
    if (!c) return;
    setErro("");
    setEstado("baixando");
    try {
      const d = await c.baixarTudo((t) => {
        setMensagem(t);
        setDias([...c.dias]);
      });
      setDias([...d]);
      setMensagem("Pronto. Confira os números com o app QRing.");
      setEstado(c.conectado ? "conectado" : "desconectado");
    } catch (e) {
      setErro((e as Error).message);
      setEstado(c.conectado ? "conectado" : "desconectado");
    }
    atualizarRelatorio();
  }

  async function aoTemperatura() {
    const c = cliente.current;
    if (!c) return;
    setErro("");
    setEstado("baixando");
    setMensagem("Pedindo temperatura (experimental)…");
    try {
      const t = await c.lerTemperaturaBruta();
      setMensagem(t ? `Temperatura: ${t.split(" ").length} bytes guardados no relatório.` : "Temperatura: o anel respondeu vazio.");
    } catch (e) {
      setMensagem(`Temperatura: ${(e as Error).message}`);
    }
    setEstado(c.conectado ? "conectado" : "desconectado");
    atualizarRelatorio();
  }

  async function aoDesconectar() {
    await cliente.current?.desconectar();
    setEstado("desconectado");
    setMensagem("Desconectado.");
  }

  async function aoCopiar() {
    const texto = cliente.current?.relatorio() ?? relatorio;
    setRelatorio(texto);
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2500);
    } catch {
      setErro("Não consegui copiar sozinho. Selecione o texto do relatório abaixo e copie.");
    }
  }

  const c = cliente.current;
  const resumo = resumirDias(dias);
  const ligado = estado === "conectado" || estado === "baixando";
  const ocupado = estado === "baixando" || estado === "conectando";
  const hoje = dias[0];
  const ultimaNoite = dias.find((d) => d.sono)?.sono;

  return (
    <main className="min-h-screen bg-nevoa font-corpo text-petroleo">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <header className="mb-6">
          <p className="text-sm font-semibold uppercase tracking-wide text-mentaTexto">Onni · Laboratório</p>
          <h1 className="font-titulo text-3xl font-extrabold">Laboratório do anel</h1>
          <p className="mt-1 text-cinza">Conecte o anel QRing pelo Bluetooth do Chrome e confira os dados. Nada é salvo.</p>
        </header>

        {!temBluetooth && (
          <Aviso>
            Este navegador não tem Bluetooth web. Abra esta página no <b>Chrome do computador</b> ou no <b>Chrome do
            Android</b>. No iPhone nenhum navegador funciona.
          </Aviso>
        )}

        <section className="mb-6 rounded-2xl border border-borda bg-white p-5">
          <ol className="mb-4 list-decimal space-y-1 pl-5 text-cinza">
            <li>Deixe o anel carregado e perto do computador.</li>
            <li>No celular, feche o app QRing ou desligue o Bluetooth do celular.</li>
            <li>Clique em “Conectar anel” e escolha o <b>R09_F301</b>.</li>
            <li>Clique em “Baixar 7 dias”. Leva cerca de 1 minuto.</li>
          </ol>
          <div className="flex flex-wrap gap-3">
            {!ligado ? (
              <>
                <button className={botaoPrincipal} disabled={ocupado || !temBluetooth} onClick={() => aoConectar(false)}>
                  {estado === "conectando" ? "Conectando…" : "Conectar anel"}
                </button>
                <button className={botaoSecundario} disabled={ocupado || !temBluetooth} onClick={() => aoConectar(true)}>
                  Não achei meu anel
                </button>
              </>
            ) : (
              <>
                <button className={botaoPrincipal} disabled={ocupado} onClick={aoBaixar}>
                  {estado === "baixando" ? "Baixando…" : "Baixar 7 dias"}
                </button>
                <button className={botaoSecundario} disabled={ocupado} onClick={aoTemperatura}>
                  Temperatura (experimental)
                </button>
                <button className={botaoSecundario} disabled={estado === "baixando"} onClick={aoDesconectar}>
                  Desconectar
                </button>
              </>
            )}
            <button className={botaoSecundario} disabled={!c} onClick={aoCopiar}>
              {copiado ? "Copiado ✓" : "Copiar relatório"}
            </button>
          </div>
          {mensagem && (
            <p role="status" className="mt-4 rounded-xl bg-mentaClara px-4 py-3 text-mentaTexto">
              {mensagem}
            </p>
          )}
          {erro && <Aviso>{erro}</Aviso>}
        </section>

        {c && (
          <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Cartao rotulo="Anel" valor={c.info.nome ?? "?"} />
            <Cartao rotulo="Firmware" valor={c.info.firmware ?? "?"} />
            <Cartao rotulo="Bateria" valor={c.bateria ? `${c.bateria.nivel}%${c.bateria.carregando ? " ⚡" : ""}` : "?"} />
            <Cartao rotulo="Conexão" valor={ligado ? "Ligado" : "Desligado"} />
          </section>
        )}

        {resumo.length > 0 && (
          <section className="mb-6 rounded-2xl border border-borda bg-white p-5">
            <h2 className="mb-3 font-titulo text-xl font-bold">Últimos 7 dias</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-cinza">
                  <tr className="border-b border-borda">
                    <th className="py-2 pr-3">Dia</th>
                    <th className="py-2 pr-3">Passos</th>
                    <th className="py-2 pr-3">Distância</th>
                    <th className="py-2 pr-3">FC mín / méd / máx</th>
                    <th className="py-2 pr-3">SpO2 méd.</th>
                    <th className="py-2 pr-3">Sono</th>
                    <th className="py-2 pr-3">HRV méd.</th>
                    <th className="py-2">Estresse</th>
                  </tr>
                </thead>
                <tbody>
                  {resumo.map((r) => (
                    <tr key={r.dia} className="border-b border-borda/60 last:border-0" data-testid={`dia-${r.diasAtras}`}>
                      <td className="py-2 pr-3 font-semibold">{r.diasAtras === 0 ? `Hoje (${r.dia.slice(0, 5)})` : r.dia.slice(0, 5)}</td>
                      <td className="py-2 pr-3">{r.passos?.toLocaleString("pt-BR") ?? "–"}</td>
                      <td className="py-2 pr-3">{r.distanciaKm ? `${r.distanciaKm.replace(".", ",")} km` : "–"}</td>
                      <td className="py-2 pr-3">
                        {r.fcLeituras ? `${r.fcMin} / ${r.fcMedia} / ${r.fcMax}` : "–"}
                        {r.fcLeituras > 0 && <span className="text-cinza"> ({r.fcLeituras})</span>}
                      </td>
                      <td className="py-2 pr-3">{r.spo2Media ? `${r.spo2Media}%` : "–"}</td>
                      <td className="py-2 pr-3">{r.sonoTexto ?? "–"}</td>
                      <td className="py-2 pr-3">{r.hrvMedia ? `${r.hrvMedia} ms` : "–"}</td>
                      <td className="py-2">
                        {r.estresseMedia ?? "–"}
                        {r.erros > 0 && <span className="ml-2 rounded bg-ambarFundo px-1.5 text-ambar">{r.erros} aviso(s)</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-cinza">
              Estimativas de um aparelho de bem-estar, não exames. HRV e estresse: formato ainda não confirmado no R09.
            </p>
          </section>
        )}

        {hoje?.fc && hoje.fc.leituras.length > 0 && (
          <section className="mb-6 rounded-2xl border border-borda bg-white p-5">
            <h2 className="mb-3 font-titulo text-xl font-bold">Frequência cardíaca de hoje</h2>
            <GraficoFc pontos={hoje.fc.leituras} />
          </section>
        )}

        {ultimaNoite && (
          <section className="mb-6 rounded-2xl border border-borda bg-white p-5">
            <h2 className="mb-1 font-titulo text-xl font-bold">Última noite</h2>
            <p className="mb-3 text-cinza">
              De {textoMinuto(ultimaNoite.inicioMin)} a {textoMinuto(ultimaNoite.fimMin)}
            </p>
            <div className="flex flex-wrap gap-2">
              {(["profundo", "leve", "rem", "acordado"] as const).map((e) => {
                const min = ultimaNoite.trechos.filter((t) => t.estagio === e).reduce((a, t) => a + t.minutos, 0);
                return <Cartao key={e} rotulo={e === "rem" ? "REM" : e[0]!.toUpperCase() + e.slice(1)} valor={horasMinutos(min)} />;
              })}
            </div>
          </section>
        )}

        {c && (c.notas.length > 0 || dias.some((d) => d.erros.length)) && (
          <section className="mb-6 rounded-2xl border border-[#F0D9BF] bg-ambarFundo p-5 text-ambar">
            <h2 className="mb-2 font-titulo text-lg font-bold">Avisos</h2>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {c.notas.map((n, i) => (
                <li key={`n${i}`}>{n}</li>
              ))}
              {dias.flatMap((d) => d.erros.map((e, i) => <li key={`${d.diasAtras}-${i}`}>{`${d.diasAtras === 0 ? "Hoje" : `${d.diasAtras} dia(s) atrás`}: ${e}`}</li>))}
            </ul>
          </section>
        )}

        {relatorio && (
          <section className="rounded-2xl border border-borda bg-white p-5">
            <h2 className="mb-2 font-titulo text-lg font-bold">Relatório</h2>
            <p className="mb-2 text-sm text-cinza">Só números e bytes do anel. Pode colar na conversa com o Claude.</p>
            <textarea
              readOnly
              aria-label="Relatório"
              value={relatorio}
              className="h-56 w-full rounded-xl border border-borda bg-nevoa p-3 font-mono text-xs text-petroleo"
              onFocus={(e) => e.currentTarget.select()}
            />
          </section>
        )}
      </div>
    </main>
  );
}

function Cartao({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="min-w-[110px] rounded-2xl border border-borda bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-cinza">{rotulo}</p>
      <p className="font-titulo text-lg font-bold">{valor}</p>
    </div>
  );
}

function Aviso({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-4 mb-4 rounded-xl border border-[#F0D9BF] bg-ambarFundo px-4 py-3 text-ambar">
      {children}
    </p>
  );
}

function GraficoFc({ pontos }: { pontos: { minuto: number; valor: number }[] }) {
  const min = Math.min(...pontos.map((p) => p.valor)) - 5;
  const max = Math.max(...pontos.map((p) => p.valor)) + 5;
  const x = (m: number) => (m / 1440) * 1000;
  const y = (v: number) => 160 - ((v - min) / (max - min)) * 150;
  const caminho = pontos.map((p, i) => `${i ? "L" : "M"}${x(p.minuto).toFixed(1)},${y(p.valor).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 1000 185" className="w-full" role="img" aria-label="Gráfico da frequência cardíaca de hoje">
      {[0, 6, 12, 18, 24].map((h) => (
        <g key={h}>
          <line x1={x(h * 60)} x2={x(h * 60)} y1={0} y2={165} stroke="#D7E3E2" />
          <text x={Math.min(x(h * 60) + 4, 960)} y={182} fontSize="14" fill="#4A6870">
            {String(h).padStart(2, "0")}h
          </text>
        </g>
      ))}
      <path d={caminho} fill="none" stroke="#3DCA98" strokeWidth="2.5" strokeLinejoin="round" />
      <text x={4} y={14} fontSize="14" fill="#4A6870">
        {max - 5} bpm
      </text>
      <text x={4} y={158} fontSize="14" fill="#4A6870">
        {min + 5} bpm
      </text>
    </svg>
  );
}
