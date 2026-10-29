import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": process.env.STUDIO_API_URL || "http://127.0.0.1:8000" },
  },
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/pdfjs-dist/")) return "pdf";
          if (id.includes("/react-markdown/")) return "markdown";
        },
      },
    },
  },
  optimizeDeps: { exclude: ["pdfjs-dist"] },
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
});
