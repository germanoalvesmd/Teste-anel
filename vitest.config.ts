import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts", "ui/**/*.test.tsx"] }, esbuild: { jsx: "automatic" } });
