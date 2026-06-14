import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** `crossorigin` on file:// assets prevents CSS/JS from loading in packaged Electron. */
function electronBuiltHtml(): Plugin {
  return {
    name: "electron-built-html",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(?:="[^"]*")?/g, "");
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), electronBuiltHtml()],
  build: {
    modulePreload: false,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
