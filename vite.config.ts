import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and host during dev.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // Don't watch the Rust backend — Tauri handles that.
      ignored: ["**/src-tauri/**"],
    },
  },
});
