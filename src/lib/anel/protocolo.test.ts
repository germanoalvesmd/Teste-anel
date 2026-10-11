import { describe, expect, it } from "vitest";
import {
  CMD,
  TIPO_BIG_DATA,
  ehErroDoComando,
  hex,
  leitorBigData,
  leitorFc,
  leitorPassos,
  leitorSerie30,
  lerBateria,
  lerSono,
  lerSpo2,
  montarPacote,
  pacoteValido,
  pedidoBigData,
  pedidoFcDia,
  pedidoPassosDia,
  type Leitor,
} from "./protocolo";
import { AnelSimulado } from "./testes/anel-simulado";

function ate<T>(leitor: Leitor<T>, pacotes: Uint8Array[]): T {
  for (const p of pacotes) {
    const r = leitor.receber(p);
    if (r.fim) return r.valor;
  }
  throw new Error("leitor não terminou");
}

const agora = new Date(Date.UTC(2026, 9, 11, 14, 30));
const anel = () => new AnelSimulado({ agoraParede: agora });

describe("pacotes", () => {
  it("tem 16 bytes e soma de verificação no fim", () => {
    const p = montarPacote(CMD.BATERIA);
    expect(p.length).toBe(16);
    expect(hex(p)).toBe("03 00 00 00 00 00 00 00 00 00 00 00 00 00 00 03");
    expect(pacoteValido(p)).toBe(true);
    p[3] = 9;
    expect(pacoteValido(p)).toBe(false);
  });

  it("recusa mais de 14 bytes de dados", () => {
    expect(() => montarPacote(1, new Array(15).fill(0))).toThrow();
  });

  it("reconhece a recusa do anel (bit 0x80)", () => {
    expect(ehErroDoComando(montarPacote(0x95), 0x15)).toBe(true);
    expect(ehErroDoComando(montarPacote(0x15), 0x15)).toBe(false);
  });

  it("lê a bateria", () => {
    expect(lerBateria(montarPacote(3, [64, 1]))).toEqual({ nivel: 64, carregando: true });
  });

  it("pede passos com o dia e os bytes fixos", () => {
    expect(hex(pedidoPassosDia(2).subarray(0, 6))).toBe("43 02 0f 00 5f 01");
  });

  it("pede frequência cardíaca com a meia-noite em segundos (little-endian)", () => {
    const p = pedidoFcDia(Date.UTC(2026, 9, 11));
    const s = Date.UTC(2026, 9, 11) / 1000;
    expect(p[1]! | (p[2]! << 8) | (p[3]! << 16) | (p[4]! << 24)).toBe(s);
  });
});

describe("frequência cardíaca", () => {
  it("junta 24 pacotes e põe cada leitura no minuto certo", () => {
    const pedido = pedidoFcDia(Date.UTC(2026, 9, 10));
    const r = ate(leitorFc(), anel().responder("comandos", pedido));
    expect(r.intervaloMin).toBe(5);
    expect(r.inicioAnel).toBe(Date.UTC(2026, 9, 10) / 1000);
    expect(r.leituras[0]).toEqual({ minuto: 0, valor: 58 + 7 });
    expect(r.leituras.every((l) => l.minuto < 1440 && l.minuto % 5 === 0)).toBe(true);
    // 288 menos as falhas simuladas (a cada 17 a partir do 3)
    expect(r.leituras.length).toBe(288 - 17);
  });

  it("sem dados: 0xff encerra vazio", () => {
    expect(ate(leitorFc(), [montarPacote(0x15, [0xff])]).leituras).toEqual([]);
  });
});

describe("passos", () => {
  it("lê data em BCD, quarto de hora, passos e distância", () => {
    const r = ate(leitorPassos(), anel().responder("comandos", pedidoPassosDia(1)));
    expect(r.caloriasX10).toBe(true);
    expect(r.quartos[0]).toMatchObject({ ano: 2026, mes: 10, dia: 10, quarto: 28, passos: 200 + 28 * 5 + 11 });
    expect(r.quartos.length).toBe(30);
  });
});

describe("HRV / estresse", () => {
  it("põe cada valor a cada 30 minutos", () => {
    const r = ate(leitorSerie30(), anel().responder("comandos", montarPacote(CMD.HRV, [1])));
    expect(r.length).toBe(48);
    expect(r[0]).toEqual({ minuto: 0, valor: 41 });
    expect(r[12]).toEqual({ minuto: 360, valor: 41 });
    expect(r.at(-1)!.minuto).toBe(1410);
  });
});

describe("Big Data", () => {
  it("monta o pedido", () => {
    expect(hex(pedidoBigData(TIPO_BIG_DATA.SONO))).toBe("bc 27 01 00 ff 00 ff");
  });

  it("junta pedaços e ignora lixo antes do cabeçalho", () => {
    const pedacos = anel().responder("bigdata", pedidoBigData(TIPO_BIG_DATA.SPO2));
    expect(pedacos.length).toBeGreaterThan(5);
    const dados = ate(leitorBigData(TIPO_BIG_DATA.SPO2), [new Uint8Array([1, 2, 3]), ...pedacos]);
    expect(dados.length).toBe(7 * 49);
    const horas = lerSpo2(dados);
    expect(horas.filter((h) => h.diasAtras === 3).length).toBe(7);
    expect(horas[0]).toEqual({ diasAtras: 6, hora: 0, minimo: 94, maximo: 97 });
  });

  it("lê as noites de sono", () => {
    const dados = ate(leitorBigData(TIPO_BIG_DATA.SONO), anel().responder("bigdata", pedidoBigData(TIPO_BIG_DATA.SONO)));
    const noites = lerSono(dados);
    expect(noites.map((n) => n.diasAtras)).toEqual([2, 1, 0]);
    expect(noites[0]).toMatchObject({ inicioMin: 1380, fimMin: 400 });
    expect(noites[0]!.trechos[0]).toEqual({ estagio: "leve", minutos: 40 });
    expect(noites[0]!.trechos.length).toBe(7);
  });

  it("dado de sono cortado não estoura", () => {
    expect(() => lerSono(new Uint8Array([2, 0, 20, 0x10]))).not.toThrow();
  });
});
