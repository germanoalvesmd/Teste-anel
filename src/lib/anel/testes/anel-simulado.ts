// Anel R09 simulado: responde aos pedidos com dados inventados e previsíveis.
// Serve para testes (Node/jsdom) e para conferir a página no Chromium.
import type { ConexaoAnel } from "../cliente";
import { BIG_DATA, BIG_DATA_INICIO, CMD, INFO_APARELHO, TIPO_BIG_DATA, UART, montarPacote, type Canal } from "../protocolo";
import type { BluetoothNavegador } from "../web-bluetooth";

export interface OpcoesSimulado {
  /** Hora de parede do anel (campos UTC). */
  agoraParede: Date;
  nome?: string;
  firmware?: string;
  semHrv?: boolean;
  semBigData?: boolean;
  /** Dias (atrás) sem nenhuma frequência cardíaca. */
  diasSemFc?: number[];
  atrasoMs?: number;
  /** Manda um pacote "não solicitado" antes de cada resposta. */
  ruido?: boolean;
  /** Tamanho dos pedaços do Big Data (MTU). */
  pedacoBigData?: number;
}

const bcd = (n: number) => ((Math.floor(n / 10) << 4) | n % 10) & 0xff;
const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];

export function fcSimulada(diasAtras: number, minuto: number): number {
  return 58 + ((minuto / 5 + diasAtras * 7) % 30);
}

export class AnelSimulado {
  readonly pedidos: { canal: Canal; bytes: Uint8Array }[] = [];
  constructor(readonly o: OpcoesSimulado) {}

  private minutoAgora() {
    return this.o.agoraParede.getUTCHours() * 60 + this.o.agoraParede.getUTCMinutes();
  }
  private dia(diasAtras: number) {
    const a = this.o.agoraParede;
    return new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate() - diasAtras));
  }
  /** Até que minuto do dia há dados (hoje só até agora). */
  private limite(diasAtras: number) {
    return diasAtras === 0 ? this.minutoAgora() : 1440;
  }

  responder(canal: Canal, bytes: Uint8Array): Uint8Array[] {
    this.pedidos.push({ canal, bytes: bytes.slice() });
    const saida = canal === "bigdata" ? this.bigData(bytes) : this.comando(bytes);
    if (this.o.ruido && saida.length) saida.unshift(montarPacote(0x73, [0x01, 0x02]));
    return saida;
  }

  private comando(p: Uint8Array): Uint8Array[] {
    const cmd = p[0];
    if (cmd === CMD.BATERIA) return [montarPacote(CMD.BATERIA, [76, 0])];
    if (cmd === CMD.FC_HISTORICO) {
      const s = (p[1]! | (p[2]! << 8) | (p[3]! << 16) | (p[4]! << 24)) >>> 0;
      const diasAtras = Math.round((this.dia(0).getTime() / 1000 - s) / 86400);
      if (diasAtras < 0 || diasAtras > 6 || this.o.diasSemFc?.includes(diasAtras)) return [montarPacote(cmd, [0xff])];
      const valores = Array.from({ length: 288 }, (_, i) => (i * 5 < this.limite(diasAtras) ? fcSimulada(diasAtras, i * 5) : 0));
      // Simula leituras falhas de vez em quando.
      for (let i = 3; i < 288; i += 17) valores[i] = 0;
      const pacotes = [montarPacote(cmd, [0, 24, 5])];
      pacotes.push(montarPacote(cmd, [1, s & 0xff, (s >> 8) & 0xff, (s >> 16) & 0xff, (s >>> 24) & 0xff, ...valores.slice(0, 9)]));
      for (let n = 2; n < 24; n++) {
        const ini = 9 + (n - 2) * 13;
        const fatia = valores.slice(ini, ini + 13);
        while (fatia.length < 13) fatia.push(0);
        pacotes.push(montarPacote(cmd, [n, ...fatia]));
      }
      return pacotes;
    }
    if (cmd === CMD.PASSOS_DIA) {
      const diasAtras = p[1]!;
      if (diasAtras > 6) return [montarPacote(cmd, [0xff])];
      const d = this.dia(diasAtras);
      const quartos: number[] = [];
      for (let q = 28; q < 88; q += 2) if (q * 15 < this.limite(diasAtras)) quartos.push(q);
      if (!quartos.length) return [montarPacote(cmd, [0xff])];
      const pacotes = [montarPacote(cmd, [0xf0, quartos.length, 0x01])];
      quartos.forEach((q, i) => {
        const passos = 200 + q * 5 + diasAtras * 11;
        pacotes.push(
          montarPacote(cmd, [
            bcd(d.getUTCFullYear() - 2000), bcd(d.getUTCMonth() + 1), bcd(d.getUTCDate()),
            q, i, quartos.length, ...u16(passos / 20), ...u16(passos), ...u16(Math.round(passos * 0.7)),
          ]),
        );
      });
      return pacotes;
    }
    if (cmd === CMD.HRV || cmd === CMD.ESTRESSE) {
      if (cmd === CMD.HRV && this.o.semHrv) return [];
      const diasAtras = p[1]!;
      const base = cmd === CMD.HRV ? 40 : 25;
      const valores = Array.from({ length: 48 }, (_, i) => (i * 30 < this.limite(diasAtras) ? base + ((i + diasAtras) % 12) : 0));
      const pacotes = [montarPacote(cmd, [0, 5, 30])];
      pacotes.push(montarPacote(cmd, [1, 0, ...valores.slice(0, 12)]));
      for (let n = 2; n < 5; n++) {
        const ini = 12 + (n - 2) * 13;
        const fatia = valores.slice(ini, ini + 13);
        while (fatia.length < 13) fatia.push(0);
        pacotes.push(montarPacote(cmd, [n, ...fatia]));
      }
      return pacotes;
    }
    // Comando desconhecido: o anel recusa.
    return [montarPacote((cmd ?? 0) | 0x80)];
  }

  private bigData(p: Uint8Array): Uint8Array[] {
    if (this.o.semBigData || p[0] !== BIG_DATA_INICIO) return [];
    const tipo = p[1]!;
    let dados: number[];
    if (tipo === TIPO_BIG_DATA.SPO2) {
      dados = [];
      for (let d = 6; d >= 0; d--) {
        dados.push(d);
        for (let h = 0; h < 24; h++) {
          const tem = h < 7 && (d > 0 || h * 60 < this.minutoAgora());
          dados.push(tem ? 94 + (h % 3) : 0, tem ? 97 + (h % 2) : 0);
        }
      }
    } else if (tipo === TIPO_BIG_DATA.SONO) {
      dados = [3];
      for (const d of [2, 1, 0]) {
        const trechos = [2, 40, 3, 70, 4, 50, 5, 10, 2, 90, 3, 60, 4, 40 + d * 5];
        dados.push(d, 4 + trechos.length, ...u16(1380), ...u16(400), ...trechos);
      }
    } else if (tipo === TIPO_BIG_DATA.TEMPERATURA) {
      dados = [0x01, 0x22, 0x0e, 0x22, 0x10, 0x00, 0x00];
    } else {
      dados = [];
    }
    const completo = new Uint8Array([BIG_DATA_INICIO, tipo, ...u16(dados.length), 0x00, 0x00, ...dados]);
    const pedaco = this.o.pedacoBigData ?? 20;
    const saida: Uint8Array[] = [];
    for (let i = 0; i < completo.length; i += pedaco) saida.push(completo.slice(i, i + pedaco));
    return saida;
  }
}

/** ConexaoAnel direto em cima do anel simulado (testes em Node). */
export function conexaoSimulada(anel: AnelSimulado): ConexaoAnel & { derrubar(): void } {
  const ouvintes = new Set<(c: Canal, b: Uint8Array) => void>();
  const quedas = new Set<() => void>();
  let ligado = true;
  const atraso = anel.o.atrasoMs ?? 0;
  return {
    nome: anel.o.nome ?? "R09_F301",
    temBigData: !anel.o.semBigData,
    async enviar(canal, bytes) {
      if (!ligado) throw new Error("desligado");
      const respostas = anel.responder(canal, bytes);
      setTimeout(() => {
        for (const r of respostas) if (ligado) ouvintes.forEach((f) => f(canal, r));
      }, atraso);
    },
    aoReceber(fn) {
      ouvintes.add(fn);
      return () => ouvintes.delete(fn);
    },
    aoDesconectar(fn) {
      quedas.add(fn);
      return () => quedas.delete(fn);
    },
    async lerInfo() {
      return { firmware: anel.o.firmware ?? "3.10.21", hardware: "R09_V1.0" };
    },
    async desconectar() {
      ligado = false;
    },
    derrubar() {
      ligado = false;
      quedas.forEach((f) => f());
    },
  };
}

/** navigator.bluetooth falso, para conferir a página de verdade no Chromium. */
export function bluetoothFalso(anel: AnelSimulado): BluetoothNavegador {
  const atraso = anel.o.atrasoMs ?? 5;
  class Carac extends EventTarget {
    value?: DataView;
    properties = { write: true, writeWithoutResponse: true };
    constructor(private aoEscrever?: (b: Uint8Array) => void, private leitura?: string) {
      super();
    }
    async startNotifications() {
      return this;
    }
    async readValue() {
      return new DataView(new TextEncoder().encode(this.leitura ?? "").buffer);
    }
    async writeValueWithoutResponse(v: BufferSource) {
      const b = v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);
      this.aoEscrever?.(b.slice());
    }
  }
  const notifCmd = new Carac();
  const notifBig = new Carac();
  const emitir = (alvo: Carac, canal: Canal, bytes: Uint8Array) => {
    const respostas = anel.responder(canal, bytes);
    respostas.forEach((r, i) =>
      setTimeout(() => {
        alvo.value = new DataView(r.buffer.slice(0));
        alvo.dispatchEvent(new Event("characteristicvaluechanged"));
      }, atraso * (i + 1)),
    );
  };
  const servicos: Record<string, Record<string, Carac>> = {
    [UART.servico]: {
      [UART.escrita]: new Carac((b) => emitir(notifCmd, "comandos", b)),
      [UART.notificacao]: notifCmd,
    },
    [String(INFO_APARELHO.servico)]: {
      [String(INFO_APARELHO.firmware)]: new Carac(undefined, anel.o.firmware ?? "3.10.21"),
      [String(INFO_APARELHO.hardware)]: new Carac(undefined, "R09_V1.0"),
    },
  };
  if (!anel.o.semBigData)
    servicos[BIG_DATA.servico] = {
      [BIG_DATA.escrita]: new Carac((b) => emitir(notifBig, "bigdata", b)),
      [BIG_DATA.notificacao]: notifBig,
    };
  return {
    async requestDevice() {
      const aparelho = new EventTarget() as EventTarget & { name: string; gatt: unknown };
      aparelho.name = anel.o.nome ?? "R09_F301";
      const gatt = {
        connected: true,
        async connect() {
          return gatt;
        },
        disconnect() {
          gatt.connected = false;
          aparelho.dispatchEvent(new Event("gattserverdisconnected"));
        },
        async getPrimaryService(uuid: string | number) {
          const s = servicos[String(uuid)];
          if (!s) throw new Error("NotFoundError");
          return {
            async getCharacteristic(c: string | number) {
              const x = s[String(c)];
              if (!x) throw new Error("NotFoundError");
              return x;
            },
          };
        },
      };
      aparelho.gatt = gatt;
      return aparelho as never;
    },
  };
}
