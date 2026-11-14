import { invoke } from "@tauri-apps/api/core";
import type {
  AgentStat,
  DashboardPayload,
  ErrorStats,
  HeatCell,
  LatencyStat,
  ModelStat,
  ModelTrendPoint,
  PriceEntry,
  PricingConfig,
  ProjectStat,
  ProviderStat,
  ProviderTrendPoint,
  RequestLogResponse,
  SourceFilter,
  Summary,
  ToolStat,
  MonthPoint,
  TrendPoint,
} from "../shared/types";

export interface Range {
  from?: number;
  to?: number;
  /**
   * 相对窗口（小时）：调用时才展开成 [now - h, now]。
   * 「24小时」用它保持滚动，同时让查询身份（key）稳定，不随每分钟的 now 变化。
   */
  lastHours?: number;
}

/** 展开相对窗口；两端都在调用时取 now，跨度正好 h 小时，分桶/分页口径才稳定 */
function resolveRange(range: Range): { from?: number; to?: number } {
  if (!range.lastHours) return range;
  const to = Date.now();
  return { from: to - range.lastHours * 3_600_000, to };
}

// 数据查询走 Tauri invoke(Rust + rusqlite 只读直查),不再有 HTTP 后端
export const api = {
  // 一次刷新只打一个命令:14 组面板数据在同一个数据库快照里返回
  // source: "all" | "zcode" | "dsh" | "claude"；缺省全部
  // rateWindowSec: 顶栏实时速度的采样窗口（秒），通常等于刷新间隔
  dashboard: (range: Range, source: SourceFilter = "all", rateWindowSec?: number) =>
    invoke<DashboardPayload>("get_dashboard", { range: resolveRange(range), source, rateWindowSec }),
  summary: (range: Range) => invoke<Summary>("get_summary", { range: resolveRange(range) }),
  trend: (range: Range) => invoke<TrendPoint[]>("get_trend", { range: resolveRange(range) }),
  modelTrend: (range: Range) =>
    invoke<ModelTrendPoint[]>("get_trend_by_model", { range: resolveRange(range) }),
  providerTrend: (range: Range) =>
    invoke<ProviderTrendPoint[]>("get_trend_by_provider", { range: resolveRange(range) }),
  models: (range: Range) => invoke<ModelStat[]>("get_models", { range: resolveRange(range) }),
  projects: (range: Range) => invoke<ProjectStat[]>("get_projects", { range: resolveRange(range) }),
  providers: (range: Range) => invoke<ProviderStat[]>("get_providers", { range: resolveRange(range) }),
  // 分页单位是根会话:每页返回 N 个主会话(含其子代理请求)
  requests: (range: Range, page: number, pageSize = 10, source: SourceFilter = "all") =>
    invoke<RequestLogResponse>("get_requests", {
      range: resolveRange(range),
      page,
      pageSize,
      source,
    }),
  // 界面偏好：与 pricing.json 同目录的 ui-prefs.json，跨 dev/release 与数据清理都稳定
  getUiPrefs: () => invoke<Record<string, unknown>>("get_ui_prefs"),
  saveUiPrefs: (prefs: Record<string, unknown>) => invoke<void>("save_ui_prefs", { prefs }),
  tools: (range: Range) => invoke<ToolStat[]>("get_tools", { range: resolveRange(range) }),
  agents: (range: Range) => invoke<AgentStat[]>("get_agents", { range: resolveRange(range) }),
  errors: (range: Range) => invoke<ErrorStats>("get_errors", { range: resolveRange(range) }),
  latency: (range: Range) => invoke<LatencyStat[]>("get_latency", { range: resolveRange(range) }),
  activity: (range: Range) => invoke<HeatCell[]>("get_activity", { range: resolveRange(range) }),
  monthlyTrend: (range: Range) =>
    invoke<MonthPoint[]>("get_monthly_trend", { range: resolveRange(range) }),
  pricing: () => invoke<PricingConfig>("get_pricing"),
  savePricing: (config: PricingConfig) => invoke<PricingConfig>("save_pricing", { config }),
  // 价格估算:传当前编辑中的价格(未保存也可),后端按逐请求口径算该模型在范围内的金额(美元)
  estimateCost: (modelId: string, entry: PriceEntry, range: Range) =>
    invoke<number>("estimate_cost", { range: resolveRange(range), modelId, entry }),
};
