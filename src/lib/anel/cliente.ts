// ClienteAnel: conversa com o anel um pedido por vez, com prazo e cancelamento.
// Só leitura: nunca acerta o relógio e nunca grava configuração.
import {
  BIG_DATA_INICIO,
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
  pacoteValido,
  pedidoBateria,
  pedidoBigData,
  pedidoFcDia,
  pedidoPassosDia,
  pedidoSerieDia,
  type Bateria,
  type Canal,
  type FcDia,
  type Leitor,
  type LeituraMinuto,
  type NoiteSono,
  type QuartoDeHora,
  type Spo2Hora,
} from "./protocolo";

export const VERSAO_LAB = "0.2.0";

export interface InfoAparelho {
  nome?: string;
  firmware?: string;
  hardware?: string;
}

/** O que o cliente precisa do transporte (Web Bluetooth hoje, Capacitor no iPhone depois). */
export interface ConexaoAnel {
  readonly nome?: string;
  readonly temBigData: boolean;
  enviar(canal: Canal, bytes: Uint8Array): Promise<void>;
  aoReceber(fn: (canal: Canal, bytes: Uint8Array) => void): () => void;
  aoDesconectar(fn: () => void): () => void;
  lerInfo(): Promise<InfoAparelho>;
  desconectar(): Promise<void>;
}

export class ErroPrazo extends Error {
  constructor(o: string) {
    super(`O anel não respondeu a tempo (${o}).`);
    this.name = "ErroPrazo";
  }
}
export class ErroDesconectado extends Error {
  constructor() {
    super("O anel desconectou.");
    this.name = "ErroDesconectado";
  }
}
export class ErroRecusado extends Error {
  constructor(o: string) {
    super(`O anel recusou o pedido (${o}).`);
    this.name = "ErroRecusado";
  }
}

// ---------- hora de parede ----------
// O anel guarda a hora local que o QRing acertou. Tratamos datas do anel como
// "hora de parede" e guardamos nos campos UTC de Date, para não depender do fuso.

export function paredeAgora(agora: Date = new Date()): Date {
  return new Date(
    Date.UTC(
      agora.getFullYear(),
      agora.getMonth(),
      agora.getDate(),
      agora.getHours(),
      agora.getMinutes(),
      agora.getSeconds(),
    ),
  );
}

export function meiaNoiteParede(diasAtras: number, agora: Date = new Date()): Date {
  const p = paredeAgora(agora);
  return new Date(Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), p.getUTCDate() - diasAtras));
}

const dois = (n: number) => String(n).padStart(2, "0");

export function textoDia(d: Date): string {
  return `${dois(d.getUTCDate())}/${dois(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

export function textoHora(d: Date): string {
  return `${dois(d.getUTCHours())}:${dois(d.getUTCMinutes())}`;
}

export function textoMinuto(minutoDoDia: number): string {
  const m = ((minutoDoDia % 1440) + 1440) % 1440;
  return `${dois(Math.floor(m / 60))}:${dois(m % 60)}`;
}

// ---------- resumo ----------

export interface Dia {
  diasAtras: number;
  data: Date;
  fc?: FcDia;
  passos?: QuartoDeHora[];
  hrv?: LeituraMinuto[];
  estresse?: LeituraMinuto[];
  spo2?: Spo2Hora[];
  sono?: NoiteSono;
  erros: string[];
}

export interface RegistroPacote {
  ms: number;
  sentido: "enviado" | "recebido";
  canal: Canal;
  hex: string;
}

const MAX_REGISTRO = 500;

export interface Opcoes {
  prazoMs?: number;
  agora?: () => Date;
}

type Pendente = {
  canal: Canal;
  comando: number;
  leitor: Leitor<unknown>;
  resolver: (v: unknown) => void;
  rejeitar: (e: Error) => void;
};

export class ClienteAnel {
  readonly registro: RegistroPacote[] = [];
  readonly notas: string[] = [];
  info: InfoAparelho = {};
  bateria?: Bateria;
  dias: Dia[] = [];
  temperaturaBruta?: string;
  conectado = true;

  private fila: Promise<unknown> = Promise.resolve();
  private pendente: Pendente | null = null;
  private readonly prazoMs: number;
  private readonly agora: () => Date;
  private readonly inicio = Date.now();
  private readonly desligar: (() => void)[] = [];

  constructor(
    private readonly conexao: ConexaoAnel,
    opcoes: Opcoes = {},
  ) {
    this.prazoMs = opcoes.prazoMs ?? 8000;
    this.agora = opcoes.agora ?? (() => new Date());
    this.desligar.push(
      conexao.aoReceber((canal, bytes) => this.receber(canal, bytes)),
      conexao.aoDesconectar(() => this.aoCair()),
    );
  }

  private anotar(sentido: RegistroPacote["sentido"], canal: Canal, bytes: Uint8Array) {
    this.registro.push({ ms: Date.now() - this.inicio, sentido, canal, hex: hex(bytes) });
    if (this.registro.length > MAX_REGISTRO) this.registro.shift();
  }

  private receber(canal: Canal, bytes: Uint8Array) {
    this.anotar("recebido", canal, bytes);
    const p = this.pendente;
    if (!p || p.canal !== canal) return;
    if (canal === "comandos") {
      if (!pacoteValido(bytes)) return;
      if (ehErroDoComando(bytes, p.comando)) {
        this.pendente = null;
        p.rejeitar(new ErroRecusado(`comando 0x${p.comando.toString(16)}`));
        return;
      }
      if (bytes[0] !== p.comando) return; // pacote de outro assunto: ignorar
    }
    let passo;
    try {
      passo = p.leitor.receber(bytes);
    } catch (e) {
      this.pendente = null;
      p.rejeitar(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (passo.fim) {
      this.pendente = null;
      p.resolver(passo.valor);
    }
  }

  private aoCair() {
    this.conectado = false;
    const p = this.pendente;
    this.pendente = null;
    p?.rejeitar(new ErroDesconectado());
  }

  /** Um pedido por vez: cada um espera o anterior terminar. */
  private pedir<T>(canal: Canal, bytes: Uint8Array, leitor: Leitor<T>, nome: string, prazoMs = this.prazoMs): Promise<T> {
    const comando = canal === "comandos" ? (bytes[0] ?? 0) : BIG_DATA_INICIO;
    const tarefa = () =>
      new Promise<T>((resolver, rejeitar) => {
        if (!this.conectado) return rejeitar(new ErroDesconectado());
        let relogio: ReturnType<typeof setTimeout> | undefined;
        const terminar = () => {
          clearTimeout(relogio);
          if (this.pendente === pend) this.pendente = null;
        };
        const pend: Pendente = {
          canal,
          comando,
          leitor: leitor as Leitor<unknown>,
          resolver: (v) => (terminar(), resolver(v as T)),
          rejeitar: (e) => (terminar(), rejeitar(e)),
        };
        this.pendente = pend;
        relogio = setTimeout(() => pend.rejeitar(new ErroPrazo(nome)), prazoMs);
        this.anotar("enviado", canal, bytes);
        this.conexao.enviar(canal, bytes).catch((e) => pend.rejeitar(e instanceof Error ? e : new Error(String(e))));
      });
    const resultado = this.fila.then(tarefa, tarefa);
    this.fila = resultado.catch(() => undefined);
    return resultado;
  }

  // ---------- pedidos ----------

  async lerInfo(): Promise<InfoAparelho> {
    try {
      this.info = { nome: this.conexao.nome, ...(await this.conexao.lerInfo()) };
    } catch {
      this.info = { nome: this.conexao.nome };
      this.notas.push("Não consegui ler a versão do firmware.");
    }
    return this.info;
  }

  async lerBateria(): Promise<Bateria> {
    const p = await this.pedir("comandos", pedidoBateria(), { receber: (b) => ({ fim: true, valor: lerBateria(b) }) }, "bateria");
    this.bateria = p;
    return p;
  }

  fcDoDia(diasAtras: number): Promise<FcDia> {
    return this.pedir("comandos", pedidoFcDia(meiaNoiteParede(diasAtras, this.agora()).getTime()), leitorFc(), "frequência cardíaca");
  }

  async passosDoDia(diasAtras: number): Promise<QuartoDeHora[]> {
    const r = await this.pedir("comandos", pedidoPassosDia(diasAtras), leitorPassos(), "passos");
    return r.quartos;
  }

  hrvDoDia(diasAtras: number): Promise<LeituraMinuto[]> {
    return this.pedir("comandos", pedidoSerieDia(CMD.HRV, diasAtras), leitorSerie30(), "HRV");
  }

  estresseDoDia(diasAtras: number): Promise<LeituraMinuto[]> {
    return this.pedir("comandos", pedidoSerieDia(CMD.ESTRESSE, diasAtras), leitorSerie30(), "estresse");
  }

  private bigData(tipo: number, nome: string): Promise<Uint8Array> {
    if (!this.conexao.temBigData) return Promise.reject(new Error(`Este anel não tem o canal Big Data (${nome}).`));
    return this.pedir("bigdata", pedidoBigData(tipo), leitorBigData(tipo), nome, this.prazoMs * 2);
  }

  async spo2(): Promise<Spo2Hora[]> {
    return lerSpo2(await this.bigData(TIPO_BIG_DATA.SPO2, "oxigenação"));
  }

  async sono(): Promise<NoiteSono[]> {
    return lerSono(await this.bigData(TIPO_BIG_DATA.SONO, "sono"));
  }

  /** Experimental: o formato da temperatura do R09 não é público. Guardamos os bytes crus. */
  async lerTemperaturaBruta(): Promise<string> {
    const dados = await this.bigData(TIPO_BIG_DATA.TEMPERATURA, "temperatura");
    this.temperaturaBruta = hex(dados);
    return this.temperaturaBruta;
  }

  /** Baixa 7 dias. Um erro num item não para o resto. */
  async baixarTudo(progresso: (texto: string) => void = () => {}): Promise<Dia[]> {
    const agora = this.agora();
    const dias: Dia[] = Array.from({ length: 7 }, (_, i) => ({ diasAtras: i, data: meiaNoiteParede(i, agora), erros: [] }));
    this.dias = dias;
    const falhou = (dia: Dia, oque: string, e: unknown) => {
      dia.erros.push(`${oque}: ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof ErroDesconectado) throw e;
    };

    progresso("Lendo bateria e versão…");
    await this.lerInfo();
    try {
      await this.lerBateria();
    } catch (e) {
      if (e instanceof ErroDesconectado) throw e;
      this.notas.push(`Bateria: ${(e as Error).message}`);
    }

    let pularHrv = false;
    let pularEstresse = false;
    for (const dia of dias) {
      const rotulo = dia.diasAtras === 0 ? "hoje" : textoDia(dia.data);
      progresso(`Frequência cardíaca de ${rotulo}…`);
      try {
        dia.fc = await this.fcDoDia(dia.diasAtras);
      } catch (e) {
        falhou(dia, "Frequência cardíaca", e);
      }
      progresso(`Passos de ${rotulo}…`);
      try {
        dia.passos = await this.passosDoDia(dia.diasAtras);
      } catch (e) {
        falhou(dia, "Passos", e);
      }
      if (!pularHrv) {
        progresso(`HRV de ${rotulo}…`);
        try {
          dia.hrv = await this.hrvDoDia(dia.diasAtras);
        } catch (e) {
          falhou(dia, "HRV", e);
          // Anéis sem HRV não respondem; não esperar o prazo 7 vezes.
          if (e instanceof ErroPrazo && dia.diasAtras === 0) {
            pularHrv = true;
            this.notas.push("HRV não respondeu hoje; pulei os outros dias.");
          }
        }
      }
      if (!pularEstresse) {
        progresso(`Estresse de ${rotulo}…`);
        try {
          dia.estresse = await this.estresseDoDia(dia.diasAtras);
        } catch (e) {
          falhou(dia, "Estresse", e);
          if (e instanceof ErroPrazo && dia.diasAtras === 0) {
            pularEstresse = true;
            this.notas.push("Estresse não respondeu hoje; pulei os outros dias.");
          }
        }
      }
    }

    if (this.conexao.temBigData) {
      progresso("Oxigenação (SpO2)…");
      try {
        const horas = await this.spo2();
        for (const dia of dias) dia.spo2 = horas.filter((h) => h.diasAtras === dia.diasAtras);
      } catch (e) {
        if (e instanceof ErroDesconectado) throw e;
        this.notas.push(`Oxigenação: ${(e as Error).message}`);
      }
      progresso("Sono…");
      try {
        const noites = await this.sono();
        for (const n of noites) {
          const dia = dias.find((d) => d.diasAtras === n.diasAtras);
          if (dia) dia.sono = n;
        }
      } catch (e) {
        if (e instanceof ErroDesconectado) throw e;
        this.notas.push(`Sono: ${(e as Error).message}`);
      }
    } else {
      this.notas.push("Canal Big Data ausente: sem sono e sem oxigenação.");
    }
    progresso("Pronto.");
    return dias;
  }

  async desconectar() {
    this.desligar.forEach((f) => f());
    this.conectado = false;
    await this.conexao.desconectar();
  }

  /** Texto para colar na conversa. Números e bytes, sem nome, e-mail ou cadastro. */
  relatorio(navegador = typeof navigator !== "undefined" ? navigator.userAgent : "?"): string {
    const l: string[] = [];
    l.push(`Relatório do laboratório do anel · versão ${VERSAO_LAB}`);
    l.push(`Gerado (hora de parede): ${textoDia(paredeAgora(this.agora()))} ${textoHora(paredeAgora(this.agora()))}`);
    l.push(`Navegador: ${navegador}`);
    l.push(`Anel: ${this.info.nome ?? "?"} · firmware ${this.info.firmware ?? "?"} · hardware ${this.info.hardware ?? "?"}`);
    l.push(`Big Data: ${this.conexao.temBigData ? "sim" : "não"}`);
    if (this.bateria) l.push(`Bateria: ${this.bateria.nivel}%${this.bateria.carregando ? " (carregando)" : ""}`);
    l.push("");
    for (const r of resumirDias(this.dias)) {
      l.push(
        `${r.dia}: passos ${r.passos ?? "-"} · dist ${r.distanciaKm ?? "-"} km · FC ${r.fcMin ?? "-"}/${r.fcMedia ?? "-"}/${r.fcMax ?? "-"} (${r.fcLeituras} leituras)` +
          ` · SpO2 ${r.spo2Media ?? "-"} · sono ${r.sonoTexto ?? "-"} · HRV ${r.hrvMedia ?? "-"} · estresse ${r.estresseMedia ?? "-"}`,
      );
    }
    const erros = this.dias.flatMap((d) => d.erros.map((e) => `${textoDia(d.data)} ${e}`));
    if (erros.length || this.notas.length) {
      l.push("", "Avisos:");
      for (const n of [...this.notas, ...erros]) l.push(`- ${n}`);
    }
    if (this.temperaturaBruta !== undefined) l.push("", `Temperatura (0x25, bytes crus): ${this.temperaturaBruta || "(vazio)"}`);
    l.push("", `Últimos pacotes (${Math.min(this.registro.length, 120)} de ${this.registro.length}):`);
    for (const r of this.registro.slice(-120)) l.push(`${r.ms}ms ${r.sentido === "enviado" ? ">" : "<"} ${r.canal === "bigdata" ? "BD" : "C "} ${r.hex}`);
    return l.join("\n");
  }
}

// ---------- contas para a tela e o relatório ----------

export interface ResumoDia {
  diasAtras: number;
  dia: string;
  passos?: number;
  distanciaKm?: string;
  fcMin?: number;
  fcMedia?: number;
  fcMax?: number;
  fcLeituras: number;
  spo2Media?: number;
  sonoMin?: number;
  sonoTexto?: string;
  hrvMedia?: number;
  estresseMedia?: number;
  erros: number;
}

const media = (v: number[]) => (v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : undefined);

export function horasMinutos(min: number): string {
  return `${Math.floor(min / 60)}h${dois(min % 60)}`;
}

export function resumirDias(dias: Dia[]): ResumoDia[] {
  return dias.map((d) => {
    const fc = d.fc?.leituras.map((l) => l.valor) ?? [];
    // Só conta quartos de hora que são mesmo deste dia.
    const quartos = d.passos?.filter(
      (q) => q.ano === d.data.getUTCFullYear() && q.mes === d.data.getUTCMonth() + 1 && q.dia === d.data.getUTCDate(),
    );
    const passos = quartos?.reduce((a, q) => a + q.passos, 0);
    const dist = quartos?.reduce((a, q) => a + q.distanciaM, 0);
    const sonoMin = d.sono?.trechos.filter((t) => t.estagio !== "acordado").reduce((a, t) => a + t.minutos, 0);
    return {
      diasAtras: d.diasAtras,
      dia: textoDia(d.data),
      passos,
      distanciaKm: dist === undefined ? undefined : (dist / 1000).toFixed(2),
      fcMin: fc.length ? Math.min(...fc) : undefined,
      fcMedia: media(fc),
      fcMax: fc.length ? Math.max(...fc) : undefined,
      fcLeituras: fc.length,
      spo2Media: media(d.spo2?.map((h) => (h.minimo + h.maximo) / 2) ?? []),
      sonoMin,
      sonoTexto: sonoMin === undefined ? undefined : horasMinutos(sonoMin),
      hrvMedia: media(d.hrv?.map((l) => l.valor) ?? []),
      estresseMedia: media(d.estresse?.map((l) => l.valor) ?? []),
      erros: d.erros.length,
    };
  });
}
