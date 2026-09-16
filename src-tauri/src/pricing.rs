use crate::types::{PeakPricing, PriceEntry, PricingConfig, PricingMap};
use std::path::{Path, PathBuf};

/// 请求发生时刻在本机时区的当日分钟数(0..1440)
fn local_minute(started_at_ms: i64) -> i64 {
    use chrono::{Local, TimeZone, Timelike};
    let dt = Local
        .timestamp_millis_opt(started_at_ms)
        .single()
        .unwrap_or_else(Local::now);
    dt.hour() as i64 * 60 + dt.minute() as i64
}

/// 该请求是否落在峰时段:windows 是 kind 指定的那一类时段,另一类即当日补集。
/// kind 取值 "peak" | "offPeak"(容忍 off_peak / off-peak 等写法)
fn is_peak(peak: &PeakPricing, started_at_ms: i64) -> bool {
    let min = local_minute(started_at_ms);
    let listed = peak
        .windows
        .iter()
        .any(|w| min >= w.start_min && min < w.end_min);
    if is_off_peak_kind(&peak.kind) {
        !listed
    } else {
        listed
    }
}

/// kind 是否为"列表里列的是谷时段";忽略大小写与分隔符差异
pub fn is_off_peak_kind(kind: &str) -> bool {
    let norm: String = kind
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    norm == "offpeak"
}

/// 内置的是估算价(美元/百万 token),仅供参考,请在界面里按实际价格修改
pub fn default_pricing() -> PricingMap {
    let mut m = PricingMap::new();
    let zero = |i: f64, o: f64, r: f64| PriceEntry {
        input: i,
        output: o,
        cache_read: r,
        cache_write: 0.0,
        currency: None,
        peak: None,
        long_context: None,
    };
    m.insert("glm-5.3".into(), zero(0.6, 2.2, 0.11));
    m.insert("kimi-k3".into(), zero(0.6, 2.5, 0.15));
    m.insert("x-preview-f-free".into(), zero(0.0, 0.0, 0.0));
    m
}

pub fn default_config() -> PricingConfig {
    PricingConfig {
        models: default_pricing(),
        ..Default::default()
    }
}

/// 首次启动迁移:app 配置目录还没有 pricing.json 时,优先复制 Web 版遗留的
/// data/pricing.json(仅本地开发时存在;release 包不把编译机路径烙进二进制),
/// 否则写入默认价
pub fn ensure_migrated(path: &Path) {
    if path.exists() {
        return;
    }
    #[cfg(debug_assertions)]
    {
        let legacy = Path::new(env!("CARGO_MANIFEST_DIR")).join("../data/pricing.json");
        if legacy.exists() {
            let _ = std::fs::copy(&legacy, path);
            return;
        }
    }
    let _ = save(path, &default_config());
}

/// 读取配置。兼容两种落盘形态:
/// - 旧格式 = 扁平的 { modelId: 价格 }
/// - 新格式 = { displayCurrency, usdCnyRate, models: { modelId: 价格 } }
/// 注意:必须按是否存在顶层 models 键区分——旧格式也能被 serde "成功" 解析成
/// PricingConfig(未知键被忽略、models 取默认空表),那样会把价格静默读空
pub fn load(path: &Path) -> PricingConfig {
    if let Some(text) = std::fs::read_to_string(path).ok() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if value.get("models").is_some() {
                if let Ok(cfg) = serde_json::from_value::<PricingConfig>(value) {
                    return cfg;
                }
            } else if let Ok(models) = serde_json::from_value::<PricingMap>(value) {
                // 旧格式迁移:扁平价格表按美元解释。只在内存完成,不主动回写——
                // 否则旧版本客户端读到新格式会解析失败并回退成默认价,覆盖用户配置
                return PricingConfig {
                    models,
                    ..Default::default()
                };
            }
        }
    }
    let d = default_config();
    let _ = save(path, &d);
    d
}

/// 保存前留一份 .bak,避免写坏配置时丢价格
pub fn save(path: &Path, cfg: &PricingConfig) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if path.exists() {
        let _ = std::fs::copy(path, backup_path(path));
    }
    let mut json = serde_json::to_string_pretty(cfg).unwrap();
    json.push('\n');
    std::fs::write(path, json)
}

fn backup_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_os_string();
    p.push(".bak");
    PathBuf::from(p)
}

/// 非有限值(NaN/Inf)归 0,对齐旧版 `Number(x) || 0` 的清洗
pub fn clean(v: f64) -> f64 {
    if v.is_finite() { v } else { 0.0 }
}

/// 该价格表条目是否以人民币计价(缺省按美元)
pub fn is_cny_currency(currency: Option<&str>) -> bool {
    matches!(
        currency.map(|c| c.trim().to_ascii_lowercase()).as_deref(),
        Some("cny") | Some("rmb") | Some("¥")
    )
}

impl PricingConfig {
    /// 价格表里的数字按其币种折算成美元的系数(人民币价 ÷ 汇率)
    fn currency_ratio(&self, currency: Option<&str>) -> f64 {
        if is_cny_currency(currency) && self.usd_cny_rate > 0.0 {
            1.0 / self.usd_cny_rate
        } else {
            1.0
        }
    }

    /// 命中该请求的单价档(谷时基准价 → 峰时段倍率 → 长上下文系数),单位统一为美元/百万 token。
    /// 峰谷:价格表填的是谷时段价,峰时段按该模型的 peak.multiplier 上浮。
    /// 未启用峰谷的模型直接跳过——连时区换算都不做
    fn price_for(&self, entry: &PriceEntry, started_at_ms: i64, input_tokens: i64) -> (f64, f64, f64, f64) {
        let k = self.currency_ratio(entry.currency.as_deref());
        let mut q = (entry.input * k, entry.output * k, entry.cache_read * k, entry.cache_write * k);
        if let Some(p) = &entry.peak {
            if p.multiplier > 0.0 && p.multiplier.is_finite() && is_peak(p, started_at_ms) {
                let m = p.multiplier;
                q = (q.0 * m, q.1 * m, q.2 * m, q.3 * m);
            }
        }
        match &entry.long_context {
            Some(lc) if lc.threshold_tokens > 0 && input_tokens >= lc.threshold_tokens => {
                let m = if lc.multiplier > 0.0 && lc.multiplier.is_finite() { lc.multiplier } else { 1.0 };
                (q.0 * m, q.1 * m, q.2 * m, q.3 * m)
            }
            _ => q,
        }
    }

    /// 单请求计费(唯一计费入口),返回 (美元金额, 该模型是否配置了价格)
    ///
    /// 关键口径:zcode 的 input_tokens 是**含缓存命中**的总 prompt(OpenAI usage 口径,
    /// raw_usage_json 里 totalTokens = inputTokens + outputTokens,cacheReadTokens 是 inputTokens 的子集),
    /// 因此输入价只能作用于未命中部分 (input − cache_read),否则命中部分会被计两次。
    pub fn cost_row(
        &self,
        model_id: &str,
        started_at_ms: i64,
        input_tokens: i64,
        output_tokens: i64,
        cache_read_tokens: i64,
        cache_create_tokens: i64,
    ) -> (f64, bool) {
        let r = self.row_cost(model_id, started_at_ms, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens);
        (r.cost, r.priced)
    }

    /// 单请求的费用与缓存节省,共用同一套实际单价。
    /// 缓存节省 = 缓存读 tokens × (实际输入价 − 实际缓存读价):命中部分若不按缓存读价
    /// 而是按输入价计费本应多花的钱。价格表里的数字币种不同、峰谷/长上下文加价不同
    /// 都会改变这四项单价,因此必须与实际计费走同一个 price_for。
    pub fn row_cost(
        &self,
        model_id: &str,
        started_at_ms: i64,
        input_tokens: i64,
        output_tokens: i64,
        cache_read_tokens: i64,
        cache_create_tokens: i64,
    ) -> RowCost {
        let Some(entry) = self.models.get(model_id) else {
            return RowCost { cost: 0.0, saving: 0.0, priced: false, is_cny: false };
        };
        let (p_in, p_out, p_read, p_write) = self.price_for(entry, started_at_ms, input_tokens);
        let miss = (input_tokens - cache_read_tokens).max(0) as f64;
        let read = cache_read_tokens.max(0) as f64;
        let cost = (miss * p_in
            + output_tokens.max(0) as f64 * p_out
            + read * p_read
            + cache_create_tokens.max(0) as f64 * p_write)
            / 1e6;
        // 缓存读价高于输入价(异常配置)时视为没有节省
        let saving = read * (p_in - p_read).max(0.0) / 1e6;
        RowCost { cost, saving, priced: true, is_cny: is_cny_currency(entry.currency.as_deref()) }
    }
}

/// 单请求计费结果;费用与缓存节省同源,避免两处口径漂移
pub struct RowCost {
    pub cost: f64,
    pub saving: f64,
    pub priced: bool,
    /// 该模型的价格表条目是否以人民币计价(合计要按币种分开统计时用)
    pub is_cny: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(i: f64, o: f64, r: f64) -> PriceEntry {
        PriceEntry {
            input: i,
            output: o,
            cache_read: r,
            cache_write: 0.0,
            currency: None,
            peak: None,
            long_context: None,
        }
    }

    /// 新格式落盘后可原样读回(币种/汇率/倍率/加价);
    /// 旧扁平格式按美元解释且**不被读成空表**,也不主动回写
    #[test]
    fn config_roundtrip_and_legacy_format() {
        let dir = std::env::temp_dir();
        let p = dir.join("agents-dashboard-test-pricing-cfg.json");
        let _ = std::fs::remove_file(&p);
        let mut cfg = default_config();
        cfg.display_currency = "cny".into();
        cfg.usd_cny_rate = 7.2;
        let mut e = entry(1.0, 2.0, 0.1);
        e.currency = Some("cny".into());
        e.peak = Some(crate::types::PeakPricing {
            multiplier: 2.0,
            kind: "peak".into(),
            windows: vec![crate::types::PeakWindow { start_min: 8 * 60, end_min: 12 * 60 }],
        });
        e.long_context = Some(crate::types::LongContextPrice { threshold_tokens: 270_000, multiplier: 2.0 });
        cfg.models.insert("m".into(), e);
        save(&p, &cfg).expect("save");

        let back = load(&p);
        assert_eq!(back.display_currency, "cny");
        assert!((back.usd_cny_rate - 7.2).abs() < 1e-9);
        let back_peak = back.models["m"].peak.as_ref().expect("peak 应往返");
        assert_eq!(back_peak.multiplier, 2.0);
        assert_eq!(back_peak.windows.len(), 1);
        assert_eq!(back.models["m"].long_context.as_ref().unwrap().threshold_tokens, 270_000);

        // 旧扁平格式:不得被解析成空价格表
        let legacy = dir.join("agents-dashboard-test-pricing-legacy.json");
        let legacy_text = r#"{"glm-5.3":{"input":0.6,"output":2.2,"cacheRead":0.11,"cacheWrite":0.0}}"#;
        std::fs::write(&legacy, legacy_text).expect("write legacy");
        let l = load(&legacy);
        assert_eq!(l.display_currency, "usd");
        assert_eq!(l.models.len(), 1);
        assert!((l.models["glm-5.3"].input - 0.6).abs() < 1e-9);
        // 迁移不落盘:文件内容保持旧格式,旧客户端仍可读
        assert_eq!(std::fs::read_to_string(&legacy).unwrap().trim(), legacy_text);

        let _ = std::fs::remove_file(&legacy);
        let _ = std::fs::remove_file(&p);
    }

    /// 展示币种折算系数:人民币时按汇率折算,否则为 1
    #[test]
    fn currency_ratio_folds_cny_to_usd() {
        let mut cfg = default_config();
        cfg.usd_cny_rate = 7.0;
        let mut e = entry(7.0, 7.0, 7.0);
        e.currency = Some("cny".into());
        cfg.models.insert("cny-model".into(), e);
        cfg.models.insert("usd-model".into(), entry(1.0, 1.0, 1.0));
        // 人民币价 ÷ 7 与 1 美元价等价
        let (a, _) = cfg.cost_row("cny-model", 0, 1_000_000, 0, 0, 0);
        let (b, _) = cfg.cost_row("usd-model", 0, 1_000_000, 0, 0, 0);
        assert!((a - b).abs() < 1e-9, "cny={a} usd={b}");
        // 缺省(无 currency 字段)按美元解释
        let mut d = default_config();
        d.models.insert("x".into(), entry(1.0, 1.0, 1.0));
        let (c, _) = d.cost_row("x", 0, 1_000_000, 0, 0, 0);
        assert!((c - 1.0).abs() < 1e-9);
    }

    /// 按币种分账靠 is_cny 标记,别名识别必须与折算口径一致(否则合计会归错一边)
    #[test]
    fn row_cost_marks_cny_entry() {
        let mut cfg = default_config();
        let mut cny = entry(7.0, 7.0, 7.0);
        cny.currency = Some(" RMB ".into());
        cfg.models.insert("cny-model".into(), cny);
        cfg.models.insert("usd-model".into(), entry(1.0, 1.0, 1.0));
        assert!(cfg.row_cost("cny-model", 0, 1, 1, 0, 0).is_cny);
        assert!(!cfg.row_cost("usd-model", 0, 1, 1, 0, 0).is_cny);
        // 未配置单价的模型不参与任何一侧的合计
        assert!(!cfg.row_cost("missing", 0, 1, 1, 0, 0).is_cny);

        assert!(is_cny_currency(Some("CNY")));
        assert!(is_cny_currency(Some("¥")));
        assert!(!is_cny_currency(Some("usd")));
        assert!(!is_cny_currency(None));
    }
}
