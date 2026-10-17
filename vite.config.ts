import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist-ui",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        security: resolve(import.meta.dirname, "security.html"),
        authorize: resolve(import.meta.dirname, "authorize.html"),
        connected: resolve(import.meta.dirname, "connected.html"),
      },
    },
  },
});
