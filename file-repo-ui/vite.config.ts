import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "https://localhost:8443",
        changeOrigin: true,
        secure: false, // allow self-signed Traefik cert in dev
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});


