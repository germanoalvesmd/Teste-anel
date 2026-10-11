// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LaboratorioAnel } from "../src/components/anel/LaboratorioAnel";
import { paredeAgora } from "../src/lib/anel/cliente";
import { AnelSimulado, conexaoSimulada, type OpcoesSimulado } from "../src/lib/anel/testes/anel-simulado";

afterEach(cleanup);

function pagina(o: Partial<OpcoesSimulado> = {}) {
  const anel = new AnelSimulado({ agoraParede: paredeAgora(), ...o });
  const conexao = conexaoSimulada(anel);
  render(<LaboratorioAnel conectar={async () => conexao} temBluetooth prazoMs={200} />);
  return { anel, conexao };
}

describe("página do laboratório", () => {
  it("avisa quando o navegador não tem Bluetooth", () => {
    render(<LaboratorioAnel temBluetooth={false} />);
    expect(screen.getByRole("alert").textContent).toMatch(/Chrome do computador/);
    expect((screen.getByText("Conectar anel") as HTMLButtonElement).disabled).toBe(true);
  });

  it("conecta, mostra firmware e bateria, baixa e mostra a tabela", async () => {
    pagina();
    fireEvent.click(screen.getByText("Conectar anel"));
    await screen.findByText("76%");
    expect(screen.getByText("3.10.21")).toBeTruthy();
    expect(screen.getAllByText("R09_F301").length).toBe(2);
    fireEvent.click(screen.getByText("Baixar 7 dias"));
    await screen.findByText(/Pronto\. Confira/, undefined, { timeout: 4000 });
    const ontem = screen.getByTestId("dia-1");
    expect(ontem.textContent).toMatch(/96%/);
    expect(ontem.textContent).toMatch(/5h55/);
    expect(screen.getByText("Última noite")).toBeTruthy();
    expect((screen.getByLabelText("Relatório") as HTMLTextAreaElement).value).toMatch(/firmware 3\.10\.21/);
  });

  it("anel que cai no meio volta para o botão de conectar", async () => {
    const { conexao } = pagina();
    fireEvent.click(screen.getByText("Conectar anel"));
    await screen.findByText("76%");
    act(() => conexao.derrubar());
    await waitFor(() => expect(screen.getByText("Conectar anel")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toMatch(/desconectou/);
  });

  it("cancelar a janela do Chrome dá uma explicação simples", async () => {
    render(
      <LaboratorioAnel
        temBluetooth
        conectar={async () => {
          throw new Error("User cancelled the requestDevice() chooser.");
        }}
      />,
    );
    fireEvent.click(screen.getByText("Conectar anel"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Não achei meu anel/);
  });

  it("não usa vermelho em lugar nenhum", () => {
    const { container } = render(<LaboratorioAnel temBluetooth={false} />);
    expect(container.innerHTML).not.toMatch(/red|#f00|#ff0000|rose-/i);
  });
});
