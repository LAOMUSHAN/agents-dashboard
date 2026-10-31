import { useSyncExternalStore } from "react";
import { nextMidnight, startOfDay } from "../lib/day";

/**
 * 全应用共享的「本地日界」时钟。
 *
 * 页面长时间开着时，`Date.now()` 会变，但组件里的 useMemo 不会自己重算；
 * 所有「今天 / 昨天 / 近 N 天」的查询窗口都必须在跨零点时一起翻页。
 * 这里用单例定时器把零点变成一次 store 更新，useRange 与活跃时段共用同一份值。
 */
let todayStart = startOfDay(Date.now());
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function clearTimer() {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule() {
  clearTimer();
  if (listeners.size === 0) return;
  const now = Date.now();
  // 多等 250ms，避开定时器与系统时间戳在 23:59:59.999 上竞争
  timer = setTimeout(tick, Math.max(250, nextMidnight(now) - now + 250));
}

/** 重算日界；只有日期真的变了才通知订阅者，焦点/可见性回调可以放心多调 */
function refresh() {
  const next = startOfDay(Date.now());
  if (next !== todayStart) {
    todayStart = next;
    for (const listener of listeners) listener();
  }
  schedule();
}

function tick() {
  timer = null;
  refresh();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // 模块加载到首次订阅之间可能已经跨天：先校准。
  // 新订阅者会在订阅后的 getSnapshot 读到新值，不需要同步回调它。
  const next = startOfDay(Date.now());
  if (next !== todayStart) {
    todayStart = next;
    for (const other of listeners) if (other !== listener) other();
  }
  if (timer == null) schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) clearTimer();
  };
}

const getSnapshot = () => todayStart;

/** 当前本地日期的零点（epoch ms）；跨零点自动更新 */
export function useTodayStart(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 托盘唤回、休眠恢复后手动校时；日期没变时是空操作 */
export function syncToday(): void {
  refresh();
}

// 窗口被挂起或系统休眠后，setTimeout 可能延迟到恢复后才执行。
// 可见性/焦点恢复时补一次校时，避免跨天后要等到下一个零点才纠正。
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
}
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => refresh());
}
