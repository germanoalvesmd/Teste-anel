// Protocolo dos anéis QRing (Colmi R0x / Yawell).
// Só bytes: monta pedidos e lê respostas. Sem Bluetooth e sem tela.
// Adaptado a partir da documentação de openring e colmi_r02_client (MIT). Veja CREDITOS.md.

export const UART = {
  servico: "6e40fff0-b5a3-f393-e0a9-e50e24dcca9e",
  escrita: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
  notificacao: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
} as const;

export const BIG_DATA = {
  servico: "de5bf728-d711-4e47-af26-65e3012a5dc7",
  escrita: "de5bf72a-d711-4e47-af26-65e3012a5dc7",
  notificacao: "de5bf729-d711-4e47-af26-65e3012a5dc7",
} as const;

export const INFO_APARELHO = {
  servico: 0x180a,
  firmware: 0x2a26,
  hardware: 0x2a27,
} as const;

export const CMD = {
  BATERIA: 0x03,
  FC_HISTORICO: 0x15,
  ESTRESSE: 0x37,
  HRV: 0x39,
  PASSOS_DIA: 0x43,
} as const;

export const TIPO_BIG_DATA = {
  /** Suspeita, não confirmada: temperatura da pele do R09. */
  TEMPERATURA: 0x25,
  SONO: 0x27,
  SPO2: 0x2a,
} as const;

export const BIG_DATA_INICIO = 0xbc;
export const TAMANHO_PACOTE = 16;

export type Canal = "comandos" | "bigdata";

/** Resultado de entregar um pacote a um leitor: continua esperando ou terminou. */
export type Passo<T> = { fim: false } | { fim: true; valor: T };
const continua = { fim: false } as const;
const fim = <T>(valor: T): Passo<T> => ({ fim: true, valor });

export interface Leitor<T> {
  receber(pacote: Uint8Array): Passo<T>;
}

// ---------- utilidades ----------

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

export function somaVerificacao(bytes: Uint8Array): number {
  let soma = 0;
  for (let i = 0; i < TAMANHO_PACOTE - 1; i++) soma += bytes[i] ?? 0;
  return soma & 0xff;
}

export function montarPacote(comando: number, dados: ArrayLike<number> = []): Uint8Array {
  if (dados.length > 14) throw new Error("Pacote com mais de 14 bytes de dados");
  const p = new Uint8Array(TAMANHO_PACOTE);
  p[0] = comando;
  p.set(Array.from(dados), 1);
  p[15] = somaVerificacao(p);
  return p;
}

export function pacoteValido(p: Uint8Array): boolean {
  return p.length === TAMANHO_PACOTE && p[15] === somaVerificacao(p);
}

/** O anel responde com o bit 0x80 ligado quando recusa um comando. */
export function ehErroDoComando(p: Uint8Array, comando: number): boolean {
  return p[0] === (comando | 0x80);
}

const b = (p: Uint8Array, i: number): number => p[i] ?? 0;
const u16 = (p: Uint8Array, i: number): number => b(p, i) | (b(p, i + 1) << 8);
const u32 = (p: Uint8Array, i: number): number =>
  (b(p, i) | (b(p, i + 1) << 8) | (b(p, i + 2) << 16) | (b(p, i + 3) << 24)) >>> 0;
const deBcd = (v: number): number => (v >> 4) * 10 + (v & 0x0f);

// ---------- bateria ----------

export interface Bateria {
  nivel: number;
  carregando: boolean;
}

export const pedidoBateria = (): Uint8Array => montarPacote(CMD.BATERIA);

export function lerBateria(p: Uint8Array): Bateria {
  return { nivel: b(p, 1), carregando: b(p, 2) !== 0 };
}

// ---------- frequência cardíaca (histórico do dia) ----------

export interface LeituraMinuto {
  /** Minuto do dia (0 a 1439), em hora de parede. */
  minuto: number;
  valor: number;
}

export interface FcDia {
  /** Segundos que o anel devolveu no primeiro pacote (hora de parede). */
  inicioAnel: number | null;
  intervaloMin: number;
  leituras: LeituraMinuto[];
}

/** `meiaNoiteParedeMs`: meia-noite do dia em hora de parede (campos UTC). */
export function pedidoFcDia(meiaNoiteParedeMs: number): Uint8Array {
  const s = Math.floor(meiaNoiteParedeMs / 1000) >>> 0;
  return montarPacote(CMD.FC_HISTORICO, [s & 0xff, (s >> 8) & 0xff, (s >> 16) & 0xff, (s >>> 24) & 0xff]);
}

export function leitorFc(): Leitor<FcDia> {
  let total = 0;
  let intervalo = 5;
  let inicio: number | null = null;
  const valores: number[] = [];
  return {
    receber(p) {
      const sub = b(p, 1);
      if (sub === 0xff) return fim({ inicioAnel: null, intervaloMin: intervalo, leituras: [] });
      if (sub === 0) {
        total = b(p, 2);
        intervalo = b(p, 3) || 5;
        if (total <= 1) return fim({ inicioAnel: null, intervaloMin: intervalo, leituras: [] });
        return continua;
      }
      if (sub === 1) {
        inicio = u32(p, 2);
        for (let i = 6; i < 15; i++) valores.push(b(p, i));
      } else {
        for (let i = 2; i < 15; i++) valores.push(b(p, i));
      }
      if (total > 0 && sub < total - 1) return continua;
      const porDia = Math.floor(1440 / intervalo);
      const leituras: LeituraMinuto[] = [];
      valores.slice(0, porDia).forEach((v, i) => {
        if (v > 0) leituras.push({ minuto: i * intervalo, valor: v });
      });
      return fim({ inicioAnel: inicio, intervaloMin: intervalo, leituras });
    },
  };
}

// ---------- passos (por quarto de hora) ----------

export interface QuartoDeHora {
  ano: number;
  mes: number;
  dia: number;
  /** 0 a 95: cada um vale 15 minutos. */
  quarto: number;
  passos: number;
  distanciaM: number;
  /** Unidade não confirmada; não mostramos calorias. */
  caloriasBrutas: number;
}

export const pedidoPassosDia = (diasAtras: number): Uint8Array =>
  montarPacote(CMD.PASSOS_DIA, [diasAtras & 0xff, 0x0f, 0x00, 0x5f, 0x01]);

export function leitorPassos(): Leitor<{ quartos: QuartoDeHora[]; caloriasX10: boolean }> {
  const quartos: QuartoDeHora[] = [];
  let caloriasX10 = false;
  return {
    receber(p) {
      const t = b(p, 1);
      if (t === 0xff) return fim({ quartos, caloriasX10 });
      if (t === 0xf0) {
        // Cabeçalho. byte 3 = 1 indica o formato novo de calorias.
        caloriasX10 = b(p, 3) === 1;
        return continua;
      }
      quartos.push({
        ano: 2000 + deBcd(t),
        mes: deBcd(b(p, 2)),
        dia: deBcd(b(p, 3)),
        quarto: b(p, 4),
        caloriasBrutas: u16(p, 7),
        passos: u16(p, 9),
        distanciaM: u16(p, 11),
      });
      // byte 5 = índice deste pacote; byte 6 = total de pacotes.
      if (b(p, 5) >= b(p, 6) - 1) return fim({ quartos, caloriasX10 });
      return continua;
    },
  };
}

// ---------- HRV e estresse (mesmo formato, a cada 30 min) ----------

export const pedidoSerieDia = (comando: number, diasAtras: number): Uint8Array =>
  montarPacote(comando, [diasAtras & 0xff]);

export function leitorSerie30(): Leitor<LeituraMinuto[]> {
  let total = 0;
  let intervalo = 30;
  const leituras: LeituraMinuto[] = [];
  return {
    receber(p) {
      const n = b(p, 1);
      if (n === 0xff) return fim(leituras);
      if (n === 0) {
        total = b(p, 2);
        intervalo = b(p, 3) || 30;
        if (total <= 1) return fim(leituras);
        return continua;
      }
      const primeiro = n === 1 ? 3 : 2;
      const anteriores = n === 1 ? 0 : 12 + (n - 2) * 13;
      for (let i = primeiro; i < 15; i++) {
        const v = b(p, i);
        const minuto = (anteriores + i - primeiro) * intervalo;
        if (v > 0 && minuto < 1440) leituras.push({ minuto, valor: v });
      }
      if (total > 0 && n < total - 1) return continua;
      return fim(leituras);
    },
  };
}

// ---------- Big Data (sono, oxigenação, temperatura) ----------

export const pedidoBigData = (tipo: number): Uint8Array =>
  new Uint8Array([BIG_DATA_INICIO, tipo, 0x01, 0x00, 0xff, 0x00, 0xff]);

/** Junta as notificações até completar o tamanho anunciado no cabeçalho. */
export function leitorBigData(tipo: number): Leitor<Uint8Array> {
  let buffer: Uint8Array | null = null;
  let preenchido = 0;
  return {
    receber(p) {
      if (!buffer) {
        if (b(p, 0) !== BIG_DATA_INICIO || b(p, 1) !== tipo) return continua;
        const tamanho = u16(p, 2);
        buffer = new Uint8Array(6 + tamanho);
      }
      const cabe = Math.min(p.length, buffer.length - preenchido);
      buffer.set(p.subarray(0, cabe), preenchido);
      preenchido += cabe;
      if (preenchido < buffer.length) return continua;
      return fim(buffer.slice(6));
    },
  };
}

export interface Spo2Hora {
  diasAtras: number;
  hora: number;
  minimo: number;
  maximo: number;
}

/** Cada dia: 1 byte "dias atrás" + 24 horas × (mínimo, máximo). */
export function lerSpo2(dados: Uint8Array): Spo2Hora[] {
  const saida: Spo2Hora[] = [];
  let i = 0;
  while (i + 49 <= dados.length) {
    const diasAtras = b(dados, i++);
    for (let hora = 0; hora < 24; hora++) {
      const minimo = b(dados, i);
      const maximo = b(dados, i + 1);
      i += 2;
      if (minimo > 0 && maximo > 0) saida.push({ diasAtras, hora, minimo, maximo });
    }
  }
  return saida;
}

export const ESTAGIO_SONO: Record<number, "leve" | "profundo" | "rem" | "acordado"> = {
  2: "leve",
  3: "profundo",
  4: "rem",
  5: "acordado",
};

export interface NoiteSono {
  diasAtras: number;
  /** Minutos depois da meia-noite. Se início > fim, começou na véspera. */
  inicioMin: number;
  fimMin: number;
  trechos: { estagio: string; minutos: number }[];
}

export function lerSono(dados: Uint8Array): NoiteSono[] {
  const noites: NoiteSono[] = [];
  const dias = b(dados, 0);
  let i = 1;
  for (let d = 0; d < dias && i + 6 <= dados.length; d++) {
    const diasAtras = b(dados, i);
    const bytesDia = b(dados, i + 1);
    const inicioMin = u16(dados, i + 2);
    const fimMin = u16(dados, i + 4);
    const trechos: NoiteSono["trechos"] = [];
    let j = i + 6;
    const limite = Math.min(i + 2 + bytesDia, dados.length);
    for (; j + 1 < limite; j += 2) {
      const tipo = b(dados, j);
      trechos.push({ estagio: ESTAGIO_SONO[tipo] ?? `tipo ${tipo}`, minutos: b(dados, j + 1) });
    }
    noites.push({ diasAtras, inicioMin, fimMin, trechos });
    i = i + 2 + bytesDia;
  }
  return noites;
}
