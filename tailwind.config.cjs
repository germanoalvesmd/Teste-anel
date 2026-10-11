/** Cores e fontes da marca Onni (veja CLAUDE.md). Nunca vermelho. */
module.exports = {
  content: ["./src/**/*.{ts,tsx}", "./lab/**/*.tsx"],
  theme: {
    extend: {
      colors: {
        petroleo: "#0B4D5B",
        menta: "#3DCA98",
        lavanda: "#B6A8F0",
        nevoa: "#F3F8F7",
        mentaClara: "#DDF5EC",
        lavandaClara: "#EEEAFD",
        mentaTexto: "#13704F",
        cinza: "#4A6870",
        ambar: "#9A4A0B",
        ambarFundo: "#FDF0E1",
        borda: "#D7E3E2",
      },
      fontFamily: {
        titulo: ["Nunito", "system-ui", "sans-serif"],
        corpo: ["'Nunito Sans'", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
