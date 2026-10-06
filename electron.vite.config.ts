import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { readFileSync, existsSync } from "node:fs";
import react from "@vitejs/plugin-react";

const release = existsSync("build/release.json") ? JSON.parse(readFileSync("build/release.json", "utf8")) : {
  version: "0.1.0", commit: "development", sourceHash: "development", releaseId: "development", apiVersion: "v1", storageVersion: 1,
};
export default defineConfig({
  main: {
    define: {
      __SHIPFLOW_RELEASE__: JSON.stringify(release),
      __SHIPFLOW_BUNDLE_PUBLIC_KEY__: JSON.stringify(process.env.SHIPFLOW_BUNDLE_PUBLIC_KEY || ""),
    },
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
        input: {
          workspace: "index.html",
          serviceSettings: "service-settings.html",
        },
      },
    },
  },
});
