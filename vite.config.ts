import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Tauri 环境的 vite 配置:端口固定供 tauri.conf.json 的 devUrl 使用
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // 版本号唯一来源是 package.json,编译期注入供界面展示
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // macOS WKWebView(等价 Safari)
    target: "safari13",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      // 双入口:主窗口 + 统计浮窗(mini 窗口 url 指向 mini.html)
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        mini: fileURLToPath(new URL("./mini.html", import.meta.url)),
      },
    },
  },
});
