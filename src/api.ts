import { invoke } from "@tauri-apps/api/core";
import type {
  AgentStat,
  DailyActivityPoint,
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
  Summary,
  ToolStat,
  MonthPoint,
  TrendPoint,
  ZProviderAddResult,
  ZProviderConfig,
} from "../shared/types";

export interface Range {
  from?: number;
  to?: number;
}

// 数据查询走 Tauri invoke(Rust + rusqlite 只读直查),不再有 HTTP 后端
export const api = {
  summary: (range: Range) => invoke<Summary>("get_summary", { range }),
  trend: (range: Range) => invoke<TrendPoint[]>("get_trend", { range }),
  modelTrend: (range: Range) => invoke<ModelTrendPoint[]>("get_trend_by_model", { range }),
  providerTrend: (range: Range) => invoke<ProviderTrendPoint[]>("get_trend_by_provider", { range }),
  models: (range: Range) => invoke<ModelStat[]>("get_models", { range }),
  projects: (range: Range) => invoke<ProjectStat[]>("get_projects", { range }),
  providers: (range: Range) => invoke<ProviderStat[]>("get_providers", { range }),
  // 分页单位是根会话:每页返回 N 个主会话(含其子代理请求)
  requests: (range: Range, page: number, pageSize = 10) =>
    invoke<RequestLogResponse>("get_requests", { range, page, pageSize }),
  tools: (range: Range) => invoke<ToolStat[]>("get_tools", { range }),
  agents: (range: Range) => invoke<AgentStat[]>("get_agents", { range }),
  errors: (range: Range) => invoke<ErrorStats>("get_errors", { range }),
  latency: (range: Range) => invoke<LatencyStat[]>("get_latency", { range }),
  activity: (range: Range) => invoke<HeatCell[]>("get_activity", { range }),
  activityDaily: (range: Range) => invoke<DailyActivityPoint[]>("get_activity_daily", { range }),
  monthlyTrend: (range: Range) => invoke<MonthPoint[]>("get_monthly_trend", { range }),
  pricing: () => invoke<PricingConfig>("get_pricing"),
  savePricing: (config: PricingConfig) => invoke<PricingConfig>("save_pricing", { config }),
  // 价格估算:传当前编辑中的价格(未保存也可),后端按逐请求口径算该模型在范围内的金额(美元)
  estimateCost: (modelId: string, entry: PriceEntry, range: Range) =>
    invoke<number>("estimate_cost", { range, modelId, entry }),
  // zcode 供应商配置管理(读写 ~/.zcode/v2/config.json,后端自动备份);
  // 写命令返回写后的完整配置,直接用响应刷新列表
  providerConfig: () => invoke<ZProviderConfig>("get_provider_config"),
  // 新增自定义供应商(写入 config.json,后端自动备份),返回新 id 供前端展开
  addProvider: (name: string, kind: string, baseUrl: string | null, apiKey: string | null) =>
    invoke<ZProviderAddResult>("add_provider", { name, kind, baseUrl, apiKey }),
  // 删除自定义供应商(内置供应商后端会拒绝)
  removeProvider: (id: string) => invoke<ZProviderConfig>("remove_provider", { id }),
  setProviderEnabled: (id: string, enabled: boolean) =>
    invoke<ZProviderConfig>("set_provider_enabled", { id, enabled }),
  setProviderBaseUrl: (id: string, url: string | null) =>
    invoke<ZProviderConfig>("set_provider_base_url", { id, url }),
  setProviderApiKey: (id: string, key: string | null) =>
    invoke<ZProviderConfig>("set_provider_api_key", { id, key }),
  // 模型配置(供应商 models 映射的增删改);image/video 决定 modalities.input
  addProviderModel: (
    id: string,
    model: string,
    contextLimit: number | null,
    outputLimit: number | null,
    image: boolean,
    video: boolean,
  ) =>
    invoke<ZProviderConfig>("add_provider_model", { id, model, contextLimit, outputLimit, image, video }),
  removeProviderModel: (id: string, model: string) =>
    invoke<ZProviderConfig>("remove_provider_model", { id, model }),
  setProviderModelLimits: (id: string, model: string, contextLimit: number | null, outputLimit: number | null) =>
    invoke<ZProviderConfig>("set_provider_model_limits", { id, model, contextLimit, outputLimit }),
  setProviderModelInputModalities: (id: string, model: string, image: boolean, video: boolean) =>
    invoke<ZProviderConfig>("set_provider_model_input_modalities", { id, model, image, video }),
  // 从供应商接口拉取可用模型(OpenAI 兼容),再勾选批量导入
  fetchProviderModels: (id: string) => invoke<string[]>("fetch_provider_models", { id }),
  addProviderModels: (id: string, models: string[]) =>
    invoke<ZProviderConfig>("add_provider_models", { id, models }),
};
