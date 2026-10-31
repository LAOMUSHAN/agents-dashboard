import type { Range } from "../api";
import { DAY_MS, addDays } from "../lib/day";
import type { Preset } from "./requests";

/**
 * 预设 → 查询范围。
 *
 * 时间戳一律由调用方传入：`todayStart` 来自共享日界时钟，跨零点会变，
 * 从而让 useMemo 重算并触发新的查询；`now` 只用于「近 N 天」的滚动下界。
 */
export function rangeForPreset(
  preset: Preset,
  todayStart: number,
  now: number,
  customFrom: string,
  customTo: string,
): Range {
  switch (preset) {
    case "today":
      return { from: todayStart };
    // 昨天的数据不会新增，固定上界为今天零点
    case "yesterday":
      return { from: addDays(new Date(todayStart), -1).getTime(), to: todayStart };
    case "7d":
      return { from: now - 7 * DAY_MS };
    case "30d":
      return { from: now - 30 * DAY_MS };
    case "custom": {
      const from = customFrom ? new Date(customFrom + "T00:00:00").getTime() : undefined;
      const to = customTo ? new Date(customTo + "T23:59:59.999").getTime() : undefined;
      return { from, to };
    }
    default:
      return {};
  }
}
