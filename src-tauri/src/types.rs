use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 长上下文加价:单次请求输入超过 threshold_tokens 时,该请求全部单价乘 multiplier
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongContextPrice {
    pub threshold_tokens: i64,
    pub multiplier: f64,
}

/// 峰谷时段窗口:本机时区的当日分钟数(0..=1440),半开区间 [start, end)。
/// 跨天请拆成两条(如 22:00–06:00 写成 22:00–24:00 与 00:00–06:00)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PeakWindow {
    pub start_min: i64,
    pub end_min: i64,
}

/// 单个模型的峰谷定价。windows 列出的是 kind 指定的那一类时段,另一类自动取当日补集:
/// kind = "peak" 时 windows 为峰时段、其余为谷时段;"offPeak" 反之。
/// 它挂在 PriceEntry 上,只有启用了的模型才进入峰谷判定——未启用的模型连时段都不算
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeakPricing {
    /// 峰时段单价 = 谷时价 × multiplier
    pub multiplier: f64,
    #[serde(default = "default_peak_kind")]
    pub kind: String,
    #[serde(default = "default_peak_windows")]
    pub windows: Vec<PeakWindow>,
}

impl Default for PeakPricing {
    fn default() -> Self {
        PeakPricing {
            multiplier: 2.0,
            kind: default_peak_kind(),
            windows: default_peak_windows(),
        }
    }
}

fn default_peak_kind() -> String {
    "peak".to_string()
}

/// 默认峰时段:08:00–12:00 与 14:00–18:00,其余为谷时段
fn default_peak_windows() -> Vec<PeakWindow> {
    vec![
        PeakWindow { start_min: 8 * 60, end_min: 12 * 60 },
        PeakWindow { start_min: 14 * 60, end_min: 18 * 60 },
    ]
}

/// 单个模型的价格(每百万 token)。数值币种由 currency 决定("usd" 缺省/"cny"),计算时统一折成美元
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceEntry {
    /// 谷时段的四项单价;峰时段 = 该价 × peak.multiplier
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    /// 价格数字的币种;缺省按美元。仅影响该项折算,不改展示币种
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    /// 峰谷定价(缺省 = 该模型不区分峰谷,也不参与任何峰谷计算)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peak: Option<PeakPricing>,
    /// 长上下文加价(缺省 = 不启用)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long_context: Option<LongContextPrice>,
}

/// modelId -> 价格;未收录的模型视为"未配置价格",费用按 0 计
pub type PricingMap = BTreeMap<String, PriceEntry>;

fn default_currency() -> String {
    "usd".to_string()
}

fn default_rate() -> f64 {
    7.1
}

/// 定价配置:模型价格表 + 汇率。价格一律以美元参与计算
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingConfig {
    /// 展示币种:由价格表的币种在前端推导,本字段仅作旧配置兼容
    #[serde(default = "default_currency")]
    pub display_currency: String,
    /// 1 美元折合的人民币数(手工维护)
    #[serde(default = "default_rate")]
    pub usd_cny_rate: f64,
    #[serde(default)]
    pub models: PricingMap,
}

impl Default for PricingConfig {
    fn default() -> Self {
        PricingConfig {
            display_currency: default_currency(),
            usd_cny_rate: default_rate(),
            models: PricingMap::new(),
        }
    }
}

/// 加权生成速度(tok/s)= Σ输出tokens ÷ ΣLLM耗时(秒);耗时缺失或 ≤0 时为 None
pub fn weighted_tokens_per_sec(output_tokens: i64, duration_ms: Option<i64>) -> Option<f64> {
    match duration_ms {
        Some(d) if d > 0 => Some(output_tokens as f64 / (d as f64 / 1000.0)),
        _ => None,
    }
}

/// 单请求解码时长(deepseek harness 口径)= 总耗时 − TTFT;任一缺失或差值 ≤0 时为 None。
/// 另设流式门禁:解码时长 < 输出tokens(ms) 等价于隐含速度 > 1000 tok/s,判定为整包缓冲的
/// 非流式响应(整段输出随首 chunk 一次到达,decode 段只剩网络传输),同样返回 None
pub fn decode_ms_of(duration_ms: Option<i64>, ttft_ms: Option<i64>, output_tokens: i64) -> Option<i64> {
    match (duration_ms, ttft_ms) {
        (Some(d), Some(t)) if d - t > 0 && d - t >= output_tokens && output_tokens > 0 => Some(d - t),
        _ => None,
    }
}

/// 时间范围(epoch ms,闭区间),来自前端筛选
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct Range {
    pub from: Option<i64>,
    pub to: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub requests: i64,
    pub sessions: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_tokens: i64,
    /// 加权生成速度(tok/s)=Σ输出tokens ÷ ΣLLM耗时(秒);无耗时数据时为 None
    pub tokens_per_sec: Option<f64>,
    /// 解码速度(tok/s)=Σ输出tokens ÷ Σ解码时长(秒),解码时长=总耗时−TTFT(deepseek harness 口径);无配对数据时为 None
    pub decode_tokens_per_sec: Option<f64>,
    pub cost: f64,
    /// 按美元定价的模型花掉的费用(美元);与 cost_cny 是两个独立金额,不是同一总额的两种换算
    pub cost_usd: f64,
    /// 按人民币定价的模型花掉的费用(人民币,已按汇率从美元口径折算)
    pub cost_cny: f64,
    /// 缓存节省(美元):逐请求 Σ 缓存读tokens × (实际输入价 − 实际缓存读价)/1e6,
    /// 与实际计费同口径(含币种折算、峰谷与长上下文加价),负值截断为 0
    pub cache_savings: f64,
    /// 缓存节省中按美元定价模型省下的部分(美元)
    pub cache_savings_usd: f64,
    /// 缓存节省中按人民币定价模型省下的部分(人民币,已按汇率从美元口径折算)
    pub cache_savings_cny: f64,
    /// 出现过但没配置单价的模型列表
    pub unpriced_models: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    pub bucket: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_tokens: i64,
    /// 该桶内加权生成速度(tok/s);无耗时数据时为 None
    pub tokens_per_sec: Option<f64>,
    /// 该桶内解码速度(tok/s),口径同上;无配对数据时为 None
    pub decode_tokens_per_sec: Option<f64>,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenCost {
    pub tokens: i64,
    pub cost: f64,
    /// 该模型/供应商加权生成速度(tok/s);无耗时数据时为 None
    pub tokens_per_sec: Option<f64>,
    /// 该模型/供应商解码速度(tok/s),口径同上;无配对数据时为 None
    pub decode_tokens_per_sec: Option<f64>,
}

/// 按模型拆分的趋势点;models 覆盖该桶内出现过的所有模型
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTrendPoint {
    pub bucket: String,
    pub models: BTreeMap<String, TokenCost>,
}

/// 按供应商拆分的趋势点;键为 provider_id,展示名由前端映射
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTrendPoint {
    pub bucket: String,
    pub providers: BTreeMap<String, TokenCost>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStat {
    pub model_id: String,
    pub requests: i64,
    pub sessions: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_tokens: i64,
    /// 该模型加权生成速度(tok/s);无耗时数据时为 None
    pub tokens_per_sec: Option<f64>,
    /// 该模型解码速度(tok/s),口径同上;无配对数据时为 None
    pub decode_tokens_per_sec: Option<f64>,
    /// 该模型平均首 token 延迟(ms);无 TTFT 数据时为 None
    pub avg_ttft_ms: Option<i64>,
    pub cost: f64,
    /// 该模型价格表条目的币种("cny"/"usd";缺省 None 按美元)。费用列据此决定展示符号,
    /// 与「模型单价」面板逐行显示的币种一致
    pub currency: Option<String>,
    pub priced: bool,
    /// 该时间范围内 status='error' 的请求数(含被主统计过滤掉的非 completed 行)
    pub errors: i64,
}

/// 按代理(agent 列)汇总的统计;agent 为 None 表示该行未记录代理
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStat {
    pub agent: Option<String>,
    pub requests: i64,
    pub sessions: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_tokens: i64,
    /// 该代理加权生成速度(tok/s);无耗时数据时为 None
    pub tokens_per_sec: Option<f64>,
    /// 该代理解码速度(tok/s),口径同上;无配对数据时为 None
    pub decode_tokens_per_sec: Option<f64>,
    /// 该代理平均首 token 延迟(ms);无 TTFT 数据时为 None
    pub avg_ttft_ms: Option<i64>,
    /// 该时间范围内 status='error' 的请求数(含被主统计过滤掉的非 completed 行)
    pub errors: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStat {
    pub directory: String,
    pub name: String,
    pub requests: i64,
    pub sessions: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_tokens: i64,
    pub total_tokens: i64,
    /// 该目录加权生成速度(tok/s);无耗时数据时为 None
    pub tokens_per_sec: Option<f64>,
    /// 该目录解码速度(tok/s),口径同上;无配对数据时为 None
    pub decode_tokens_per_sec: Option<f64>,
    /// 该目录平均首 token 延迟(ms);无 TTFT 数据时为 None
    pub avg_ttft_ms: Option<i64>,
    pub cost: f64,
    /// 分币种合计:该目录下按人民币定价的模型费用(人民币)与按美元定价的费用(美元)。
    /// 两者各自是真实金额,不是同一个总额的两种换算——目录下可能混用两种定价
    pub cost_usd: f64,
    pub cost_cny: f64,
    /// 该时间范围内 status='error' 的请求数(含被主统计过滤掉的非 completed 行)
    pub errors: i64,
}

/// 供应商下单个模型的明细(前端展开行用)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelStat {
    pub model_id: String,
    pub requests: i64,
    pub sessions: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_tokens: i64,
    pub total_tokens: i64,
    /// 该模型在该供应商下的加权生成速度(tok/s);无耗时数据时为 None
    pub tokens_per_sec: Option<f64>,
    /// 该模型在该供应商下的解码速度(tok/s),口径同上;无配对数据时为 None
    pub decode_tokens_per_sec: Option<f64>,
    /// 该模型在该供应商下的平均首 token 延迟(ms);无 TTFT 数据时为 None
    pub avg_ttft_ms: Option<i64>,
    pub cost: f64,
    /// 该模型价格表条目的币种;缺省 None 按美元。费用列展示符号与「模型单价」一致
    pub currency: Option<String>,
}

/// 按供应商(provider_id)汇总的统计;name 来自 zcode 配置文件,未收录时等于 provider_id
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStat {
    pub provider_id: String,
    pub name: String,
    pub requests: i64,
    pub sessions: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_tokens: i64,
    pub total_tokens: i64,
    /// 该供应商加权生成速度(tok/s);无耗时数据时为 null
    pub tokens_per_sec: Option<f64>,
    /// 该供应商解码速度(tok/s),口径同上;无耗时数据时为 null
    pub decode_tokens_per_sec: Option<f64>,
    /// 该供应商平均首 token 延迟(ms);无 TTFT 数据时为 null
    pub avg_ttft_ms: Option<i64>,
    pub cost: f64,
    /// 分币种合计:该供应商下人民币定价模型费用(人民币)与美元定价模型费用(美元),
    /// 各自是真实金额(一个供应商可能同时提供两种币种定价的模型)
    pub cost_usd: f64,
    pub cost_cny: f64,
    /// 该时间范围内 status='error' 的请求数(含被主统计过滤掉的非 completed 行)
    pub errors: i64,
    /// 该供应商下各模型的明细,按总 tokens 降序
    pub models: Vec<ProviderModelStat>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRow {
    /// model_usage.id 在 zcode 库里是 TEXT(如 usage_model_xxx),不是整数
    pub id: String,
    pub started_at: i64,
    pub model_id: String,
    pub agent: Option<String>,
    pub status: String,
    pub duration_ms: Option<i64>,
    pub time_to_first_token_ms: Option<i64>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_tokens: i64,
    /// 该次请求的生成速度 = 输出tokens ÷ 耗时(秒);无耗时数据时为 None
    pub tokens_per_sec: Option<f64>,
    /// 该次请求的解码速度 = 输出tokens ÷ (耗时−TTFT)(秒);TTFT 缺失或差值 ≤0 时为 None
    pub decode_tokens_per_sec: Option<f64>,
    pub cost: f64,
    pub project: String,
    pub title: Option<String>,
    /// session.task_type;'subagent_child' 表示该行来自子代理会话(zcode-Explore 等)
    pub task_type: Option<String>,
    /// 该行模型价格条目的币种("cny"/"usd";缺省 None 按美元)。
    /// 费用列据此决定符号,与「模型单价」面板同一模型显示的单位一致
    pub currency: Option<String>,
}

/// 请求日志分组 = 一个根会话及其子代理会话的全部请求
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestGroup {
    pub session_id: String,
    pub title: Option<String>,
    pub project: String,
    pub requests: Vec<RequestRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogResponse {
    pub groups: Vec<RequestGroup>,
    /// 范围内根会话总数(分页单位是根会话)
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

/// 单个工具的调用统计(tool_usage 表)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStat {
    pub tool_name: String,
    pub calls: i64,
    pub errors: i64,
    pub cancelled: i64,
    pub avg_ms: Option<i64>,
    pub max_ms: Option<i64>,
}

/// 一组同类型错误(error_type + error_code 相同);空串与 null 的区分沿用了旧版口径(COALESCE 为空串)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorGroup {
    pub error_type: String,
    pub error_code: String,
    pub count: i64,
    pub sample_message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorStats {
    pub total: i64,
    pub completed: i64,
    pub error: i64,
    pub cancelled: i64,
    /// 用户手动取消的次数(包含在 cancelled 内)
    pub cancelled_by_user: i64,
    /// 触发过重试的请求数
    pub retried_requests: i64,
    /// 上下文超限的请求数
    pub context_exceeded: i64,
    pub groups: Vec<ErrorGroup>,
}

/// 单个模型的延迟指标(epoch ms)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyStat {
    pub model_id: String,
    pub requests: i64,
    pub avg_ms: Option<i64>,
    pub p50_ms: Option<i64>,
    pub p95_ms: Option<i64>,
    pub ttft_p50_ms: Option<i64>,
    pub ttft_p95_ms: Option<i64>,
    /// 该模型加权生成速度(tok/s);无耗时数据时为 None
    pub tokens_per_sec: Option<f64>,
    /// 该模型解码速度(tok/s),口径同上;无配对数据时为 None
    pub decode_tokens_per_sec: Option<f64>,
}

/// 活跃热力图单元格:dow 0=周日…6=周六,hour 0-23,本地时间
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatCell {
    pub dow: i64,
    pub hour: i64,
    pub calls: i64,
}

/// 按天活跃点(12 月日历用);day 格式 "YYYY-MM-DD",含全部状态
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyActivityPoint {
    pub day: String,
    pub calls: i64,
    pub output_tokens: i64,
}

/// 月粒度趋势点;bucket 格式 "YYYY-MM"
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthPoint {
    pub bucket: String,
    pub requests: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_tokens: i64,
    pub tokens_per_sec: Option<f64>,
    pub decode_tokens_per_sec: Option<f64>,
    pub cost: f64,
}

/// 供应商下单个模型的配置(config.json 里 models 映射的扁平化视图)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZModelEntry {
    /// models 映射的 key,即模型名
    pub name: String,
    /// limit.context(上下文上限 token);字段缺失时为 None
    pub context_limit: Option<i64>,
    /// limit.output
    pub output_limit: Option<i64>,
    /// modalities.input 数组里含 "image"
    pub input_image: bool,
    /// modalities.input 数组里含 "video"
    pub input_video: bool,
}

/// zcode 配置文件(~/.zcode/v2/config.json)里的单个供应商条目。
/// 只是配置的只读投影:apiKey 绝不回传明文,只有 hasApiKey 和尾号 hint
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZProviderEntry {
    pub id: String,
    pub name: String,
    pub kind: Option<String>,
    pub source: Option<String>,
    /// id 以 "builtin:" 开头的是 zcode 内置供应商
    pub builtin: bool,
    /// enabled 字段缺失视为启用(自定义供应商通常没有这个字段)
    pub enabled: bool,
    pub system_disabled_reason: Option<String>,
    /// 显式改名:serde 的 camelCase 会把 base_url 变成 baseUrl,
    /// 而 zcode 配置和前端约定都是 baseURL(大写 URL)
    #[serde(rename = "baseURL")]
    pub base_url: Option<String>,
    pub has_api_key: bool,
    /// apiKey 尾 4 位;密钥过短时为 None,前端显示"已设置"
    pub api_key_hint: Option<String>,
    /// 该供应商可用的模型配置列表
    pub models: Vec<ZModelEntry>,
}

/// get_provider_config 的响应;path 用于界面提示配置文件位置
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZProviderConfig {
    pub path: String,
    pub providers: Vec<ZProviderEntry>,
}
