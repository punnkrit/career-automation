import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static demo: no Worker entrypoint, cloud bindings, secrets, or live API URL.
export default defineConfig({
  plugins: [react()],
  define: { "import.meta.env.VITE_DEMO": '"true"', "import.meta.env.VITE_API_URL": '""' },
  build: { outDir: "dist-demo" },
  server: { host: "127.0.0.1", port: 5176 },
});
