// ConexaoAnel pelo Web Bluetooth (Chrome/Edge no computador, Chrome no Android).
// No iPhone nenhum navegador tem Web Bluetooth: lá vai ser um adaptador Capacitor.
import type { ConexaoAnel, InfoAparelho } from "./cliente";
import { BIG_DATA, INFO_APARELHO, UART, type Canal } from "./protocolo";

// Tipos mínimos: o TypeScript não traz os do Web Bluetooth.
interface Caracteristica extends EventTarget {
  value?: DataView;
  properties: { write: boolean; writeWithoutResponse: boolean };
  startNotifications(): Promise<Caracteristica>;
  readValue(): Promise<DataView>;
  writeValueWithResponse?(v: BufferSource): Promise<void>;
  writeValueWithoutResponse?(v: BufferSource): Promise<void>;
  writeValue?(v: BufferSource): Promise<void>;
}
interface Servico {
  getCharacteristic(uuid: string | number): Promise<Caracteristica>;
}
interface Gatt {
  connected: boolean;
  connect(): Promise<Gatt>;
  disconnect(): void;
  getPrimaryService(uuid: string | number): Promise<Servico>;
}
interface Aparelho extends EventTarget {
  name?: string;
  gatt?: Gatt;
}
export interface BluetoothNavegador {
  requestDevice(opcoes: unknown): Promise<Aparelho>;
}

export function bluetoothDisponivel(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

const bytesDe = (v: DataView) => new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));

async function escrever(c: Caracteristica, bytes: Uint8Array) {
  const copia = bytes.slice();
  if (c.properties.writeWithoutResponse && c.writeValueWithoutResponse) return c.writeValueWithoutResponse(copia);
  if (c.writeValueWithResponse) return c.writeValueWithResponse(copia);
  if (c.writeValue) return c.writeValue(copia);
  throw new Error("Característica sem escrita");
}

export interface OpcoesConexao {
  /** Mostra todos os aparelhos Bluetooth por perto (quando o anel não aparece na lista). */
  todos?: boolean;
  bluetooth?: BluetoothNavegador;
}

export async function conectarWebBluetooth(opcoes: OpcoesConexao = {}): Promise<ConexaoAnel> {
  const bt = opcoes.bluetooth ?? (navigator as unknown as { bluetooth?: BluetoothNavegador }).bluetooth;
  if (!bt) throw new Error("Este navegador não tem Bluetooth web. Use o Chrome no computador ou no Android.");

  const servicos = [UART.servico, BIG_DATA.servico, INFO_APARELHO.servico];
  const aparelho = await bt.requestDevice(
    opcoes.todos
      ? { acceptAllDevices: true, optionalServices: servicos }
      : {
          filters: [{ namePrefix: "R0" }, { namePrefix: "R1" }, { namePrefix: "COLMI" }, { namePrefix: "QRing" }, { services: [UART.servico] }],
          optionalServices: servicos,
        },
  );
  if (!aparelho.gatt) throw new Error("Aparelho sem GATT.");
  const gatt = await aparelho.gatt.connect();

  const ouvintes = new Set<(canal: Canal, bytes: Uint8Array) => void>();
  const quedas = new Set<() => void>();
  const avisar = (canal: Canal) => (ev: Event) => {
    const v = (ev.target as Caracteristica).value;
    if (!v) return;
    const bytes = bytesDe(v);
    ouvintes.forEach((f) => f(canal, bytes));
  };
  aparelho.addEventListener("gattserverdisconnected", () => quedas.forEach((f) => f()));

  const uart = await gatt.getPrimaryService(UART.servico);
  const escritaCmd = await uart.getCharacteristic(UART.escrita);
  const notifCmd = await uart.getCharacteristic(UART.notificacao);
  notifCmd.addEventListener("characteristicvaluechanged", avisar("comandos"));
  await notifCmd.startNotifications();

  let escritaBig: Caracteristica | null = null;
  try {
    const big = await gatt.getPrimaryService(BIG_DATA.servico);
    escritaBig = await big.getCharacteristic(BIG_DATA.escrita);
    const notifBig = await big.getCharacteristic(BIG_DATA.notificacao);
    notifBig.addEventListener("characteristicvaluechanged", avisar("bigdata"));
    await notifBig.startNotifications();
  } catch {
    escritaBig = null;
  }

  const texto = (v: DataView) => new TextDecoder().decode(bytesDe(v)).replace(/\0+$/, "").trim();

  return {
    nome: aparelho.name,
    temBigData: escritaBig !== null,
    async enviar(canal, bytes) {
      const c = canal === "bigdata" ? escritaBig : escritaCmd;
      if (!c) throw new Error("Canal Big Data indisponível");
      await escrever(c, bytes);
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
      const info: InfoAparelho = {};
      try {
        const s = await gatt.getPrimaryService(INFO_APARELHO.servico);
        try {
          info.firmware = texto(await (await s.getCharacteristic(INFO_APARELHO.firmware)).readValue());
        } catch {
          /* sem firmware */
        }
        try {
          info.hardware = texto(await (await s.getCharacteristic(INFO_APARELHO.hardware)).readValue());
        } catch {
          /* sem hardware */
        }
      } catch {
        /* sem serviço de informação */
      }
      return info;
    },
    async desconectar() {
      if (gatt.connected) gatt.disconnect();
    },
  };
}
