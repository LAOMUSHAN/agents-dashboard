import type { SourceFilter } from "../../shared/types";

/** 数据源展示名：请求日志/图例/来源构成共用，避免各处写死二元分支 */
export function sourceLabel(id: string): string {
  if (id === "dsh") return "DSH";
  if (id === "claude") return "Claude";
  if (id === "zcode") return "zcode";
  return id;
}

/** 顶栏范围标签 */
export function scopeLabel(filter: SourceFilter): string {
  return filter === "all" ? "全部来源" : `仅 ${sourceLabel(filter)}`;
}
