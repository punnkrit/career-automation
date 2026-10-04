import { cloudflare } from "@cloudflare/vite-plugin";
import { sites } from "@openai/sites-vite-plugin";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), sites(), cloudflare()],
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});
