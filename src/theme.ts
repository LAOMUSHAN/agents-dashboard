import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";

export type ThemeMode = "dark" | "light" | "auto";
export type ResolvedTheme = "dark" | "light";

const KEY = "theme";
// 跨窗口同步:storage 事件在 WKWebView 多实例间不触发,须走 Tauri event 中转
const THEME_EVENT = "theme-changed";

const isTauri = "__TAURI_INTERNALS__" in window;

const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

export function getThemeMode(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === "dark" || v === "light" || v === "auto" ? v : "auto";
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === "auto") return media.matches ? "dark" : "light";
  return mode;
}

function apply() {
  const resolved = resolve(getThemeMode());
  document.documentElement.dataset.theme = resolved;
  // shadcn/tailwind 约定:.dark class;与旧 data-theme 并存,P2-P5 迁移完再移除
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

function notify() {
  listeners.forEach((l) => l());
}

export function setThemeMode(mode: ThemeMode) {
  localStorage.setItem(KEY, mode);
  apply();
  notify();
  if (isTauri) void emit(THEME_EVENT);
}

function refresh() {
  apply();
  notify();
}

media.addEventListener("change", () => {
  if (getThemeMode() === "auto") {
    refresh();
  }
});

if (isTauri) {
  void listen(THEME_EVENT, refresh);
}
// 浏览器开发模式下的多标签同步(Tauri 下不会触发,由 THEME_EVENT 覆盖)
window.addEventListener("storage", (e) => {
  if (e.key === KEY) refresh();
});
// 浮窗隐藏期间 WKWebView 可能被挂起而错过事件,重新可见时兜底重读
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});

apply();

/** 当前实际生效的主题(深色或浅色),auto 模式下跟随系统并响应系统切换 */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolve(getThemeMode()));
  useEffect(() => {
    const update = () => setTheme(resolve(getThemeMode()));
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  return theme;
}
