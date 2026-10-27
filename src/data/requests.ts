import type { SourceFilter } from "../../shared/types";
import type { Range } from "../api";

/** 时间范围预设；只决定查询窗口与视图标签，不直接参与渲染 */
export type Preset = "today" | "yesterday" | "7d" | "30d" | "all" | "custom";

/**
 * 只影响视图形状/标签的请求部分。
 * 视图组件应依赖它（来自已提交快照），而不是实时的筛选控件。
 */
export interface ViewRequest {
  preset: Preset;
  range: Range;
  customFrom: string;
  customTo: string;
}

/** 仪表盘请求的完整身份：视图描述 + 数据源 */
export interface DashboardRequest extends ViewRequest {
  source: SourceFilter;
  /**
   * 顶栏实时速度的采样窗口（秒），跟随刷新间隔。
   * 刻意不进 dashboardKeys.request：改刷新频率不该让视图重挂载、重播入场动画，
   * 由 setRefreshSec 主动 invalidate 一次即可。
   */
  rateWindowSec: number;
}
