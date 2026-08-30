import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/cribbage/",
  plugins: [react()],
  build: {
    // Preserve the production /cribbage URL structure while keeping the
    // deployable bundle self-contained in this repository.
    outDir: "../deploy/cribbage",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api/cribbage": {
        target: "http://127.0.0.1:8787",
        ws: true,
      },
    },
  },
});
