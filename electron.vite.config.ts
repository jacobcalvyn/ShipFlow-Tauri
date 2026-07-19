import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: "electron/main/index.ts",
      },
      outDir: "out/main",
      sourcemap: false,
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: {
        entry: "electron/preload/index.ts",
      },
      outDir: "out/preload",
      sourcemap: false,
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
        },
      },
    },
  },
  renderer: {
    root: ".",
    plugins: [react()],
    build: {
      outDir: "out/renderer",
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        input: "index.html",
      },
    },
  },
});
