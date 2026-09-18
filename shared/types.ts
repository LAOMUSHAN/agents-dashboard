// 前后端共享的类型定义

/** 长上下文加价:单次请求输入超过阈值时,该请求全部单价乘 multiplier */
export interface LongContextPrice {
  thresholdTokens: number;
  multiplier: number;
}

/** 峰谷时段窗口:本机时区的当日分钟数,半开区间 [startMin, endMin) */
export interface PeakWindow {
  startMin: number;
  endMin: number;
}

/**
 * 单个模型的峰谷定价:windows 列出的是 kind 指定的那一类时段,另一类即当日补集。
 * kind="peak" 时 windows 是峰时段、其余为谷时段;"offPeak" 反之。
 * 挂在该模型的价格条目上:没配 peak 的模型完全不参与峰谷计算
 */
export interface PeakPricing {
  /** 峰时段单价 = 谷时价 × multiplier */
  multiplier: number;
  kind: "peak" | "offPeak";
  windows: PeakWindow[];
}

/** 单个模型的价格(每百万 token);数值币种由 currency 决定,计算时统一折成美元 */
export interface PriceEntry {
  /** 谷时段单价;峰时段 = 该价 × peakMultiplier */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 价格数字的币种:"usd"(缺省) | "cny";费用展示币种也由价格表的币种推导 */
  currency?: string | null;
  /** 峰谷定价(缺省 = 该模型不区分峰谷,也不参与任何峰谷计算) */
  peak?: PeakPricing | null;
  /** 长上下文加价(缺省 = 不启用) */
  longContext?: LongContextPrice | null;
}

/** modelId -> 价格;未收录的模型视为"未配置价格",费用按 0 计 */
export type PricingMap = Record<string, PriceEntry>;

/** 定价配置:模型价格表 + 峰谷时段 + 汇率(金额统一以美元存储与计算) */
export interface PricingConfig {
  /** 旧字段:展示币种现在由价格表的币种在前端推导,这里只作兼容 */
  displayCurrency: string;
  /** 1 美元折合的人民币数(手工维护) */
  usdCnyRate: number;
  models: PricingMap;
}

export interface Summary {
  requests: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** 加权生成速度(tok/s)=Σ输出tokens ÷ ΣLLM耗时(秒);无耗时数据时为 null */
  tokensPerSec: number | null;
  /** 解码速度(tok/s)=Σ输出tokens ÷ Σ解码时长(秒),解码时长=总耗时−TTFT(DeepSeek harness 口径);无配对数据时为 null */
  decodeTokensPerSec: number | null;
  cost: number;
  /** 按美元定价的模型花掉的费用(美元) */
  costUsd: number;
  /** 按人民币定价的模型花掉的费用(人民币) */
  costCny: number;
  /** 缓存节省(美元):逐请求 Σ缓存读tokens ×(实际输入价 − 实际缓存读价)/1e6 */
  cacheSavings: number;
  /** 缓存节省中按美元定价模型省下的部分(美元) */
  cacheSavingsUsd: number;
  /** 缓存节省中按人民币定价模型省下的部分(人民币) */
  cacheSavingsCny: number;
  /** 出现过但没配置单价的模型列表 */
  unpricedModels: string[];
}

export interface TrendPoint {
  /** 分桶键,小时桶为 "2026-08-21T14:00",天桶为 "2026-08-21" */
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** 该桶内加权生成速度(tok/s);无耗时数据时为 null */
  tokensPerSec: number | null;
  /** 该桶内解码速度(tok/s),口径同上;无配对数据时为 null */
  decodeTokensPerSec: number | null;
  cost: number;
}

/** 按模型拆分的趋势点;models 覆盖该桶内出现过的所有模型 */
export interface ModelTrendPoint {
  bucket: string;
  /** modelId -> 该桶内总 token(input+output+缓存)、费用与生成速度 */
  models: Record<string, { tokens: number; cost: number; tokensPerSec: number | null; decodeTokensPerSec: number | null }>;
}

/** 按供应商拆分的趋势点;键为 provider_id,展示名由前端映射 */
export interface ProviderTrendPoint {
  bucket: string;
  /** providerId -> 该桶内总 token(input+output+缓存)、费用与生成速度 */
  providers: Record<string, { tokens: number; cost: number; tokensPerSec: number | null; decodeTokensPerSec: number | null }>;
}

export interface ModelStat {
  modelId: string;
  requests: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** 该模型加权生成速度(tok/s);无耗时数据时为 null */
  tokensPerSec: number | null;
  /** 该模型解码速度(tok/s),口径同上;无配对数据时为 null */
  decodeTokensPerSec: number | null;
  /** 该模型平均首 token 延迟(ms);无 TTFT 数据时为 null */
  avgTtftMs: number | null;
  cost: number;
  /** 该模型价格条目的币种("cny"/"usd";缺省 null 按美元)。费用列据此显示符号,与「模型单价」逐行单位一致 */
  currency?: string | null;
  priced: boolean;
  /** 该时间范围内 status='error' 的请求数(含被主统计过滤掉的非 completed 行);0 时前端显示 "—" */
  errors: number;
}

export interface ProjectStat {
  directory: string;
  name: string;
  requests: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  /** 该目录加权生成速度(tok/s);无耗时数据时为 null */
  tokensPerSec: number | null;
  /** 该目录解码速度(tok/s),口径同上;无配对数据时为 null */
  decodeTokensPerSec: number | null;
  /** 该目录平均首 token 延迟(ms);无 TTFT 数据时为 null */
  avgTtftMs: number | null;
  cost: number;
  /** 该目录下按美元定价的模型费用(美元) */
  costUsd: number;
  /** 该目录下按人民币定价的模型费用(人民币)。目录可能混用两种定价,两侧各自是真实金额 */
  costCny: number;
  /** 该时间范围内 status='error' 的请求数(含被主统计过滤掉的非 completed 行);0 时前端显示 "—" */
  errors: number;
}

/** 供应商下单个模型的明细(前端展开行用) */
export interface ProviderModelStat {
  modelId: string;
  requests: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  /** 该模型在该供应商下的加权生成速度(tok/s);无耗时数据时为 null */
  tokensPerSec: number | null;
  /** 该模型在该供应商下的解码速度(tok/s),口径同上;无配对数据时为 null */
  decodeTokensPerSec: number | null;
  /** 该模型在该供应商下的平均首 token 延迟(ms);无 TTFT 数据时为 null */
  avgTtftMs: number | null;
  cost: number;
  /** 该模型价格条目的币种;缺省 null 按美元。费用列符号与「模型单价」一致 */
  currency?: string | null;
}

/** 按供应商(provider_id)汇总的统计;name 来自 zcode 配置文件,未收录时等于 providerId */
export interface ProviderStat {
  providerId: string;
  name: string;
  requests: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  /** 该供应商加权生成速度(tok/s);无耗时数据时为 null */
  tokensPerSec: number | null;
  /** 该供应商解码速度(tok/s),口径同上;无配对数据时为 null */
  decodeTokensPerSec: number | null;
  /** 该供应商平均首 token 延迟(ms);无 TTFT 数据时为 null */
  avgTtftMs: number | null;
  cost: number;
  /** 该供应商下按美元定价的模型费用(美元) */
  costUsd: number;
  /** 该供应商下按人民币定价的模型费用(人民币);同一供应商可能混用两种定价 */
  costCny: number;
  /** 该时间范围内 status='error' 的请求数(含被主统计过滤掉的非 completed 行) */
  errors: number;
  /** 该供应商下各模型的明细,按总 tokens 降序 */
  models: ProviderModelStat[];
}

export interface RequestRow {
  /** model_usage.id 在 zcode 库里是 TEXT(如 usage_model_xxx) */
  id: string;
  startedAt: number;
  modelId: string;
  agent: string | null;
  status: string;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** 该次请求的生成速度 = 输出tokens ÷ 耗时(秒);无耗时数据时为 null */
  tokensPerSec: number | null;
  /** 该次请求的解码速度 = 输出tokens ÷ (耗时−TTFT)(秒);TTFT 缺失或差值 ≤0 时为 null */
  decodeTokensPerSec: number | null;
  cost: number;
  project: string;
  title: string | null;
  /** session.task_type;'subagent_child' = 该行来自子代理会话(zcode-Explore 等) */
  taskType?: string | null;
  /** 该行模型价格条目的币种("cny"/"usd";缺省 null 按美元)。费用列据此显示符号,与「模型单价」一致 */
  currency?: string | null;
}

/** 请求日志的一个分组 = 一个根会话(主会话)及其子代理会话的全部请求 */
export interface RequestGroup {
  sessionId: string;
  title: string | null;
  project: string;
  requests: RequestRow[];
}

export interface RequestLogResponse {
  /** 本页的会话分组,按最近活动倒序 */
  groups: RequestGroup[];
  /** 范围内根会话总数(分页单位是根会话) */
  total: number;
  page: number;
  pageSize: number;
}

/** 单个工具的调用统计(tool_usage 表) */
export interface ToolStat {
  toolName: string;
  calls: number;
  errors: number;
  cancelled: number;
  avgMs: number | null;
  maxMs: number | null;
}

/** 按代理(agent 列)汇总的统计;agent 为 null 表示该行未记录代理 */
export interface AgentStat {
  agent: string | null;
  requests: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** 该代理加权生成速度(tok/s);无耗时数据时为 null */
  tokensPerSec: number | null;
  /** 该代理解码速度(tok/s),口径同上;无配对数据时为 null */
  decodeTokensPerSec: number | null;
  /** 该代理平均首 token 延迟(ms);无 TTFT 数据时为 null */
  avgTtftMs: number | null;
  /** 该时间范围内 status='error' 的请求数;0 时前端显示 "-" */
  errors: number;
}

/** 一组同类型错误(error_type + error_code 相同) */
export interface ErrorGroup {
  errorType: string | null;
  errorCode: string | null;
  count: number;
  sampleMessage: string | null;
}

export interface ErrorStats {
  total: number;
  completed: number;
  error: number;
  cancelled: number;
  /** 用户手动取消的次数(包含在 cancelled 内) */
  cancelledByUser: number;
  /** 触发过重试的请求数 */
  retriedRequests: number;
  /** 上下文超限的请求数 */
  contextExceeded: number;
  groups: ErrorGroup[];
}

/** 单个模型的延迟指标(epoch ms) */
export interface LatencyStat {
  modelId: string;
  requests: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  /** 该模型加权生成速度(tok/s);无耗时数据时为 null */
  tokensPerSec: number | null;
  /** 该模型解码速度(tok/s),口径同上;无配对数据时为 null */
  decodeTokensPerSec: number | null;
}

/** 活跃热力图单元格:dow 0=周日…6=周六,hour 0-23,本地时间 */
export interface HeatCell {
  dow: number;
  hour: number;
  calls: number;
}

/** 按天活跃点(12 月日历用);day 格式 "YYYY-MM-DD",含全部状态 */
export interface DailyActivityPoint {
  day: string;
  calls: number;
  outputTokens: number;
}

/** 月粒度趋势点;bucket 格式 "YYYY-MM" */
export interface MonthPoint {
  bucket: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  tokensPerSec: number | null;
  decodeTokensPerSec: number | null;
  cost: number;
}

/** 供应商下单个模型的配置(config.json 里 models 映射的扁平化视图) */
export interface ZModelEntry {
  /** models 映射的 key,即模型名 */
  name: string;
  /** limit.context(上下文上限 token);字段缺失时为 null */
  contextLimit: number | null;
  /** limit.output */
  outputLimit: number | null;
  /** modalities.input 数组里含 "image" */
  inputImage: boolean;
  /** modalities.input 数组里含 "video" */
  inputVideo: boolean;
}

/** zcode 配置文件(~/.zcode/v2/config.json)里的单个供应商条目;apiKey 不回传明文 */
export interface ZProviderEntry {
  id: string;
  name: string;
  kind: string | null;
  source: string | null;
  /** id 以 "builtin:" 开头的是 zcode 内置供应商 */
  builtin: boolean;
  /** enabled 字段缺失视为启用(自定义供应商通常没有这个字段) */
  enabled: boolean;
  systemDisabledReason: string | null;
  baseURL: string | null;
  hasApiKey: boolean;
  /** apiKey 尾 4 位;密钥过短时为 null,界面只显示"已设置" */
  apiKeyHint: string | null;
  /** 该供应商可用的模型配置列表 */
  models: ZModelEntry[];
}

/** get_provider_config 的响应;path 用于界面提示配置文件位置 */
export interface ZProviderConfig {
  path: string;
  providers: ZProviderEntry[];
}

/** add_provider 的响应;newId 是新生成的供应商 key,前端用它定位并展开新行 */
export interface ZProviderAddResult {
  config: ZProviderConfig;
  newId: string;
}
