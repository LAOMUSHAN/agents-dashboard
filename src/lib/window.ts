import { getCurrentWindow } from "@tauri-apps/api/window";

/** 浏览器里跑 Vite 时没有 Tauri 运行时，返回 null 让调用方静默降级 */
export function appWindow() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  return getCurrentWindow();
}

/** 无边框窗口的拖拽带双击切换最大化 */
export function toggleMaximize() {
  void appWindow()?.toggleMaximize();
}
