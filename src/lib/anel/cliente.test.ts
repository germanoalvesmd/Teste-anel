import { describe, expect, it } from "vitest";
import {
  ClienteAnel,
  ErroDesconectado,
  ErroPrazo,
  meiaNoiteParede,
  paredeAgora,
  resumirDias,
  textoDia,
  textoHora,
} from "./cliente";
import { CMD } from "./protocolo";
import { AnelSimulado, conexaoSimulada, type OpcoesSimulado } from "./testes/anel-simulado";

// "Agora" local: 11/10/2026 14:30 no fuso de quem roda o teste.
const agoraLocal = () => new Date(2026, 9, 11, 14, 30, 0);

function montar(o: Partial<OpcoesSimulado> = {}, prazoMs = 300) {
  const anel = new AnelSimulado({ agoraParede: paredeAgora(agoraLocal()), ...o });
  const conexao = conexaoSimulada(anel);
  const cliente = new ClienteAnel(conexao, { prazoMs, agora: agoraLocal });
  return { anel, conexao, cliente };
}

describe("hora de parede", () => {
  it("copia a hora local para os campos UTC, em qualquer fuso", () => {
    const p = paredeAgora(agoraLocal());
    expect(textoDia(p)).toBe("11/10/2026");
    expect(textoHora(p)).toBe("14:30");
    expect(meiaNoiteParede(0, agoraLocal()).getTime()).toBe(Date.UTC(2026, 9, 11));
    expect(meiaNoiteParede(11, agoraLocal()).getTime()).toBe(Date.UTC(2026, 8, 30));
  });

  it("perto da meia-noite não troca de dia", () => {
    const tarde = new Date(2026, 9, 11, 23, 59, 59);
    expect(textoDia(meiaNoiteParede(0, tarde))).toBe("11/10/2026");
    const cedo = new Date(2026, 9, 11, 0, 0, 1);
    expect(textoDia(meiaNoiteParede(0, cedo))).toBe("11/10/2026");
  });
});

describe("ClienteAnel", () => {
  it("lê a bateria e ignora pacotes de outro assunto", async () => {
    const { cliente } = montar({ ruido: true });
    expect(await cliente.lerBateria()).toEqual({ nivel: 76, carregando: false });
  });

  it("pede a frequência cardíaca do dia certo", async () => {
    const { cliente, anel } = montar();
    const fc = await cliente.fcDoDia(2);
    expect(fc.inicioAnel).toBe(Date.UTC(2026, 9, 9) / 1000);
    expect(anel.pedidos.at(-1)!.bytes[0]).toBe(CMD.FC_HISTORICO);
  });

  it("hoje só tem frequência cardíaca até agora", async () => {
    const { cliente } = montar();
    const fc = await cliente.fcDoDia(0);
    expect(Math.max(...fc.leituras.map((l) => l.minuto))).toBeLessThan(14 * 60 + 30);
  });

  it("faz um pedido por vez, na ordem", async () => {
    const { cliente, anel } = montar({ atrasoMs: 5 });
    const r = await Promise.all([cliente.lerBateria(), cliente.passosDoDia(0), cliente.fcDoDia(1)]);
    expect(r[0].nivel).toBe(76);
    expect(r[1].length).toBeGreaterThan(0);
    expect(r[2].leituras.length).toBeGreaterThan(0);
    expect(anel.pedidos.map((p) => p.bytes[0])).toEqual([CMD.BATERIA, CMD.PASSOS_DIA, CMD.FC_HISTORICO]);
  });

  it("dá erro de prazo quando o anel fica calado, e o próximo pedido funciona", async () => {
    const { cliente } = montar({ semHrv: true }, 50);
    await expect(cliente.hrvDoDia(0)).rejects.toBeInstanceOf(ErroPrazo);
    expect((await cliente.lerBateria()).nivel).toBe(76);
  });

  it("cancela o pedido pendente se o anel desconectar", async () => {
    const { cliente, conexao } = montar({ semHrv: true }, 5000);
    const p = cliente.hrvDoDia(0);
    conexao.derrubar();
    await expect(p).rejects.toBeInstanceOf(ErroDesconectado);
    await expect(cliente.lerBateria()).rejects.toBeInstanceOf(ErroDesconectado);
  });

  it("anel recusa comando desconhecido", async () => {
    const { anel } = montar();
    const r = anel.responder("comandos", new Uint8Array(16).fill(0).map((_, i) => (i === 0 ? 0x22 : 0)));
    expect(r[0]![0]).toBe(0xa2);
  });

  it("baixa 7 dias e resume", async () => {
    const { cliente } = montar();
    const passos: string[] = [];
    const dias = await cliente.baixarTudo((t) => passos.push(t));
    expect(dias.length).toBe(7);
    expect(passos.at(-1)).toBe("Pronto.");
    const r = resumirDias(dias);
    expect(r[0]!.dia).toBe("11/10/2026");
    expect(r[1]!.dia).toBe("10/10/2026");
    expect(r[1]!.fcLeituras).toBe(271);
    expect(r[1]!.passos).toBeGreaterThan(0);
    expect(r[1]!.spo2Media).toBe(96);
    expect(r[1]!.sonoTexto).toBe("5h55");
    expect(r[3]!.sonoTexto).toBeUndefined();
    expect(r[1]!.hrvMedia).toBeGreaterThan(0);
    expect(r.every((d) => d.erros === 0)).toBe(true);
    expect(cliente.info.firmware).toBe("3.10.21");
  });

  it("anel sem HRV: pula os outros dias depois da primeira falha", async () => {
    const { cliente, anel } = montar({ semHrv: true }, 40);
    await cliente.baixarTudo();
    expect(anel.pedidos.filter((p) => p.bytes[0] === CMD.HRV).length).toBe(1);
    expect(cliente.notas.join(" ")).toMatch(/HRV/);
  });

  it("anel sem Big Data: segue sem sono e oxigenação", async () => {
    const { cliente } = montar({ semBigData: true });
    const dias = await cliente.baixarTudo();
    expect(dias[1]!.sono).toBeUndefined();
    expect(cliente.notas.join(" ")).toMatch(/Big Data/);
  });

  it("dia sem frequência cardíaca não é erro", async () => {
    const { cliente } = montar({ diasSemFc: [3] });
    const dias = await cliente.baixarTudo();
    expect(dias[3]!.fc!.leituras).toEqual([]);
    expect(dias[3]!.erros).toEqual([]);
  });

  it("lê a temperatura crua (experimental)", async () => {
    const { cliente } = montar();
    expect(await cliente.lerTemperaturaBruta()).toBe("01 22 0e 22 10 00 00");
  });

  it("relatório tem números e bytes, e nenhum dado pessoal", async () => {
    const { cliente } = montar();
    await cliente.baixarTudo();
    const t = cliente.relatorio("Teste/1.0");
    expect(t).toMatch(/R09_F301 · firmware 3\.10\.21/);
    expect(t).toMatch(/Bateria: 76%/);
    expect(t).toMatch(/10\/10\/2026: passos \d+/);
    expect(t).toMatch(/> C  15 /);
    expect(t).not.toMatch(/@|senha|e-mail/i);
  });

  it("nunca manda comando de acertar relógio nem de configuração", async () => {
    const { cliente, anel } = montar();
    await cliente.baixarTudo();
    await cliente.lerTemperaturaBruta();
    const usados = new Set(anel.pedidos.filter((p) => p.canal === "comandos").map((p) => p.bytes[0]));
    expect([...usados].sort()).toEqual([CMD.BATERIA, CMD.FC_HISTORICO, CMD.ESTRESSE, CMD.HRV, CMD.PASSOS_DIA].sort());
    // Big Data: só pedidos de leitura (0xbc)
    expect(anel.pedidos.filter((p) => p.canal === "bigdata").every((p) => p.bytes[0] === 0xbc)).toBe(true);
  });
});
