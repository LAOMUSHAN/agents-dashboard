use crate::pricing;
use crate::types::*;
use rusqlite::{params_from_iter, Connection};
use std::collections::{BTreeMap, HashMap};

// model_usage 一行 = 一次模型调用;子代理会话通过 parent_id 挂到父会话的项目上
const FROM_CLAUSE: &str = "
  FROM model_usage mu
  JOIN session s ON s.id = mu.session_id
  LEFT JOIN session p ON p.id = s.parent_id
";

const PROJECT_DIR: &str = "COALESCE(p.directory, s.directory)";
const SESSION_KEY: &str = "COALESCE(s.parent_id, mu.session_id)";

/// 组合键分隔符(bucket × model 等);控制字符不会出现在模型名/供应商名里
const KEY_SEP: char = '\x1f';

fn build_where(range: &Range) -> (String, Vec<i64>) {
    let mut conds = vec!["mu.status = 'completed'".to_string()];
    let mut params: Vec<i64> = vec![];
    if let Some(from) = range.from {
        conds.push("mu.started_at >= ?".into());
        params.push(from);
    }
    if let Some(to) = range.to {
        conds.push("mu.started_at <= ?".into());
        params.push(to);
    }
    (format!("WHERE {}", conds.join(" AND ")), params)
}

/// 只按时间范围生成条件(不过滤状态),供错误/工具/热力图等统计自行组合
fn range_conds(col: &str, range: &Range) -> (Vec<String>, Vec<i64>) {
    let mut conds: Vec<String> = vec![];
    let mut params: Vec<i64> = vec![];
    if let Some(from) = range.from {
        conds.push(format!("{col} >= ?"));
        params.push(from);
    }
    if let Some(to) = range.to {
        conds.push(format!("{col} <= ?"));
        params.push(to);
    }
    (conds, params)
}

fn query_rows<T>(
    conn: &Connection,
    sql: &str,
    params: &[i64],
    map: impl Fn(&rusqlite::Row) -> rusqlite::Result<T>,
) -> rusqlite::Result<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params_from_iter(params.iter().copied()), map)?;
    rows.collect()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// 价格估算:用给定配置对某模型在范围内的请求逐行计价求和(只读,不落库)。
/// 供设置界面「价格估算」使用,口径与正式计费完全一致
pub fn cost_in_range(
    conn: &Connection,
    range: &Range,
    cfg: &PricingConfig,
    model_id: &str,
) -> rusqlite::Result<f64> {
    let (where_sql, params) = build_where(range);
    let mut stmt = conn.prepare(&format!(
        "SELECT mu.started_at, mu.input_tokens, mu.output_tokens,
                mu.cache_read_input_tokens, mu.cache_creation_input_tokens
         {FROM_CLAUSE} {where_sql} AND mu.model_id = ?"
    ))?;
    let mut binds: Vec<rusqlite::types::Value> = params
        .iter()
        .map(|v| rusqlite::types::Value::Integer(*v))
        .collect();
    binds.push(rusqlite::types::Value::Text(model_id.to_string()));
    let rows = stmt.query_map(params_from_iter(binds.iter()), |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, Option<i64>>(1)?.unwrap_or(0),
            r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            r.get::<_, Option<i64>>(3)?.unwrap_or(0),
            r.get::<_, Option<i64>>(4)?.unwrap_or(0),
        ))
    })?;
    let mut total = 0.0;
    for row in rows {
        let (ts, i, o, cr, cw) = row?;
        total += cfg.cost_row(model_id, ts, i, o, cr, cw).0;
    }
    Ok(total)
}

pub fn earliest_timestamp(conn: &Connection) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT MIN(started_at) FROM model_usage", [], |r| r.get(0))
}

/// 逐请求计价后按 key 聚合的费用(唯一计费路径)。
/// 分段价(峰谷/长上下文)无法由「聚合 tokens × 单价」还原,故一律先按请求算价再聚合;
/// key_expr 是 SQL 表达式(如 mu.model_id、PROJECT_DIR、时间桶表达式),
/// 多列组合键用 char(1) 拼接。返回 (key→美元金额, 出现过但未配置单价的模型集合)
/// 逐请求计价的聚合结果:按 key 分组的费用 + 未配置价格的模型 + 缓存节省总额
struct CostAgg {
    /// key → 费用合计(美元口径,两种币种定价的模型都折成美元后相加)
    cost: HashMap<String, f64>,
    /// key → 其中按人民币定价的模型那部分(美元口径)。与 cost 相减即美元定价部分,
    /// 展示时再乘汇率还原成人民币——分组行可能同时含两种币种的模型,必须分开留存
    cost_cny_usd: HashMap<String, f64>,
    unpriced: std::collections::BTreeSet<String>,
    savings: f64,
    /// 缓存节省同样按币种归属:美元价模型省下的(美元) / 人民币价模型省下的(美元口径)
    savings_usd_priced: f64,
    savings_cny_priced_usd: f64,
}

fn cost_rows(
    conn: &Connection,
    range: &Range,
    cfg: &PricingConfig,
    key_expr: &str,
    join_session: bool,
) -> rusqlite::Result<CostAgg> {
    let (where_sql, params) = build_where(range);
    // 只有按项目目录分组时才需要 join session；其余 key 全在 model_usage 里，
    // 省掉 7 万行的两次索引查找。
    let from_clause = if join_session { FROM_CLAUSE } else { "FROM model_usage mu" };
    let rows = query_rows(
        conn,
        &format!(
            "SELECT {key_expr} AS k, mu.model_id, mu.started_at,
                    mu.input_tokens, mu.output_tokens,
                    mu.cache_read_input_tokens, mu.cache_creation_input_tokens
             {from_clause} {where_sql}"
        ),
        &params,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                r.get::<_, Option<i64>>(6)?.unwrap_or(0),
            ))
        },
    )?;
    let mut cost: HashMap<String, f64> = HashMap::new();
    let mut cost_cny_usd: HashMap<String, f64> = HashMap::new();
    let mut unpriced: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut savings = 0.0;
    let mut savings_usd_priced = 0.0;
    let mut savings_cny_priced_usd = 0.0;
    // 同一分钟内的请求共用一次时区换算：7 万行通常只落在几百个分钟上
    let mut minute_cache: HashMap<i64, i64> = HashMap::new();
    for (k, model, ts, i, o, cr, cw) in rows {
        let minute = *minute_cache
            .entry(ts / 60_000)
            .or_insert_with(|| pricing::local_minute(ts));
        let row = cfg.row_cost_at_minute(&model, minute, i, o, cr, cw);
        if !row.priced {
            unpriced.insert(model);
        }
        savings += row.saving;
        if row.priced {
            if row.is_cny {
                *cost_cny_usd.entry(k.clone()).or_insert(0.0) += row.cost;
                savings_cny_priced_usd += row.saving;
            } else {
                savings_usd_priced += row.saving;
            }
        }
        *cost.entry(k).or_insert(0.0) += row.cost;
    }
    Ok(CostAgg {
        cost,
        cost_cny_usd,
        unpriced,
        savings,
        savings_usd_priced,
        savings_cny_priced_usd,
    })
}

impl CostAgg {
    /// 某个分组 key 的分币种金额:(美元定价模型的费用, 人民币定价模型的费用)。
    /// 返回值各是真实金额——分组行可能同时含两种币种的模型,不能只看总额贴一个符号。
    /// 分组键不存在时返回 (0, 0)
    fn split(&self, key: &str, rate: f64) -> (f64, f64) {
        let total = *self.cost.get(key).unwrap_or(&0.0);
        let cny_usd = *self.cost_cny_usd.get(key).unwrap_or(&0.0);
        (total - cny_usd, cny_usd * rate)
    }

    /// 全部 key 的三元合计:(总额, 美元定价部分, 人民币定价部分)。
    /// 总额直接取按 key 求和,不由两侧相加还原,避免浮点误差累积
    fn split_total(&self, rate: f64) -> (f64, f64, f64) {
        let total: f64 = self.cost.values().sum();
        let cny_usd: f64 = self.cost_cny_usd.values().sum();
        (total, total - cny_usd, cny_usd * rate)
    }
}

pub fn get_summary(conn: &Connection, range: &Range, pricing_path: &std::path::Path) -> rusqlite::Result<Summary> {
    let (where_sql, params) = build_where(range);

    let mut row = query_rows(
        conn,
        &format!(
            "SELECT COUNT(*) AS requests,
                    COUNT(DISTINCT {SESSION_KEY}) AS sessions,
                    SUM(mu.input_tokens) AS inputTokens,
                    SUM(mu.output_tokens) AS outputTokens,
                    SUM(mu.reasoning_tokens) AS reasoningTokens,
                    SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
                    SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens,
                    SUM(mu.duration_ms) AS llmDurationMs,
                    SUM(CASE WHEN mu.time_to_first_token_ms IS NOT NULL AND mu.duration_ms IS NOT NULL
                             AND mu.duration_ms > mu.time_to_first_token_ms
                             AND mu.duration_ms - mu.time_to_first_token_ms >= mu.output_tokens
                        THEN mu.duration_ms - mu.time_to_first_token_ms ELSE 0 END) AS decodeDurationMs,
                    SUM(CASE WHEN mu.time_to_first_token_ms IS NOT NULL AND mu.duration_ms IS NOT NULL
                             AND mu.duration_ms > mu.time_to_first_token_ms
                             AND mu.duration_ms - mu.time_to_first_token_ms >= mu.output_tokens
                        THEN mu.output_tokens ELSE 0 END) AS decodeOutputTokens
             {FROM_CLAUSE} {where_sql}"
        ),
        &params,
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                r.get::<_, Option<i64>>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, i64>(9)?,
            ))
        },
    )?;
    let (requests, sessions, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_create_tokens, llm_duration_ms, decode_duration_ms, decode_output_tokens) =
        row.pop().expect("COUNT 聚合必有且仅有一行");

    // 逐请求计价(含峰谷/长上下文),再按模型聚合
    let cfg = pricing::load(pricing_path);
    let agg = cost_rows(conn, range, &cfg, "mu.model_id", false)?;
    // 按币种分账:两个数字各自是真实支出,不是同一个总额的两种换算
    let (cost, cost_usd, cost_cny) = agg.split_total(cfg.usd_cny_rate);
    let unpriced_models: Vec<String> = agg.unpriced.iter().cloned().collect();
    let cache_savings_usd = agg.savings_usd_priced;
    let cache_savings_cny = agg.savings_cny_priced_usd * cfg.usd_cny_rate;


    Ok(Summary {
        requests,
        sessions,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_read_tokens,
        cache_create_tokens,
        tokens_per_sec: weighted_tokens_per_sec(output_tokens, llm_duration_ms),
        decode_tokens_per_sec: weighted_tokens_per_sec(decode_output_tokens, Some(decode_duration_ms)),
        cost,
        cost_usd,
        cost_cny,
        cache_savings: agg.savings,
        cache_savings_usd,
        cache_savings_cny,
        unpriced_models,
    })
}

/// 解析时间范围并决定分桶粒度(跨度 ≤24h 按小时,否则按天)
struct Buckets {
    from: i64,
    to: i64,
    hourly: bool,
    bucket_expr: &'static str,
}

fn resolve_buckets(range: &Range, earliest: Option<i64>) -> Buckets {
    let to = range.to.unwrap_or_else(now_ms);
    let from = range.from.or(earliest).unwrap_or(to - 7 * 86400_000);
    let hourly = to - from <= 24 * 3600_000;
    let bucket_expr = if hourly {
        "strftime('%Y-%m-%dT%H:00:00', mu.started_at/1000, 'unixepoch', 'localtime')"
    } else {
        "date(mu.started_at/1000, 'unixepoch', 'localtime')"
    };
    Buckets { from, to, hourly, bucket_expr }
}

/// 从 from 到 to 补齐空桶让曲线连续(最多 500 个),make 负责生成每个桶的初始值。
/// 桶键按本地时间生成,与 SQL 里的 'localtime' 修饰符一致
fn fill_buckets<T>(from: i64, to: i64, hourly: bool, mut make: impl FnMut(&str) -> T) -> Vec<T> {
    use chrono::{Duration, Local, TimeZone, Timelike};
    let mut dt = Local.timestamp_millis_opt(from).single().unwrap_or_else(Local::now);
    dt = dt.with_minute(0).and_then(|d| d.with_second(0)).and_then(|d| d.with_nanosecond(0)).unwrap();
    if !hourly {
        dt = dt.with_hour(0).and_then(|d| d.with_minute(0)).and_then(|d| d.with_second(0)).and_then(|d| d.with_nanosecond(0)).unwrap();
    }
    let step_ms = if hourly { 3_600_000 } else { 86_400_000 };
    let mut points = Vec::new();
    while dt.timestamp_millis() <= to && points.len() < 500 {
        let key = if hourly {
            dt.format("%Y-%m-%dT%H:00:00").to_string()
        } else {
            dt.format("%Y-%m-%d").to_string()
        };
        points.push(make(&key));
        dt += Duration::milliseconds(step_ms);
    }
    points
}

struct BucketModelRow {
    bucket: String,
    model_id: String,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_create_tokens: i64,
    duration_ms: i64,
    /// 配对剔除后的 Σ(总耗时−TTFT) 与 Σ输出;TTFT 缺失或差值 ≤0 的行不参与
    decode_duration_ms: i64,
    decode_output_tokens: i64,
}

/// SQL 片段:配对剔除后累计解码时长与解码输出(deepseek harness 口径)。
/// 门禁:decode = duration − TTFT 必须 > 0,且 ≥ 输出tokens(隐含速度 ≤ 1000 tok/s),
/// 排除整包缓冲的非流式响应(整段输出随首 chunk 一次到达,decode 段只剩网络传输)
const DECODE_SUMS: &str = "
                    SUM(CASE WHEN mu.time_to_first_token_ms IS NOT NULL AND mu.duration_ms IS NOT NULL
                             AND mu.duration_ms > mu.time_to_first_token_ms
                             AND mu.duration_ms - mu.time_to_first_token_ms >= mu.output_tokens
                        THEN mu.duration_ms - mu.time_to_first_token_ms ELSE 0 END) AS decodeDurationMs,
                    SUM(CASE WHEN mu.time_to_first_token_ms IS NOT NULL AND mu.duration_ms IS NOT NULL
                             AND mu.duration_ms > mu.time_to_first_token_ms
                             AND mu.duration_ms - mu.time_to_first_token_ms >= mu.output_tokens
                        THEN mu.output_tokens ELSE 0 END) AS decodeOutputTokens";

fn bucket_model_rows(
    conn: &Connection,
    range: &Range,
    extra_select: &str,
    extra_group: &str,
    bucket_expr: &str,
) -> rusqlite::Result<(Vec<BucketModelRow>, Vec<i64>)> {
    let (where_sql, params) = build_where(range);
    let rows = query_rows(
        conn,
        &format!(
            "SELECT {bucket_expr} AS bucket,
                    {extra_select}
                    mu.model_id AS modelId,
                    SUM(mu.input_tokens) AS inputTokens,
                    SUM(mu.output_tokens) AS outputTokens,
                    SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
                    SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens,
                    SUM(mu.duration_ms) AS durationMs,
                    {DECODE_SUMS}
             {FROM_CLAUSE} {where_sql}
             GROUP BY bucket, {extra_group}mu.model_id"
        ),
        &params,
        |r| {
            Ok(BucketModelRow {
                bucket: r.get(0)?,
                model_id: r.get(1)?,
                input_tokens: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                output_tokens: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                cache_read_tokens: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                cache_create_tokens: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                duration_ms: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                decode_duration_ms: r.get::<_, i64>(7)?,
                decode_output_tokens: r.get::<_, i64>(8)?,
            })
        },
    )?;
    Ok((rows, params))
}

pub fn get_trend(conn: &Connection, range: &Range, pricing_path: &std::path::Path) -> rusqlite::Result<Vec<TrendPoint>> {
    let buckets = resolve_buckets(range, earliest_timestamp(conn)?);
    let (rows, _params) = bucket_model_rows(conn, range, "", "", buckets.bucket_expr)?;

    // 逐请求计价(含峰谷/长上下文),再按时间桶聚合
    let cfg = pricing::load(pricing_path);
    let cost_by_bucket = cost_rows(conn, range, &cfg, buckets.bucket_expr, false)?.cost;
    let mut by_bucket: BTreeMap<String, TrendPoint> = BTreeMap::new();
    // 桶内累计 Σoutput/Σduration 与解码配对的 Σoutput/Σdecode,用于算两种加权速度
    let mut speed: BTreeMap<String, (i64, i64, i64, i64)> = BTreeMap::new();
    for r in &rows {
        let point = by_bucket.entry(r.bucket.clone()).or_insert_with(|| TrendPoint {
            bucket: r.bucket.clone(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_create_tokens: 0,
            tokens_per_sec: None,
            decode_tokens_per_sec: None,
            cost: 0.0,
        });
        point.input_tokens += r.input_tokens;
        point.output_tokens += r.output_tokens;
        point.cache_read_tokens += r.cache_read_tokens;
        point.cache_create_tokens += r.cache_create_tokens;
        point.cost = *cost_by_bucket.get(&r.bucket).unwrap_or(&0.0);
        let s = speed.entry(r.bucket.clone()).or_insert((0, 0, 0, 0));
        s.0 += r.output_tokens;
        s.1 += r.duration_ms;
        s.2 += r.decode_output_tokens;
        s.3 += r.decode_duration_ms;
    }

    let points = fill_buckets(buckets.from, buckets.to, buckets.hourly, |bucket| {
        let mut point = by_bucket.get(bucket).cloned().unwrap_or_else(|| TrendPoint {
            bucket: bucket.to_string(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_create_tokens: 0,
            tokens_per_sec: None,
            decode_tokens_per_sec: None,
            cost: 0.0,
        });
        if let Some(&(o, d, do_, dd)) = speed.get(bucket) {
            point.tokens_per_sec = weighted_tokens_per_sec(o, Some(d));
            point.decode_tokens_per_sec = weighted_tokens_per_sec(do_, Some(dd));
        }
        point
    });
    if points.is_empty() {
        Ok(by_bucket
            .into_iter()
            .map(|(bucket, mut point)| {
                if let Some(&(o, d, do_, dd)) = speed.get(&bucket) {
                    point.tokens_per_sec = weighted_tokens_per_sec(o, Some(d));
                    point.decode_tokens_per_sec = weighted_tokens_per_sec(do_, Some(dd));
                }
                point
            })
            .collect())
    } else {
        Ok(points)
    }
}

pub fn get_trend_by_model(
    conn: &Connection,
    range: &Range,
    pricing_path: &std::path::Path,
) -> rusqlite::Result<Vec<ModelTrendPoint>> {
    let buckets = resolve_buckets(range, earliest_timestamp(conn)?);
    let (rows, _params) = bucket_model_rows(conn, range, "", "", buckets.bucket_expr)?;

    let cfg = pricing::load(pricing_path);
    // 逐请求计价后按「桶 × 模型」聚合(组合键用 \x1f 拼接)
    let cost_by_bm = cost_rows(
        conn,
        range,
        &cfg,
        &format!("({}) || char(31) || mu.model_id", buckets.bucket_expr),
        false,
    )?;
    let mut by_bucket: BTreeMap<String, BTreeMap<String, TokenCost>> = BTreeMap::new();
    for r in &rows {
        let models = by_bucket.entry(r.bucket.clone()).or_default();
        // 总 token = 输入 + 输出(zcode provider_total_tokens 口径;缓存读/写是输入子集,不叠加)
        let tokens = r.input_tokens + r.output_tokens;
        let cost = *cost_by_bm
            .cost
            .get(&format!("{}{}{}", r.bucket, KEY_SEP, r.model_id))
            .unwrap_or(&0.0);
        models.insert(
            r.model_id.clone(),
            TokenCost {
                tokens,
                cost,
                tokens_per_sec: weighted_tokens_per_sec(r.output_tokens, Some(r.duration_ms)),
                decode_tokens_per_sec: weighted_tokens_per_sec(
                    r.decode_output_tokens,
                    Some(r.decode_duration_ms),
                ),
            },
        );
    }

    let points = fill_buckets(buckets.from, buckets.to, buckets.hourly, |bucket| ModelTrendPoint {
        bucket: bucket.to_string(),
        models: by_bucket.get(bucket).cloned().unwrap_or_default(),
    });
    if points.is_empty() {
        Ok(by_bucket
            .into_iter()
            .map(|(bucket, models)| ModelTrendPoint { bucket, models })
            .collect())
    } else {
        Ok(points)
    }
}

/// 按供应商拆分的趋势:费用要按模型折算,所以分桶先到模型粒度再归并进供应商
pub fn get_trend_by_provider(
    conn: &Connection,
    range: &Range,
    pricing_path: &std::path::Path,
) -> rusqlite::Result<Vec<ProviderTrendPoint>> {
    let buckets = resolve_buckets(range, earliest_timestamp(conn)?);

    // provider 粒度的分桶查询(到模型一级,便于折算费用)
    let (where_sql, params) = build_where(range);
    // 逐请求计价改造后 model_id 等列不再参与本查询计算,保留以维持 SQL 列序
    #[allow(dead_code)]
    struct Row {
        bucket: String,
        provider_id: String,
        model_id: String,
        input_tokens: i64,
        output_tokens: i64,
        cache_read_tokens: i64,
        cache_create_tokens: i64,
        duration_ms: i64,
        decode_duration_ms: i64,
        decode_output_tokens: i64,
    }
    let rows = query_rows(
        conn,
        &format!(
            "SELECT {} AS bucket,
                    mu.provider_id AS providerId,
                    mu.model_id AS modelId,
                    SUM(mu.input_tokens) AS inputTokens,
                    SUM(mu.output_tokens) AS outputTokens,
                    SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
                    SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens,
                    SUM(mu.duration_ms) AS durationMs,
                    {}
             {} {}
             GROUP BY bucket, mu.provider_id, mu.model_id",
            buckets.bucket_expr, DECODE_SUMS, FROM_CLAUSE, where_sql
        ),
        &params,
        |r| {
            Ok(Row {
                bucket: r.get(0)?,
                provider_id: r.get(1)?,
                model_id: r.get(2)?,
                input_tokens: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                output_tokens: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                cache_read_tokens: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                cache_create_tokens: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                duration_ms: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
                decode_duration_ms: r.get::<_, i64>(8)?,
                decode_output_tokens: r.get::<_, i64>(9)?,
            })
        },
    )?;

    let cfg = pricing::load(pricing_path);
    // 逐请求计价后按「桶 × 供应商」聚合
    let cost_by_bp = cost_rows(
        conn,
        range,
        &cfg,
        &format!("({}) || char(31) || mu.provider_id", buckets.bucket_expr),
        false,
    )?;
    let mut by_bucket: BTreeMap<String, BTreeMap<String, TokenCost>> = BTreeMap::new();
    // 桶 × 供应商 累计 Σoutput/Σduration 与解码配对 Σ,用于算两种加权速度
    let mut speed: BTreeMap<String, BTreeMap<String, (i64, i64, i64, i64)>> = BTreeMap::new();
    for r in &rows {
        let providers = by_bucket.entry(r.bucket.clone()).or_default();
        // 总 token = 输入 + 输出(zcode provider_total_tokens 口径;缓存读/写是输入子集,不叠加)
        let tokens = r.input_tokens + r.output_tokens;
        let cost = *cost_by_bp
            .cost
            .get(&format!("{}{}{}", r.bucket, KEY_SEP, r.provider_id))
            .unwrap_or(&0.0);
        let acc = providers.entry(r.provider_id.clone()).or_default();
        acc.tokens += tokens;
        acc.cost += cost;
        let s = speed
            .entry(r.bucket.clone())
            .or_default()
            .entry(r.provider_id.clone())
            .or_insert((0, 0, 0, 0));
        s.0 += r.output_tokens;
        s.1 += r.duration_ms;
        s.2 += r.decode_output_tokens;
        s.3 += r.decode_duration_ms;
    }

    let points = fill_buckets(buckets.from, buckets.to, buckets.hourly, |bucket| {
        let mut providers = by_bucket.get(bucket).cloned().unwrap_or_default();
        if let Some(sp) = speed.get(bucket) {
            for (pid, tc) in providers.iter_mut() {
                if let Some(&(o, d, do_, dd)) = sp.get(pid) {
                    tc.tokens_per_sec = weighted_tokens_per_sec(o, Some(d));
                    tc.decode_tokens_per_sec = weighted_tokens_per_sec(do_, Some(dd));
                }
            }
        }
        ProviderTrendPoint { bucket: bucket.to_string(), providers }
    });
    if points.is_empty() {
        Ok(by_bucket
            .into_iter()
            .map(|(bucket, mut providers)| {
                if let Some(sp) = speed.get(&bucket) {
                    for (pid, tc) in providers.iter_mut() {
                        if let Some(&(o, d, do_, dd)) = sp.get(pid) {
                            tc.tokens_per_sec = weighted_tokens_per_sec(o, Some(d));
                            tc.decode_tokens_per_sec = weighted_tokens_per_sec(do_, Some(dd));
                        }
                    }
                }
                ProviderTrendPoint { bucket, providers }
            })
            .collect())
    } else {
        Ok(points)
    }
}

pub fn get_model_stats(conn: &Connection, range: &Range, pricing_path: &std::path::Path) -> rusqlite::Result<Vec<ModelStat>> {
    let (where_sql, params) = build_where(range);
    let rows = query_rows(
        conn,
        &format!(
            "SELECT mu.model_id AS modelId,
                    COUNT(*) AS requests,
                    COUNT(DISTINCT {SESSION_KEY}) AS sessions,
                    SUM(mu.input_tokens) AS inputTokens,
                    SUM(mu.output_tokens) AS outputTokens,
                    SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
                    SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens,
                    SUM(mu.duration_ms) AS durationMs,
                    {DECODE_SUMS},
                    AVG(mu.time_to_first_token_ms) AS avgTtftMs
             {FROM_CLAUSE} {where_sql}
             GROUP BY mu.model_id
             ORDER BY requests DESC"
        ),
        &params,
        |r| {
            let output_tokens = r.get::<_, Option<i64>>(4)?.unwrap_or(0);
            let duration_ms = r.get::<_, Option<i64>>(7)?.unwrap_or(0);
            Ok(ModelStat {
                model_id: r.get(0)?,
                requests: r.get(1)?,
                sessions: r.get(2)?,
                input_tokens: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                output_tokens,
                cache_read_tokens: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                cache_create_tokens: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                tokens_per_sec: weighted_tokens_per_sec(output_tokens, Some(duration_ms)),
                decode_tokens_per_sec: weighted_tokens_per_sec(
                    r.get::<_, i64>(9)?,
                    Some(r.get::<_, i64>(8)?),
                ),
                avg_ttft_ms: r.get::<_, Option<f64>>(10)?.map(|v| v.round() as i64),
                cost: 0.0,
                currency: None,
                priced: false,
                errors: 0,
            })
        },
    )?;

    // 逐请求计价(含峰谷/长上下文),再按模型聚合
    let cfg = pricing::load(pricing_path);
    let agg = cost_rows(conn, range, &cfg, "mu.model_id", false)?;
    let cost_by_model = agg.cost;
    let unpriced_set = agg.unpriced;

    // 错误数不过滤状态单独统计(与错误分析面板口径一致)
    let (conds, err_params) = range_conds("mu.started_at", range);
    let err_where = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    let err_rows = query_rows(
        conn,
        &format!(
            "SELECT mu.model_id AS modelId,
                    SUM(mu.status = 'error') AS errors
             FROM model_usage mu {err_where}
             GROUP BY mu.model_id"
        ),
        &err_params,
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
    )?;
    let errors_by_model: HashMap<String, i64> = err_rows.into_iter().collect();

    Ok(rows
        .into_iter()
        .map(|mut s| {
            s.cost = cost_by_model.get(&s.model_id).copied().unwrap_or(0.0);
            // 费用符号跟随该模型价格表条目的币种(与「模型单价」逐行显示一致)
            s.currency = cfg.models.get(&s.model_id).and_then(|e| e.currency.clone());
            s.priced = !unpriced_set.contains(&s.model_id);
            s.errors = errors_by_model.get(&s.model_id).copied().unwrap_or(0);
            s
        })
        .collect())
}

/// 按代理(agent 列)汇总;模式同 get_model_stats,但无费用(费用按模型定价,代理维度不折算)
pub fn get_agent_stats(conn: &Connection, range: &Range) -> rusqlite::Result<Vec<AgentStat>> {
    let (where_sql, params) = build_where(range);
    let rows = query_rows(
        conn,
        &format!(
            "SELECT mu.agent AS agent,
                    COUNT(*) AS requests,
                    COUNT(DISTINCT {SESSION_KEY}) AS sessions,
                    SUM(mu.input_tokens) AS inputTokens,
                    SUM(mu.output_tokens) AS outputTokens,
                    SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
                    SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens,
                    SUM(mu.duration_ms) AS durationMs,
                    {DECODE_SUMS},
                    AVG(mu.time_to_first_token_ms) AS avgTtftMs
             {FROM_CLAUSE} {where_sql}
             GROUP BY mu.agent
             ORDER BY requests DESC"
        ),
        &params,
        |r| {
            let output_tokens = r.get::<_, Option<i64>>(4)?.unwrap_or(0);
            let duration_ms = r.get::<_, Option<i64>>(7)?.unwrap_or(0);
            Ok(AgentStat {
                agent: r.get(0)?,
                requests: r.get(1)?,
                sessions: r.get(2)?,
                input_tokens: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                output_tokens,
                cache_read_tokens: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                cache_create_tokens: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                tokens_per_sec: weighted_tokens_per_sec(output_tokens, Some(duration_ms)),
                decode_tokens_per_sec: weighted_tokens_per_sec(
                    r.get::<_, i64>(9)?,
                    Some(r.get::<_, i64>(8)?),
                ),
                avg_ttft_ms: r.get::<_, Option<f64>>(10)?.map(|v| v.round() as i64),
                errors: 0,
            })
        },
    )?;

    // 错误数不过滤状态单独统计(与模型/错误面板口径一致)
    let (conds, err_params) = range_conds("mu.started_at", range);
    let err_where = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    let err_rows = query_rows(
        conn,
        &format!(
            "SELECT mu.agent AS agent,
                    SUM(mu.status = 'error') AS errors
             FROM model_usage mu {err_where}
             GROUP BY mu.agent"
        ),
        &err_params,
        |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
    )?;
    let errors_by_agent: HashMap<Option<String>, i64> = err_rows.into_iter().collect();

    Ok(rows
        .into_iter()
        .map(|mut s| {
            s.errors = errors_by_agent.get(&s.agent).copied().unwrap_or(0);
            s
        })
        .collect())
}

/// 目录路径取最后一段作为项目名,兼容 `/` 与 Windows `\` 分隔
fn base_name(dir: &str) -> String {
    let trimmed = dir.trim_end_matches(['/', '\\']);
    match trimmed.rsplit(['/', '\\']).next() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => dir.to_string(),
    }
}

pub fn get_project_stats(conn: &Connection, range: &Range, pricing_path: &std::path::Path) -> rusqlite::Result<Vec<ProjectStat>> {
    let (where_sql, params) = build_where(range);
    let rows = query_rows(
        conn,
        &format!(
            "SELECT {PROJECT_DIR} AS directory,
                    COUNT(*) AS requests,
                    COUNT(DISTINCT {SESSION_KEY}) AS sessions,
                    SUM(mu.input_tokens) AS inputTokens,
                    SUM(mu.output_tokens) AS outputTokens,
                    SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
                    SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens,
                    SUM(mu.input_tokens + mu.output_tokens) AS totalTokens,
                    SUM(mu.duration_ms) AS durationMs,
                    {DECODE_SUMS},
                    AVG(mu.time_to_first_token_ms) AS avgTtftMs
             {FROM_CLAUSE} {where_sql}
             GROUP BY {PROJECT_DIR}
             ORDER BY totalTokens DESC"
        ),
        &params,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                r.get::<_, Option<i64>>(7)?.unwrap_or(0),
                r.get::<_, Option<i64>>(8)?.unwrap_or(0),
                r.get::<_, i64>(9)?,
                r.get::<_, i64>(10)?,
                r.get::<_, Option<f64>>(11)?.map(|v| v.round() as i64),
            ))
        },
    )?;

    // 逐请求计价后按项目目录聚合(键与 PROJECT_DIR 一致,子代理行归到父会话目录);
    // 分币种各自留存,目录下混用两种定价时费用列要并排展示
    let cfg = pricing::load(pricing_path);
    let agg = cost_rows(conn, range, &cfg, PROJECT_DIR, true)?;
    let rate = cfg.usd_cny_rate;

    // 错误数不过滤状态单独统计(与错误分析面板口径一致)
    let (conds, err_params) = range_conds("mu.started_at", range);
    let err_where = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    let err_rows = query_rows(
        conn,
        &format!(
            "SELECT {PROJECT_DIR} AS directory,
                    SUM(mu.status = 'error') AS errors
             {FROM_CLAUSE} {err_where}
             GROUP BY {PROJECT_DIR}"
        ),
        &err_params,
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
    )?;
    let errors_by_dir: HashMap<String, i64> = err_rows.into_iter().collect();

    Ok(rows
        .into_iter()
        .map(|(directory, requests, sessions, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, total_tokens, duration_ms, decode_duration_ms, decode_output_tokens, avg_ttft_ms)| {
            let (cost_usd, cost_cny) = agg.split(&directory, rate);
            let mut s = ProjectStat {
                name: base_name(&directory),
                cost: cost_usd + cost_cny / rate,
                cost_usd,
                cost_cny,
                directory,
                requests,
                sessions,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_create_tokens,
                total_tokens,
                tokens_per_sec: None,
                decode_tokens_per_sec: None,
                avg_ttft_ms,
                errors: 0,
            };
            s.tokens_per_sec = weighted_tokens_per_sec(s.output_tokens, Some(duration_ms));
            s.decode_tokens_per_sec = weighted_tokens_per_sec(decode_output_tokens, Some(decode_duration_ms));
            s.errors = errors_by_dir.get(&s.directory).copied().unwrap_or(0);
            s
        })
        .collect())
}

/// 按供应商统计:provider_id 到名称的映射读自 zcode 配置文件
pub fn get_provider_stats(
    conn: &Connection,
    range: &Range,
    pricing_path: &std::path::Path,
    names: &HashMap<String, String>,
) -> rusqlite::Result<Vec<ProviderStat>> {
    let (where_sql, params) = build_where(range);
    struct Agg {
        requests: i64,
        sessions: i64,
        input_tokens: i64,
        output_tokens: i64,
        cache_read_tokens: i64,
        cache_create_tokens: i64,
        duration_ms: i64,
        avg_ttft_ms: Option<i64>,
    }
    let rows = query_rows(
        conn,
        &format!(
            "SELECT mu.provider_id AS providerId,
                    COUNT(*) AS requests,
                    COUNT(DISTINCT {SESSION_KEY}) AS sessions,
                    SUM(mu.input_tokens) AS inputTokens,
                    SUM(mu.output_tokens) AS outputTokens,
                    SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
                    SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens,
                    SUM(mu.duration_ms) AS durationMs,
                    {DECODE_SUMS},
                    AVG(mu.time_to_first_token_ms) AS avgTtftMs
             {FROM_CLAUSE} {where_sql}
             GROUP BY mu.provider_id"
        ),
        &params,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                Agg {
                    requests: r.get(1)?,
                    sessions: r.get(2)?,
                    input_tokens: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    output_tokens: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                    cache_read_tokens: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                    cache_create_tokens: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                    duration_ms: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
                    avg_ttft_ms: r.get::<_, Option<f64>>(10)?.map(|v| v.round() as i64),
                },
                (r.get::<_, i64>(8)?, r.get::<_, i64>(9)?),
            ))
        },
    )?;

    // 供应商 × 模型分组:费用折算和展开行的模型明细都用它
    struct PerModel {
        provider_id: String,
        model_id: String,
        requests: i64,
        sessions: i64,
        input_tokens: i64,
        output_tokens: i64,
        cache_read_tokens: i64,
        cache_create_tokens: i64,
        duration_ms: i64,
        decode_duration_ms: i64,
        decode_output_tokens: i64,
        avg_ttft_ms: Option<i64>,
    }
    let per_model = query_rows(
        conn,
        &format!(
            "SELECT mu.provider_id AS providerId,
                    mu.model_id AS modelId,
                    COUNT(*) AS requests,
                    COUNT(DISTINCT {SESSION_KEY}) AS sessions,
                    SUM(mu.input_tokens) AS inputTokens,
                    SUM(mu.output_tokens) AS outputTokens,
                    SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
                    SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens,
                    SUM(mu.duration_ms) AS durationMs,
                    {DECODE_SUMS},
                    AVG(mu.time_to_first_token_ms) AS avgTtftMs
             {FROM_CLAUSE} {where_sql}
             GROUP BY mu.provider_id, mu.model_id"
        ),
        &params,
        |r| {
            Ok(PerModel {
                provider_id: r.get(0)?,
                model_id: r.get(1)?,
                requests: r.get(2)?,
                sessions: r.get(3)?,
                input_tokens: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                output_tokens: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                cache_read_tokens: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                cache_create_tokens: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
                duration_ms: r.get::<_, Option<i64>>(8)?.unwrap_or(0),
                decode_duration_ms: r.get::<_, i64>(9)?,
                decode_output_tokens: r.get::<_, i64>(10)?,
                avg_ttft_ms: r.get::<_, Option<f64>>(11)?.map(|v| v.round() as i64),
            })
        },
    )?;

    // 逐请求计价后按「供应商 × 模型」聚合(供应商总额 = 其下模型之和);
    // 同时留一份按供应商的人民币金额,供应商可能同时挂两种币种定价的模型
    let cfg = pricing::load(pricing_path);
    let agg = cost_rows(conn, range, &cfg, "mu.provider_id || char(31) || mu.model_id", false)?;
    let cost_by_pm = &agg.cost;
    let rate = cfg.usd_cny_rate;
    let mut cost_by_provider: HashMap<String, f64> = HashMap::new();
    // 供应商侧的人民币金额(美元口径):一个供应商可能同时挂两种币种定价的模型
    let mut cost_cny_by_provider: HashMap<String, f64> = HashMap::new();
    let mut models_by_provider: HashMap<String, Vec<ProviderModelStat>> = HashMap::new();
    for r in &per_model {
        let pm_key = format!("{}{}{}", r.provider_id, KEY_SEP, r.model_id);
        let cost = *cost_by_pm.get(&pm_key).unwrap_or(&0.0);
        // 币种由模型的价格条目决定:供应商 × 模型 这一格必然单币种,供应商整体可能混用
        let currency = cfg.models.get(&r.model_id).and_then(|e| e.currency.clone());
        *cost_by_provider.entry(r.provider_id.clone()).or_insert(0.0) += cost;
        if pricing::is_cny_currency(currency.as_deref()) {
            *cost_cny_by_provider.entry(r.provider_id.clone()).or_insert(0.0) += cost;
        }
        models_by_provider.entry(r.provider_id.clone()).or_default().push(ProviderModelStat {
            model_id: r.model_id.clone(),
            requests: r.requests,
            sessions: r.sessions,
            input_tokens: r.input_tokens,
            output_tokens: r.output_tokens,
            cache_read_tokens: r.cache_read_tokens,
            cache_create_tokens: r.cache_create_tokens,
            total_tokens: r.input_tokens + r.output_tokens,
            tokens_per_sec: weighted_tokens_per_sec(r.output_tokens, Some(r.duration_ms)),
            decode_tokens_per_sec: weighted_tokens_per_sec(
                r.decode_output_tokens,
                Some(r.decode_duration_ms),
            ),
            avg_ttft_ms: r.avg_ttft_ms,
            cost,
            currency,
        });
    }
    for models in models_by_provider.values_mut() {
        models.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));
    }

    // 错误数不过滤状态单独统计(与错误分析面板口径一致)
    let (conds, err_params) = range_conds("mu.started_at", range);
    let err_where = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    let err_rows = query_rows(
        conn,
        &format!(
            "SELECT mu.provider_id AS providerId,
                    SUM(mu.status = 'error') AS errors
             FROM model_usage mu {err_where}
             GROUP BY mu.provider_id"
        ),
        &err_params,
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
    )?;
    let errors_by_provider: HashMap<String, i64> = err_rows.into_iter().collect();

    let mut result: Vec<ProviderStat> = rows
        .into_iter()
        .map(|(provider_id, a, (decode_duration_ms, decode_output_tokens))| {
            let total_tokens = a.input_tokens + a.output_tokens;
            let cost_cny_usd = cost_cny_by_provider.get(&provider_id).copied().unwrap_or(0.0);
            let cost = cost_by_provider.get(&provider_id).copied().unwrap_or(0.0);
            ProviderStat {
                name: names.get(&provider_id).cloned().unwrap_or_else(|| provider_id.clone()),
                total_tokens,
                tokens_per_sec: weighted_tokens_per_sec(a.output_tokens, Some(a.duration_ms)),
                decode_tokens_per_sec: weighted_tokens_per_sec(decode_output_tokens, Some(decode_duration_ms)),
                avg_ttft_ms: a.avg_ttft_ms,
                cost,
                cost_usd: cost - cost_cny_usd,
                cost_cny: cost_cny_usd * rate,
                errors: errors_by_provider.get(&provider_id).copied().unwrap_or(0),
                models: models_by_provider.get(&provider_id).cloned().unwrap_or_default(),
                provider_id,
                requests: a.requests,
                sessions: a.sessions,
                input_tokens: a.input_tokens,
                output_tokens: a.output_tokens,
                cache_read_tokens: a.cache_read_tokens,
                cache_create_tokens: a.cache_create_tokens,
            }
        })
        .collect();
    result.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));
    Ok(result)
}

/// 请求日志:按根会话分组返回。子代理会话(session.parent_id 指向父会话)的请求
/// 归入父会话组,分页单位是根会话,total 为范围内根会话总数。
pub fn get_request_log(
    conn: &Connection,
    range: &Range,
    page: i64,
    page_size: i64,
    pricing_path: &std::path::Path,
) -> rusqlite::Result<RequestLogResponse> {
    let (where_sql, params) = build_where(range);

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(DISTINCT {SESSION_KEY}) {FROM_CLAUSE} {where_sql}"),
        params_from_iter(params.iter().copied()),
        |r| r.get(0),
    )?;

    // 本页的根会话,按最近活动倒序
    let mut page_params = params.clone();
    page_params.push(page_size);
    page_params.push((page - 1) * page_size);
    let root_ids: Vec<String> = query_rows(
        conn,
        &format!(
            "SELECT {SESSION_KEY} AS rootId, MAX(mu.started_at) AS lastActive
             {FROM_CLAUSE} {where_sql}
             GROUP BY {SESSION_KEY}
             ORDER BY lastActive DESC
             LIMIT ? OFFSET ?"
        ),
        &page_params,
        |r| r.get::<_, String>(0),
    )?;

    if root_ids.is_empty() {
        return Ok(RequestLogResponse { groups: vec![], total, page, page_size });
    }

    // 根会话自身的标题与项目目录(组头展示用)
    let root_ph = vec!["?"; root_ids.len()].join(",");
    let meta_bind: Vec<rusqlite::types::Value> = root_ids
        .iter()
        .map(|id| rusqlite::types::Value::from(id.clone()))
        .collect();
    let mut meta_stmt = conn.prepare(&format!(
        "SELECT id, title, directory FROM session WHERE id IN ({root_ph})"
    ))?;
    let mut metas: HashMap<String, (Option<String>, String)> = HashMap::new();
    let mut meta_rows = meta_stmt.query_map(params_from_iter(meta_bind.iter()), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    while let Some(row) = meta_rows.next() {
        let (id, title, dir) = row?;
        metas.insert(id, (title, dir));
    }

    // 组内请求按时间升序;WHERE 占位符顺序:先 IN(root_ids) 后范围条件
    let scoped_where = format!(
        "WHERE {SESSION_KEY} IN ({root_ph}) AND {}",
        where_sql.strip_prefix("WHERE ").unwrap_or(&where_sql)
    );
    let mut bind: Vec<rusqlite::types::Value> = root_ids
        .iter()
        .map(|id| rusqlite::types::Value::from(id.clone()))
        .collect();
    bind.extend(params.iter().map(|&v| rusqlite::types::Value::from(v)));

    let mut stmt = conn.prepare(&format!(
        "SELECT mu.id, mu.started_at, mu.model_id, mu.agent, mu.status,
                mu.duration_ms, mu.time_to_first_token_ms,
                mu.input_tokens, mu.output_tokens,
                mu.cache_read_input_tokens, mu.cache_creation_input_tokens,
                {PROJECT_DIR}, s.title, s.task_type, {SESSION_KEY}
         {FROM_CLAUSE} {scoped_where}
         ORDER BY mu.started_at ASC"
    ))?;
    let rows = stmt.query_map(params_from_iter(bind.iter()), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, Option<i64>>(6)?,
            r.get::<_, Option<i64>>(7)?.unwrap_or(0),
            r.get::<_, Option<i64>>(8)?.unwrap_or(0),
            r.get::<_, Option<i64>>(9)?.unwrap_or(0),
            r.get::<_, Option<i64>>(10)?.unwrap_or(0),
            r.get::<_, String>(11)?,
            r.get::<_, Option<String>>(12)?,
            r.get::<_, Option<String>>(13)?,
            r.get::<_, String>(14)?,
        ))
    })?;

    let cfg = pricing::load(pricing_path);
    let mut groups: Vec<RequestGroup> = root_ids
        .iter()
        .map(|id| {
            let (title, dir) = metas
                .get(id)
                .cloned()
                .unwrap_or_else(|| (None, String::new()));
            RequestGroup {
                session_id: id.clone(),
                title,
                project: base_name(&dir),
                requests: vec![],
            }
        })
        .collect();
    let group_index: HashMap<String, usize> = root_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.clone(), i))
        .collect();

    for row in rows {
        let (
            id,
            started_at,
            model_id,
            agent,
            status,
            duration_ms,
            time_to_first_token_ms,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_create_tokens,
            project,
            title,
            task_type,
            root_id,
        ) = row?;
        // 单请求只可能按一个币种计价(币种由模型的价格条目决定),这里直接取该条目的币种
        let currency = cfg.models.get(&model_id).and_then(|e| e.currency.clone());
        let row_cost = cfg.row_cost(
            &model_id,
            started_at,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_create_tokens,
        );
        let request_row = RequestRow {
            id,
            started_at,
            model_id,
            agent,
            status,
            duration_ms,
            time_to_first_token_ms,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_create_tokens,
            tokens_per_sec: weighted_tokens_per_sec(output_tokens, duration_ms),
            decode_tokens_per_sec: weighted_tokens_per_sec(
                output_tokens,
                decode_ms_of(duration_ms, time_to_first_token_ms, output_tokens),
            ),
            cost: row_cost.cost,
            project: base_name(&project),
            title,
            task_type,
            currency,
        };
        if let Some(&gi) = group_index.get(&root_id) {
            groups[gi].requests.push(request_row);
        }
    }

    Ok(RequestLogResponse { groups, total, page, page_size })
}

/// 工具调用统计:tool_usage 一行 = 一次工具调用,含错误/取消与耗时
pub fn get_tool_stats(conn: &Connection, range: &Range) -> rusqlite::Result<Vec<ToolStat>> {
    let (conds, params) = range_conds("t.started_at", range);
    let where_sql = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    let rows = query_rows(
        conn,
        &format!(
            "SELECT t.tool_name AS toolName,
                    COUNT(*) AS calls,
                    SUM(t.status = 'error') AS errors,
                    SUM(t.status = 'cancelled') AS cancelled,
                    AVG(t.duration_ms) AS avgMs,
                    MAX(t.duration_ms) AS maxMs
             FROM tool_usage t {where_sql}
             GROUP BY t.tool_name
             ORDER BY calls DESC"
        ),
        &params,
        |r| {
            Ok(ToolStat {
                tool_name: r.get(0)?,
                calls: r.get(1)?,
                errors: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                cancelled: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                avg_ms: r.get::<_, Option<f64>>(4)?.map(|v| v.round() as i64),
                max_ms: r.get(5)?,
            })
        },
    )?;
    Ok(rows)
}

/// 错误/取消/重试分析:不过滤状态,按 status 汇总 + 按错误类型分组
pub fn get_error_stats(conn: &Connection, range: &Range) -> rusqlite::Result<ErrorStats> {
    let mut stat = ErrorStats {
        total: 0,
        completed: 0,
        error: 0,
        cancelled: 0,
        cancelled_by_user: 0,
        retried_requests: 0,
        context_exceeded: 0,
        groups: vec![],
    };

    let (conds, params) = range_conds("mu.started_at", range);
    let where_sql = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    let status_rows = query_rows(
        conn,
        &format!(
            "SELECT mu.status AS status,
                    COUNT(*) AS n,
                    SUM(mu.cancelled_by_user) AS byUser,
                    SUM(mu.retry_count > 0) AS retried,
                    SUM(mu.context_exceeded) AS ctxExceeded
             FROM model_usage mu {where_sql}
             GROUP BY mu.status"
        ),
        &params,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                r.get::<_, Option<i64>>(4)?.unwrap_or(0),
            ))
        },
    )?;
    for (status, n, by_user, retried, ctx_exceeded) in status_rows {
        stat.total += n;
        match status.as_str() {
            "completed" => stat.completed += n,
            "error" => stat.error += n,
            "cancelled" => stat.cancelled += n,
            _ => {}
        }
        stat.cancelled_by_user += by_user;
        stat.retried_requests += retried;
        stat.context_exceeded += ctx_exceeded;
    }

    // 错误明细只看 error/cancelled 两类,按 error_type + error_code 归组
    let mut err_conds = conds.clone();
    err_conds.push("mu.status IN ('error', 'cancelled')".into());
    stat.groups = query_rows(
        conn,
        &format!(
            "SELECT COALESCE(mu.error_type, '') AS errorType,
                    COALESCE(mu.error_code, '') AS errorCode,
                    COUNT(*) AS count,
                    MAX(mu.error_message) AS sampleMessage
             FROM model_usage mu
             WHERE {}
             GROUP BY mu.error_type, mu.error_code
             ORDER BY count DESC",
            err_conds.join(" AND ")
        ),
        &params,
        |r| {
            Ok(ErrorGroup {
                error_type: r.get(0)?,
                error_code: r.get(1)?,
                count: r.get(2)?,
                sample_message: r.get(3)?,
            })
        },
    )?;
    Ok(stat)
}

/// 最近秩(percentile rank 取整):p50 即向上取第 50% 位元素
fn percentile(sorted: &[i64], p: f64) -> Option<i64> {
    if sorted.is_empty() {
        return None;
    }
    let n = sorted.len();
    let idx = ((p / 100.0) * n as f64).ceil() as i64 - 1;
    let idx = idx.clamp(0, n as i64 - 1) as usize;
    Some(sorted[idx])
}

/// 延迟指标:取原始行在 Rust 里算百分位(SQLite 无原生 PERCENTILE),仅 completed 行
pub fn get_latency_stats(conn: &Connection, range: &Range) -> rusqlite::Result<Vec<LatencyStat>> {
    let (mut conds, params) = range_conds("mu.started_at", range);
    conds.push("mu.status = 'completed'".into());
    let rows = query_rows(
        conn,
        &format!(
            "SELECT mu.model_id AS modelId,
                    mu.duration_ms AS durationMs,
                    mu.time_to_first_token_ms AS ttftMs,
                    mu.output_tokens AS outputTokens
             FROM model_usage mu
             WHERE {}",
            conds.join(" AND ")
        ),
        &params,
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<i64>>(3)?,
            ))
        },
    )?;

    // 生成速度按 (output, duration) 配对:任一缺失或有 duration=0 的请求不参与
    // 解码速度额外要求 TTFT 存在(decode = duration − TTFT),缺 TTFT 的行不参与解码配对
    #[derive(Default)]
    struct LatAcc {
        durations: Vec<i64>,
        ttfts: Vec<i64>,
        output_sum: i64,
        duration_sum: i64,
        decode_output_sum: i64,
        decode_duration_sum: i64,
    }
    let mut by_model: HashMap<String, LatAcc> = HashMap::new();
    for (model_id, duration_ms, ttft_ms, output_tokens) in rows {
        let m = by_model.entry(model_id).or_default();
        if let Some(d) = duration_ms {
            m.durations.push(d);
        }
        if let Some(t) = ttft_ms {
            m.ttfts.push(t);
        }
        if let Some(d) = duration_ms {
            if let Some(o) = output_tokens {
                m.output_sum += o;
                m.duration_sum += d;
            }
        }
        if let Some(decode_ms) = decode_ms_of(duration_ms, ttft_ms, output_tokens.unwrap_or(0)) {
            if let Some(o) = output_tokens {
                m.decode_output_sum += o;
                m.decode_duration_sum += decode_ms;
            }
        }
    }

    let mut result: Vec<LatencyStat> = by_model
        .into_iter()
        .map(|(model_id, m)| {
            let LatAcc { durations, ttfts, output_sum, duration_sum, decode_output_sum, decode_duration_sum } = m;
            let mut sorted_d = durations.clone();
            sorted_d.sort_unstable();
            let mut sorted_t = ttfts.clone();
            sorted_t.sort_unstable();
            let avg = if durations.is_empty() {
                None
            } else {
                Some((durations.iter().sum::<i64>() as f64 / durations.len() as f64).round() as i64)
            };
            LatencyStat {
                model_id,
                requests: durations.len() as i64,
                avg_ms: avg,
                p50_ms: percentile(&sorted_d, 50.0),
                p95_ms: percentile(&sorted_d, 95.0),
                ttft_p50_ms: percentile(&sorted_t, 50.0),
                ttft_p95_ms: percentile(&sorted_t, 95.0),
                tokens_per_sec: weighted_tokens_per_sec(output_sum, Some(duration_sum)),
                decode_tokens_per_sec: weighted_tokens_per_sec(decode_output_sum, Some(decode_duration_sum)),
            }
        })
        .collect();
    result.sort_by(|a, b| b.requests.cmp(&a.requests));
    Ok(result)
}

/// 活跃热力图:星期 × 小时的调用次数(本地时间,含所有状态——反映活跃度而非成功量)
pub fn get_activity_heatmap(conn: &Connection, range: &Range) -> rusqlite::Result<Vec<HeatCell>> {
    let (conds, params) = range_conds("mu.started_at", range);
    let where_sql = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    let rows = query_rows(
        conn,
        &format!(
            "SELECT CAST(strftime('%w', mu.started_at/1000, 'unixepoch', 'localtime') AS INTEGER) AS dow,
                    CAST(strftime('%H', mu.started_at/1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                    COUNT(*) AS calls
             FROM model_usage mu {where_sql}
             GROUP BY dow, hour
             ORDER BY dow, hour"
        ),
        &params,
        |r| {
            Ok(HeatCell {
                dow: r.get(0)?,
                hour: r.get(1)?,
                calls: r.get(2)?,
            })
        },
    )?;
    Ok(rows)
}

/// 按天活跃(12 月日历用):日期 + 调用次数 + 输出 tokens,含所有状态(反映活跃度而非成功量)
pub fn get_activity_daily(conn: &Connection, range: &Range) -> rusqlite::Result<Vec<DailyActivityPoint>> {
    let (conds, params) = range_conds("mu.started_at", range);
    let where_sql = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    query_rows(
        conn,
        &format!(
            "SELECT date(mu.started_at/1000, 'unixepoch', 'localtime') AS day,
                    COUNT(*) AS calls,
                    SUM(mu.output_tokens) AS outputTokens
             FROM model_usage mu {where_sql}
             GROUP BY day
             ORDER BY day"
        ),
        &params,
        |r| {
            Ok(DailyActivityPoint {
                day: r.get(0)?,
                calls: r.get(1)?,
                output_tokens: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            })
        },
    )
}

/// 月粒度趋势:月分桶 + 按模型折算费用,模式同 get_trend(含两种加权速度)
pub fn get_monthly_trend(conn: &Connection, range: &Range, pricing_path: &std::path::Path) -> rusqlite::Result<Vec<MonthPoint>> {
    let (rows, _params) = bucket_model_rows(
        conn,
        range,
        "",
        "",
        "strftime('%Y-%m', mu.started_at/1000, 'unixepoch', 'localtime')",
    )?;

    // 逐请求计价(含峰谷/长上下文),再按月桶聚合
    let cfg = pricing::load(pricing_path);
    let cost_by_month = cost_rows(
        conn,
        range,
        &cfg,
        "strftime('%Y-%m', mu.started_at/1000, 'unixepoch', 'localtime')",
        false,
    )?;
    let mut by_month: BTreeMap<String, MonthPoint> = BTreeMap::new();
    let mut speed: BTreeMap<String, (i64, i64, i64, i64)> = BTreeMap::new();
    for r in &rows {
        let point = by_month.entry(r.bucket.clone()).or_insert_with(|| MonthPoint {
            bucket: r.bucket.clone(),
            requests: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_create_tokens: 0,
            tokens_per_sec: None,
            decode_tokens_per_sec: None,
            cost: 0.0,
        });
        point.requests += 1;
        point.input_tokens += r.input_tokens;
        point.output_tokens += r.output_tokens;
        point.cache_read_tokens += r.cache_read_tokens;
        point.cache_create_tokens += r.cache_create_tokens;
        point.cost = *cost_by_month.cost.get(&r.bucket).unwrap_or(&0.0);
        let s = speed.entry(r.bucket.clone()).or_insert((0, 0, 0, 0));
        s.0 += r.output_tokens;
        s.1 += r.duration_ms;
        s.2 += r.decode_output_tokens;
        s.3 += r.decode_duration_ms;
    }
    for (bucket, s) in &speed {
        if let Some(p) = by_month.get_mut(bucket) {
            p.tokens_per_sec = weighted_tokens_per_sec(s.0, Some(s.1));
            p.decode_tokens_per_sec = weighted_tokens_per_sec(s.2, Some(s.3));
        }
    }
    Ok(by_month.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        crate::db::open_db().expect("打开 zcode 库失败")
    }

    fn pricing_path() -> std::path::PathBuf {
        std::env::temp_dir().join("agents-dashboard-test-pricing.json")
    }

    /// 直连真实库冒烟:model_usage.id 是 TEXT,行映射类型写错会在这里暴露
    #[test]
    fn request_log_smoke() {
        let resp = get_request_log(&conn(), &Range::default(), 1, 10, &pricing_path())
            .expect("get_request_log");
        assert!(resp.groups.len() <= 10);
        assert_eq!(resp.page, 1);
        // 每组内请求时间升序;子代理行应带 subagent_child 标记
        let mut saw_child = false;
        for g in &resp.groups {
            assert!(!g.session_id.is_empty());
            for pair in g.requests.windows(2) {
                assert!(pair[0].started_at <= pair[1].started_at);
            }
            for row in &g.requests {
                assert!(!row.id.is_empty());
                if row.task_type.as_deref() == Some("subagent_child") {
                    saw_child = true;
                }
            }
        }
        let _ = saw_child;
    }

    fn entry(input: f64, output: f64, cache_read: f64) -> crate::types::PriceEntry {
        crate::types::PriceEntry {
            input,
            output,
            cache_read,
            cache_write: 0.0,
            currency: None,
            peak: None,
            long_context: None,
        }
    }

    /// 计费口径:输入价只作用于未命中部分。zcode 的 input_tokens 含缓存命中(OpenAI usage 口径),
    /// 命中部分已按 cache_read 价计入,若再乘输入价就是重复计费(旧的聚合公式正是这个问题)
    #[test]
    fn cost_input_price_only_on_miss() {
        let mut cfg = PricingConfig::default();
        cfg.models.insert("m".into(), entry(1.0, 4.0, 0.02));
        // 输入 100 万(其中 90 万命中),输出 10 万
        let (cost, priced) = cfg.cost_row("m", 0, 1_000_000, 100_000, 900_000, 0);
        assert!(priced);
        // 未命中 10万×1.0 + 命中 90万×0.02 + 输出 10万×4.0 = 0.1 + 0.018 + 0.4
        assert!((cost - 0.518).abs() < 1e-9, "cost={cost}");
    }

    /// 未配置价格的模型费用为 0 且 priced=false(面板据此提示"未配置价格")
    #[test]
    fn cost_unpriced_model_is_zero() {
        let cfg = PricingConfig::default();
        let (cost, priced) = cfg.cost_row("no-such-model", 0, 1_000_000, 1_000_000, 0, 0);
        assert_eq!(cost, 0.0);
        assert!(!priced);
    }

    /// 峰谷:windows 列的是峰时段,其余自动为谷;谷时按基准价,峰时乘倍率,含窗口端点
    #[test]
    fn cost_peak_multiplier_window_and_edges() {
        use chrono::{Local, TimeZone, Timelike};
        let mut cfg = PricingConfig::default();
        let mut e = entry(2.0, 2.0, 2.0);
        e.peak = Some(crate::types::PeakPricing {
            multiplier: 2.0,
            kind: "peak".into(),
            windows: vec![
                crate::types::PeakWindow { start_min: 8 * 60 + 30, end_min: 1440 },
                crate::types::PeakWindow { start_min: 0, end_min: 30 },
            ],
        });
        cfg.models.insert("m".into(), e);

        // 断言不写死时区:用本机时区把"当天某时某分"换算成时间戳
        let day = 86_400_000i64;
        let base = Local.timestamp_millis_opt(day).single().unwrap_or_else(Local::now);
        let at = |h: u32, mi: u32| {
            let dt = base
                .with_hour(h)
                .and_then(|d| d.with_minute(mi))
                .and_then(|d| d.with_second(0))
                .and_then(|d| d.with_nanosecond(0))
                .unwrap();
            cfg.cost_row("m", dt.timestamp_millis(), 1_000_000, 0, 0, 0).0
        };

        assert!((at(10, 0) - 4.0).abs() < 1e-9, "10:00 在峰时段内,应 ×2");
        assert!((at(8, 29) - 2.0).abs() < 1e-9, "08:29 是谷时段(峰窗从 08:30 开始)");
        assert!((at(8, 30) - 4.0).abs() < 1e-9, "08:30 进入峰时段");
        assert!((at(23, 59) - 4.0).abs() < 1e-9, "23:59 仍在峰时段");
        assert!((at(0, 0) - 4.0).abs() < 1e-9, "00:00 在峰时段内(跨日的第二条峰窗)");
        assert!((at(0, 29) - 4.0).abs() < 1e-9, "00:29 仍在峰时段");
        assert!((at(0, 30) - 2.0).abs() < 1e-9, "00:30 起为谷时段");
    }

    /// 峰谷时段可配置:把列表声明为谷时段后判定整体翻转(kind 容忍下划线/驼峰写法)
    #[test]
    fn peak_config_kind_off_peak_inverts() {
        use chrono::{Local, TimeZone, Timelike};
        let mut cfg = PricingConfig::default();
        let mut e = entry(2.0, 2.0, 2.0);
        e.peak = Some(crate::types::PeakPricing {
            multiplier: 2.0,
            kind: "off_peak".into(),
            windows: vec![crate::types::PeakWindow { start_min: 0, end_min: 8 * 60 }],
        });
        cfg.models.insert("m".into(), e);
        let base = Local.timestamp_millis_opt(86_400_000i64).single().unwrap_or_else(Local::now);
        let at = |h: u32| {
            let dt = base.with_hour(h).and_then(|d| d.with_minute(0)).and_then(|d| d.with_second(0)).and_then(|d| d.with_nanosecond(0)).unwrap();
            cfg.cost_row("m", dt.timestamp_millis(), 1_000_000, 0, 0, 0).0
        };
        // 02:00 在列出的谷时段内 → 不加价;12:00 是补集(峰)→ ×2
        assert!((at(2) - 2.0).abs() < 1e-9, "02:00 为谷");
        assert!((at(12) - 4.0).abs() < 1e-9, "12:00 为峰");
    }

    /// 未启用峰谷的模型不参与峰谷判定:同一时刻、同一倍率配置下,不填 peak 就没有加价
    #[test]
    fn peak_absent_skips_peak_pricing() {
        use chrono::{Local, TimeZone, Timelike};
        let base = Local.timestamp_millis_opt(86_400_000i64).single().unwrap_or_else(Local::now);
        let peak_ts = base.with_hour(10).and_then(|d| d.with_minute(0)).and_then(|d| d.with_second(0)).and_then(|d| d.with_nanosecond(0)).unwrap().timestamp_millis();

        let mut off = PricingConfig::default();
        off.models.insert("m".into(), entry(2.0, 2.0, 2.0));
        assert!((off.cost_row("m", peak_ts, 1_000_000, 0, 0, 0).0 - 2.0).abs() < 1e-9);

        let mut on = PricingConfig::default();
        let mut e = entry(2.0, 2.0, 2.0);
        e.peak = Some(crate::types::PeakPricing {
            multiplier: 2.0,
            kind: "peak".into(),
            windows: vec![crate::types::PeakWindow { start_min: 8 * 60, end_min: 12 * 60 }],
        });
        on.models.insert("m".into(), e);
        assert!((on.cost_row("m", peak_ts, 1_000_000, 0, 0, 0).0 - 4.0).abs() < 1e-9);
        // 谷时段(13:00)仍按基准价
        let offpeak_ts = base.with_hour(13).and_then(|d| d.with_minute(0)).and_then(|d| d.with_second(0)).and_then(|d| d.with_nanosecond(0)).unwrap().timestamp_millis();
        assert!((on.cost_row("m", offpeak_ts, 1_000_000, 0, 0, 0).0 - 2.0).abs() < 1e-9);
    }

    /// 默认峰时段为 08:00–12:00 与 14:00–18:00
    #[test]
    fn default_peak_windows_are_two_daytime_slots() {
        let p = crate::types::PeakPricing::default();
        assert_eq!(p.multiplier, 2.0);
        let ws: Vec<(i64, i64)> = p.windows.iter().map(|w| (w.start_min, w.end_min)).collect();
        assert_eq!(ws, vec![(480, 720), (840, 1080)]);
    }

    /// 缓存节省与实际计费同口径:币种折算与长上下文加价都要反映在节省额上。
    /// 修的就是"人民币价差值被当成美元再乘一次汇率"的 7.1 倍虚高
    #[test]
    fn cache_saving_follows_effective_unit_price() {
        let mut cfg = PricingConfig::default();
        cfg.usd_cny_rate = 7.0;
        let mut e = entry(7.0, 70.0, 0.7);
        e.currency = Some("cny".into());
        cfg.models.insert("m".into(), e);
        // 人民币价:输入 7 元 ÷ 7 = 1 美元,缓存读 0.7 ÷ 7 = 0.1 美元,价差 0.9 美元/百万
        let r = cfg.row_cost("m", 0, 1_000_000, 0, 1_000_000, 0);
        assert!((r.cost - 0.1).abs() < 1e-9, "cost={}", r.cost);
        assert!((r.saving - 0.9).abs() < 1e-9, "saving={}", r.saving);

        // 长上下文加价同样作用于节省额
        let mut cfg2 = PricingConfig::default();
        let mut e2 = entry(1.0, 0.0, 0.0);
        e2.long_context = Some(crate::types::LongContextPrice { threshold_tokens: 100, multiplier: 3.0 });
        cfg2.models.insert("m".into(), e2);
        let r2 = cfg2.row_cost("m", 0, 200, 0, 100, 0);
        // 达到阈值,输入价 1×3=3,缓存读价 0 → 节省 100×3/1e6
        assert!((r2.saving - 0.0003).abs() < 1e-12, "saving={}", r2.saving);
    }

    /// 长上下文:输入达到阈值时该请求全部单价乘倍率,阈值以下不受影响
    #[test]
    fn cost_long_context_multiplier() {
        let mut cfg = PricingConfig::default();
        let mut e = entry(1.0, 4.0, 0.02);
        e.long_context = Some(crate::types::LongContextPrice {
            threshold_tokens: 270_000,
            multiplier: 2.0,
        });
        cfg.models.insert("m".into(), e);
        let below = cfg.cost_row("m", 0, 269_999, 100_000, 0, 0).0;
        let at = cfg.cost_row("m", 0, 270_000, 100_000, 0, 0).0;
        // 269,999×1 + 100,000×4 = 0.269999 + 0.4 ;达到阈值后整体翻倍
        assert!((below - 0.669999).abs() < 1e-9, "below={below}");
        assert!((at - (0.27 + 0.4) * 2.0).abs() < 1e-9, "at={at}");
    }

    /// 币种:人民币价按汇率折成美元参与计算(存算统一美元)
    #[test]
    fn cost_cny_entry_converted_to_usd() {
        let mut cfg = PricingConfig::default();
        cfg.usd_cny_rate = 7.0;
        let mut e = entry(7.0, 70.0, 0.7);
        e.currency = Some("cny".into());
        cfg.models.insert("m".into(), e);
        // 输入 7 元/百万 ÷ 7 = 1 美元/百万;输出 70 元/百万 ÷ 7 = 10 美元/百万
        let (cost, _) = cfg.cost_row("m", 0, 1_000_000, 100_000, 0, 0);
        assert!((cost - 2.0).abs() < 1e-9, "cost={cost}");
    }

    /// 跨查询一致性:摘要 / 模型 / 供应商 / 项目 四处的费用必须一致。
    /// 任一处漏改计费口径都会在这里暴露
    #[test]
    fn cost_consistent_across_queries() {
        let conn = conn();
        let path = std::env::temp_dir().join("agents-dashboard-test-pricing-consistency.json");
        let mut cfg = PricingConfig::default();
        // 给范围内出现过的所有模型配同一组价,保证每一处都真正参与计算
        let ids = query_rows(&conn, "SELECT DISTINCT model_id FROM model_usage", &[], |r| {
            r.get::<_, String>(0)
        })
        .expect("distinct model_id");
        for id in ids {
            cfg.models.insert(id, entry(2.0, 6.0, 0.1));
        }
        pricing::save(&path, &cfg).expect("写临时价格表");

        // 固定时间上界(取 1 小时前):本库在测试期间仍被实时写入,而 zcode 是请求结束时
        // 才写行——一条在途的长请求可能在两次查询之间落库,started_at 却落在窗口内,
        // 于是两次查询取数集不同。留 1 小时余量足以把在途请求挡在窗口外
        let range = Range { from: None, to: Some(now_ms() - 3_600_000) };
        let summary = get_summary(&conn, &range, &path).expect("get_summary");
        let models = get_model_stats(&conn, &range, &path).expect("get_model_stats");
        let providers = get_provider_stats(&conn, &range, &path).expect("get_provider_stats");
        let projects = get_project_stats(&conn, &range, &path).expect("get_project_stats");
        let trend = get_trend(&conn, &range, &path).expect("get_trend");

        let sum_models: f64 = models.iter().map(|m| m.cost).sum();
        let sum_providers: f64 = providers.iter().map(|p| p.cost).sum();
        let sum_projects: f64 = projects.iter().map(|p| p.cost).sum();
        let sum_trend: f64 = trend.iter().map(|t| t.cost).sum();

        let tol = 1e-6 + summary.cost * 1e-12;
        assert!((summary.cost - sum_models).abs() < tol, "summary={} models={}", summary.cost, sum_models);
        assert!((summary.cost - sum_providers).abs() < tol, "summary={} providers={}", summary.cost, sum_providers);
        assert!((summary.cost - sum_projects).abs() < tol, "summary={} projects={}", summary.cost, sum_projects);
        assert!((summary.cost - sum_trend).abs() < tol, "summary={} trend={}", summary.cost, sum_trend);
        let _ = std::fs::remove_file(&path);
    }

    /// 按币种分账:美元定价与人民币定价的模型各自合计,两边相加仍等于总额;
    /// 混配时两边都必须非零,否则说明分账没真正路由
    #[test]
    fn cost_split_by_entry_currency() {
        let conn = conn();
        let range = Range { from: None, to: Some(now_ms() - 3_600_000) };
        let ids = query_rows(&conn, "SELECT DISTINCT model_id FROM model_usage", &[], |r| {
            r.get::<_, String>(0)
        })
        .expect("distinct model_id");
        assert!(ids.len() >= 2, "库里至少要有两个模型才能验证混配分账");

        let path = std::env::temp_dir().join("agents-dashboard-test-pricing-currency-split.json");
        let mut cfg = PricingConfig::default();
        cfg.usd_cny_rate = 7.0;
        for (i, id) in ids.iter().enumerate() {
            // 同为 7 元人民币价 / 1 美元等价价,价格本身不影响分账归属
            let mut e = entry(7.0, 70.0, 0.7);
            if i % 2 == 0 {
                e.currency = Some("cny".into());
            }
            cfg.models.insert(id.clone(), e);
        }
        pricing::save(&path, &cfg).expect("写临时价格表");
        let s = get_summary(&conn, &range, &path).expect("get_summary");

        assert!(s.cost_usd > 0.0, "美元侧合计应为正:{}", s.cost_usd);
        assert!(s.cost_cny > 0.0, "人民币侧合计应为正:{}", s.cost_cny);
        // 分账是拆分而非换算:人民币侧是人民币金额,折算回美元后与总额一致
        let split_total = s.cost_usd + s.cost_cny / cfg.usd_cny_rate;
        assert!(
            (split_total - s.cost).abs() < 1e-6 + s.cost * 1e-12,
            "usd={} cny={} cost={}",
            s.cost_usd,
            s.cost_cny,
            s.cost
        );
        // 缓存节省按同一套币种归属拆分,两边相加仍等于节省总额
        assert!(s.cache_savings_usd > 0.0, "美元侧节省应为正:{}", s.cache_savings_usd);
        assert!(s.cache_savings_cny > 0.0, "人民币侧节省应为正:{}", s.cache_savings_cny);
        let split_saving = s.cache_savings_usd + s.cache_savings_cny / cfg.usd_cny_rate;
        assert!(
            (split_saving - s.cache_savings).abs() < 1e-6 + s.cache_savings * 1e-12,
            "saving usd={} cny={} total={}",
            s.cache_savings_usd,
            s.cache_savings_cny,
            s.cache_savings
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn summary_smoke() {
        let s = get_summary(&conn(), &Range::default(), &pricing_path()).expect("get_summary");
        assert!(s.requests >= 0);
    }

    /// 请求日志与用量明细的费用币种:每行必须带上该模型价格条目的币种,
    /// 否则前端只能按全局展示币种贴符号,混用两种定价时必然有一边是错的
    #[test]
    fn request_and_model_rows_carry_entry_currency() {
        let conn = conn();
        let range = Range { from: None, to: Some(now_ms() - 3_600_000) };
        let ids = query_rows(&conn, "SELECT DISTINCT model_id FROM model_usage", &[], |r| {
            r.get::<_, String>(0)
        })
        .expect("distinct model_id");
        assert!(ids.len() >= 2, "库里至少要有两个模型才能验证币种标注");

        let path = std::env::temp_dir().join("agents-dashboard-test-pricing-row-currency.json");
        let mut cfg = PricingConfig::default();
        for (i, id) in ids.iter().enumerate() {
            let mut e = entry(1.0, 4.0, 0.02);
            e.currency = Some(if i % 2 == 0 { "cny" } else { "usd" }.into());
            cfg.models.insert(id.clone(), e);
        }
        pricing::save(&path, &cfg).expect("写临时价格表");

        let log = get_request_log(&conn, &range, 1, 10, &path).expect("get_request_log");
        let mut saw_cny = false;
        let mut saw_usd = false;
        for g in &log.groups {
            for row in &g.requests {
                let want = cfg.models[&row.model_id].currency.clone();
                assert_eq!(row.currency, want, "请求行 {} 的币种应跟随价格表", row.model_id);
                if pricing::is_cny_currency(row.currency.as_deref()) {
                    saw_cny = true;
                } else {
                    saw_usd = true;
                }
            }
        }
        assert!(saw_cny && saw_usd, "本页应同时出现两种币种的请求行");

        let models = get_model_stats(&conn, &range, &path).expect("get_model_stats");
        for m in &models {
            assert_eq!(m.currency, cfg.models[&m.model_id].currency, "模型行 {} 的币种应跟随价格表", m.model_id);
        }

        let _ = std::fs::remove_file(&path);
    }

    /// 分组行的分币种金额:项目/供应商下混用两种定价时,两侧必须都非零且相加等于该行总额。
    /// 只按总额贴一个符号会让另一边显示成错的金额(这正是本次要修的展示问题)
    #[test]
    fn grouped_rows_split_cost_by_currency() {
        let conn = conn();
        let range = Range { from: None, to: Some(now_ms() - 3_600_000) };
        let ids = query_rows(&conn, "SELECT DISTINCT model_id FROM model_usage", &[], |r| {
            r.get::<_, String>(0)
        })
        .expect("distinct model_id");
        assert!(ids.len() >= 2, "库里至少要有两个模型才能验证混配分组");

        let path = std::env::temp_dir().join("agents-dashboard-test-pricing-group-split.json");
        let mut cfg = PricingConfig::default();
        cfg.usd_cny_rate = 7.0;
        for (i, id) in ids.iter().enumerate() {
            // 两侧价格等价(7 元 ÷ 7 = 1 美元),只验证归属与守恒,不验证价格本身
            let mut e = entry(7.0, 70.0, 0.7);
            if i % 2 == 0 {
                e.currency = Some("cny".into());
            }
            cfg.models.insert(id.clone(), e);
        }
        pricing::save(&path, &cfg).expect("写临时价格表");

        let projects = get_project_stats(&conn, &range, &path).expect("get_project_stats");
        let providers = get_provider_stats(&conn, &range, &path).expect("get_provider_stats");

        let mut project_split = 0.0;
        for p in &projects {
            assert!(
                (p.cost_usd + p.cost_cny / cfg.usd_cny_rate - p.cost).abs() < 1e-9,
                "项目 {} 两侧相加应等于总额:usd={} cny={} cost={}",
                p.name,
                p.cost_usd,
                p.cost_cny,
                p.cost
            );
            project_split += p.cost_cny;
        }
        let mut provider_split = 0.0;
        for p in &providers {
            assert!(
                (p.cost_usd + p.cost_cny / cfg.usd_cny_rate - p.cost).abs() < 1e-9,
                "供应商 {} 两侧相加应等于总额:usd={} cny={} cost={}",
                p.name,
                p.cost_usd,
                p.cost_cny,
                p.cost
            );
            // 展开行逐模型带币种,且该模型金额归入供应商对应侧
            for m in &p.models {
                assert_eq!(m.currency, cfg.models[&m.model_id].currency, "展开行 {} 的币种应跟随价格表", m.model_id);
            }
            provider_split += p.cost_cny;
        }
        assert!(project_split > 0.0, "项目侧应有人币金额");
        assert!(provider_split > 0.0, "供应商侧应有人币金额");
        // 两侧合计互相对应:同一批请求按不同维度分组,人民币金额总额必须一致
        assert!(
            (project_split - provider_split).abs() < 1e-6 + provider_split * 1e-12,
            "项目侧人币合计 {} 与供应商侧 {} 应一致",
            project_split,
            provider_split
        );

        let _ = std::fs::remove_file(&path);
    }
}

