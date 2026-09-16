import { db } from "./db";
import type {
  ErrorStats,
  HeatCell,
  LatencyStat,
  ModelStat,
  ModelTrendPoint,
  PricingMap,
  ProjectStat,
  ProviderModelStat,
  ProviderStat,
  ProviderTrendPoint,
  RequestLogResponse,
  RequestRow,
  Summary,
  ToolStat,
  TrendPoint,
} from "../shared/types";
import { loadPricing } from "./pricing";
import { loadProviderNames } from "./providers";

// model_usage 一行 = 一次模型调用;子代理会话通过 parent_id 挂到父会话的项目上
const FROM_CLAUSE = `
  FROM model_usage mu
  JOIN session s ON s.id = mu.session_id
  LEFT JOIN session p ON p.id = s.parent_id
`;

const PROJECT_DIR = "COALESCE(p.directory, s.directory)";
const SESSION_KEY = "COALESCE(s.parent_id, mu.session_id)";

interface Range {
  from?: number;
  to?: number;
}

function buildWhere(range: Range): { sql: string; params: number[] } {
  const conds = ["mu.status = 'completed'"];
  const params: number[] = [];
  if (range.from != null) {
    conds.push("mu.started_at >= ?");
    params.push(range.from);
  }
  if (range.to != null) {
    conds.push("mu.started_at <= ?");
    params.push(range.to);
  }
  return { sql: `WHERE ${conds.join(" AND ")}`, params };
}

/** 只按时间范围生成条件(不过滤状态),供错误/工具/热力图等统计自行组合 */
function rangeConds(col: string, range: Range): { conds: string[]; params: number[] } {
  const conds: string[] = [];
  const params: number[] = [];
  if (range.from != null) {
    conds.push(`${col} >= ?`);
    params.push(range.from);
  }
  if (range.to != null) {
    conds.push(`${col} <= ?`);
    params.push(range.to);
  }
  return { conds, params };
}

export function earliestTimestamp(): number | null {
  const row = db.prepare("SELECT MIN(started_at) AS v FROM model_usage").get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? null;
}

/** 把 token 数按模型单价折算成费用;返回 priced=false 表示该模型没配置单价 */
function costOf(
  pricing: PricingMap,
  modelId: string,
  t: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number },
): { cost: number; priced: boolean } {
  const p = pricing[modelId];
  if (!p) return { cost: 0, priced: false };
  const cost =
    (t.inputTokens * p.input +
      t.outputTokens * p.output +
      t.cacheReadTokens * p.cacheRead +
      t.cacheCreateTokens * p.cacheWrite) /
    1e6;
  return { cost, priced: true };
}

export function getSummary(range: Range): Summary {
  const { sql, params } = buildWhere(range);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS requests,
              COUNT(DISTINCT ${SESSION_KEY}) AS sessions,
              SUM(mu.input_tokens) AS inputTokens,
              SUM(mu.output_tokens) AS outputTokens,
              SUM(mu.reasoning_tokens) AS reasoningTokens,
              SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
              SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens
       ${FROM_CLAUSE} ${sql}`,
    )
    .get(...params) as any;

  // 费用需要按模型分别折算,单独查一次分组
  const perModel = db
    .prepare(
      `SELECT mu.model_id AS modelId,
              SUM(mu.input_tokens) AS inputTokens,
              SUM(mu.output_tokens) AS outputTokens,
              SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
              SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens
       ${FROM_CLAUSE} ${sql}
       GROUP BY mu.model_id`,
    )
    .all(...params) as Array<any>;

  const pricing = loadPricing();
  let cost = 0;
  const unpricedModels: string[] = [];
  for (const m of perModel) {
    const r = costOf(pricing, m.modelId, m);
    cost += r.cost;
    if (!r.priced) unpricedModels.push(m.modelId);
  }

  return {
    requests: row.requests ?? 0,
    sessions: row.sessions ?? 0,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    reasoningTokens: row.reasoningTokens ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    cacheCreateTokens: row.cacheCreateTokens ?? 0,
    cost,
    unpricedModels,
  };
}

/** 解析时间范围并决定分桶粒度(跨度 ≤24h 按小时,否则按天) */
function resolveBuckets(range: Range) {
  const to = range.to ?? Date.now();
  const from = range.from ?? earliestTimestamp() ?? to - 7 * 86400_000;
  const hourly = to - from <= 24 * 3600_000;
  const bucketExpr = hourly
    ? `strftime('%Y-%m-%dT%H:00:00', mu.started_at/1000, 'unixepoch', 'localtime')`
    : `date(mu.started_at/1000, 'unixepoch', 'localtime')`;
  return { from, to, hourly, bucketExpr };
}

/** 从 from 到 to 补齐空桶让曲线连续(最多 500 个),make 负责生成每个桶的初始值 */
function fillBuckets<T>(
  from: number,
  to: number,
  hourly: boolean,
  make: (bucket: string) => T,
): T[] {
  const points: T[] = [];
  const stepMs = hourly ? 3600_000 : 24 * 3600_000;
  const cursor = new Date(from);
  cursor.setMinutes(0, 0, 0);
  if (!hourly) cursor.setHours(0, 0, 0, 0);
  for (; cursor.getTime() <= to && points.length < 500; cursor.setTime(cursor.getTime() + stepMs)) {
    points.push(make(bucketKey(cursor, hourly)));
  }
  return points;
}

export function getTrend(range: Range): TrendPoint[] {
  const { from, to, hourly, bucketExpr } = resolveBuckets(range);

  const { sql, params } = buildWhere(range);
  const rows = db
    .prepare(
      `SELECT ${bucketExpr} AS bucket,
              mu.model_id AS modelId,
              SUM(mu.input_tokens) AS inputTokens,
              SUM(mu.output_tokens) AS outputTokens,
              SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
              SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens
       ${FROM_CLAUSE} ${sql}
       GROUP BY bucket, mu.model_id
       ORDER BY bucket`,
    )
    .all(...params) as Array<any>;

  // 先按模型折算费用,再合并进时间桶
  const pricing = loadPricing();
  const byBucket = new Map<string, TrendPoint>();
  for (const r of rows) {
    const point =
      byBucket.get(r.bucket) ??
      ({ bucket: r.bucket, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0 } as TrendPoint);
    point.inputTokens += r.inputTokens;
    point.outputTokens += r.outputTokens;
    point.cacheReadTokens += r.cacheReadTokens;
    point.cacheCreateTokens += r.cacheCreateTokens;
    point.cost += costOf(pricing, r.modelId, r).cost;
    byBucket.set(r.bucket, point);
  }

  const points = fillBuckets(
    from,
    to,
    hourly,
    (bucket) =>
      byBucket.get(bucket) ??
      ({ bucket, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0 } as TrendPoint),
  );
  return points.length > 0 ? points : [...byBucket.values()];
}

export function getTrendByModel(range: Range): ModelTrendPoint[] {
  const { from, to, hourly, bucketExpr } = resolveBuckets(range);

  const { sql, params } = buildWhere(range);
  const rows = db
    .prepare(
      `SELECT ${bucketExpr} AS bucket,
              mu.model_id AS modelId,
              SUM(mu.input_tokens) AS inputTokens,
              SUM(mu.output_tokens) AS outputTokens,
              SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
              SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens
       ${FROM_CLAUSE} ${sql}
       GROUP BY bucket, mu.model_id`,
    )
    .all(...params) as Array<any>;

  const pricing = loadPricing();
  const byBucket = new Map<string, Map<string, { tokens: number; cost: number }>>();
  for (const r of rows) {
    let models = byBucket.get(r.bucket);
    if (!models) {
      models = new Map();
      byBucket.set(r.bucket, models);
    }
    const tokens =
      (r.inputTokens ?? 0) +
      (r.outputTokens ?? 0) +
      (r.cacheReadTokens ?? 0) +
      (r.cacheCreateTokens ?? 0);
    models.set(r.modelId, { tokens, cost: costOf(pricing, r.modelId, r).cost });
  }

  const points = fillBuckets(from, to, hourly, (bucket) => ({
    bucket,
    models: byBucket.get(bucket) ?? new Map<string, { tokens: number; cost: number }>(),
  }));
  const result =
    points.length > 0
      ? points
      : [...byBucket.entries()].map(([bucket, models]) => ({ bucket, models }));
  return result.map((p) => ({ bucket: p.bucket, models: Object.fromEntries(p.models) }));
}

/** 按供应商拆分的趋势:费用要按模型折算,所以分桶先到模型粒度再归并进供应商 */
export function getTrendByProvider(range: Range): ProviderTrendPoint[] {
  const { from, to, hourly, bucketExpr } = resolveBuckets(range);

  const { sql, params } = buildWhere(range);
  const rows = db
    .prepare(
      `SELECT ${bucketExpr} AS bucket,
              mu.provider_id AS providerId,
              mu.model_id AS modelId,
              SUM(mu.input_tokens) AS inputTokens,
              SUM(mu.output_tokens) AS outputTokens,
              SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
              SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens
       ${FROM_CLAUSE} ${sql}
       GROUP BY bucket, mu.provider_id, mu.model_id`,
    )
    .all(...params) as Array<any>;

  const pricing = loadPricing();
  const byBucket = new Map<string, Map<string, { tokens: number; cost: number }>>();
  for (const r of rows) {
    let providers = byBucket.get(r.bucket);
    if (!providers) {
      providers = new Map();
      byBucket.set(r.bucket, providers);
    }
    const tokens =
      (r.inputTokens ?? 0) +
      (r.outputTokens ?? 0) +
      (r.cacheReadTokens ?? 0) +
      (r.cacheCreateTokens ?? 0);
    const acc = providers.get(r.providerId) ?? { tokens: 0, cost: 0 };
    acc.tokens += tokens;
    acc.cost += costOf(pricing, r.modelId, r).cost;
    providers.set(r.providerId, acc);
  }

  const points = fillBuckets(from, to, hourly, (bucket) => ({
    bucket,
    providers: byBucket.get(bucket) ?? new Map<string, { tokens: number; cost: number }>(),
  }));
  const result =
    points.length > 0
      ? points
      : [...byBucket.entries()].map(([bucket, providers]) => ({ bucket, providers }));
  return result.map((p) => ({ bucket: p.bucket, providers: Object.fromEntries(p.providers) }));
}

function bucketKey(d: Date, hourly: boolean): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return hourly ? `${date}T${pad(d.getHours())}:00:00` : date;
}

export function getModelStats(range: Range): ModelStat[] {
  const { sql, params } = buildWhere(range);
  const rows = db
    .prepare(
      `SELECT mu.model_id AS modelId,
              COUNT(*) AS requests,
              COUNT(DISTINCT ${SESSION_KEY}) AS sessions,
              SUM(mu.input_tokens) AS inputTokens,
              SUM(mu.output_tokens) AS outputTokens,
              SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
              SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens
       ${FROM_CLAUSE} ${sql}
       GROUP BY mu.model_id
       ORDER BY requests DESC`,
    )
    .all(...params) as Array<any>;

  const pricing = loadPricing();
  return rows.map((r) => {
    const { cost, priced } = costOf(pricing, r.modelId, r);
    return { ...r, cost, priced };
  });
}

export function getProjectStats(range: Range): ProjectStat[] {
  const { sql, params } = buildWhere(range);
  const rows = db
    .prepare(
      `SELECT ${PROJECT_DIR} AS directory,
              COUNT(*) AS requests,
              COUNT(DISTINCT ${SESSION_KEY}) AS sessions,
              SUM(mu.input_tokens) AS inputTokens,
              SUM(mu.output_tokens) AS outputTokens,
              SUM(mu.input_tokens + mu.output_tokens + mu.cache_read_input_tokens + mu.cache_creation_input_tokens) AS totalTokens
       ${FROM_CLAUSE} ${sql}
       GROUP BY ${PROJECT_DIR}
       ORDER BY totalTokens DESC`,
    )
    .all(...params) as Array<any>;

  const perModelProject = db
    .prepare(
      `SELECT ${PROJECT_DIR} AS directory, mu.model_id AS modelId,
              SUM(mu.input_tokens) AS inputTokens,
              SUM(mu.output_tokens) AS outputTokens,
              SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
              SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens
       ${FROM_CLAUSE} ${sql}
       GROUP BY ${PROJECT_DIR}, mu.model_id`,
    )
    .all(...params) as Array<any>;

  const pricing = loadPricing();
  const costByDir = new Map<string, number>();
  for (const r of perModelProject) {
    costByDir.set(r.directory, (costByDir.get(r.directory) ?? 0) + costOf(pricing, r.modelId, r).cost);
  }

  return rows.map((r) => ({
    ...r,
    name: r.directory.split("/").filter(Boolean).pop() ?? r.directory,
    cost: costByDir.get(r.directory) ?? 0,
  }));
}

/** 按供应商统计:provider_id 到名称的映射读自 zcode 配置文件 */
export function getProviderStats(range: Range): ProviderStat[] {
  const { sql, params } = buildWhere(range);
  const rows = db
    .prepare(
      `SELECT mu.provider_id AS providerId,
              COUNT(*) AS requests,
              COUNT(DISTINCT ${SESSION_KEY}) AS sessions,
              SUM(mu.input_tokens) AS inputTokens,
              SUM(mu.output_tokens) AS outputTokens,
              SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
              SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens
       ${FROM_CLAUSE} ${sql}
       GROUP BY mu.provider_id`,
    )
    .all(...params) as Array<any>;

  // 供应商 × 模型分组:费用折算和展开行的模型明细都用它
  const perModel = db
    .prepare(
      `SELECT mu.provider_id AS providerId,
              mu.model_id AS modelId,
              COUNT(*) AS requests,
              COUNT(DISTINCT ${SESSION_KEY}) AS sessions,
              SUM(mu.input_tokens) AS inputTokens,
              SUM(mu.output_tokens) AS outputTokens,
              SUM(mu.cache_read_input_tokens) AS cacheReadTokens,
              SUM(mu.cache_creation_input_tokens) AS cacheCreateTokens
       ${FROM_CLAUSE} ${sql}
       GROUP BY mu.provider_id, mu.model_id`,
    )
    .all(...params) as Array<any>;

  const pricing = loadPricing();
  const costByProvider = new Map<string, number>();
  const modelsByProvider = new Map<string, ProviderModelStat[]>();
  for (const r of perModel) {
    costByProvider.set(
      r.providerId,
      (costByProvider.get(r.providerId) ?? 0) + costOf(pricing, r.modelId, r).cost,
    );
    let models = modelsByProvider.get(r.providerId);
    if (!models) {
      models = [];
      modelsByProvider.set(r.providerId, models);
    }
    models.push({
      modelId: r.modelId,
      requests: r.requests ?? 0,
      sessions: r.sessions ?? 0,
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      cacheCreateTokens: r.cacheCreateTokens ?? 0,
      totalTokens:
        (r.inputTokens ?? 0) +
        (r.outputTokens ?? 0) +
        (r.cacheReadTokens ?? 0) +
        (r.cacheCreateTokens ?? 0),
      cost: costOf(pricing, r.modelId, r).cost,
    });
  }
  for (const models of modelsByProvider.values()) {
    models.sort((a, b) => b.totalTokens - a.totalTokens);
  }

  // 错误数不过滤状态单独统计(与错误分析面板口径一致)
  const { conds, params: errParams } = rangeConds("mu.started_at", range);
  const errWhere = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const errRows = db
    .prepare(
      `SELECT mu.provider_id AS providerId,
              SUM(mu.status = 'error') AS errors
       FROM model_usage mu ${errWhere}
       GROUP BY mu.provider_id`,
    )
    .all(...errParams) as Array<{ providerId: string; errors: number | null }>;
  const errorsByProvider = new Map(errRows.map((r) => [r.providerId, r.errors ?? 0]));

  const names = loadProviderNames();
  return rows
    .map((r) => ({
      providerId: r.providerId as string,
      name: names[r.providerId] ?? r.providerId,
      requests: r.requests ?? 0,
      sessions: r.sessions ?? 0,
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      cacheCreateTokens: r.cacheCreateTokens ?? 0,
      totalTokens:
        (r.inputTokens ?? 0) +
        (r.outputTokens ?? 0) +
        (r.cacheReadTokens ?? 0) +
        (r.cacheCreateTokens ?? 0),
      cost: costByProvider.get(r.providerId) ?? 0,
      errors: errorsByProvider.get(r.providerId) ?? 0,
      models: modelsByProvider.get(r.providerId) ?? [],
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export function getRequestLog(range: Range, page: number, pageSize: number): RequestLogResponse {
  const { sql, params } = buildWhere(range);
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total ${FROM_CLAUSE} ${sql}`)
    .get(...params) as any;

  const rows = db
    .prepare(
      `SELECT mu.id AS id,
              mu.started_at AS startedAt,
              mu.model_id AS modelId,
              mu.agent AS agent,
              mu.status AS status,
              mu.duration_ms AS durationMs,
              mu.time_to_first_token_ms AS timeToFirstTokenMs,
              mu.input_tokens AS inputTokens,
              mu.output_tokens AS outputTokens,
              mu.cache_read_input_tokens AS cacheReadTokens,
              mu.cache_creation_input_tokens AS cacheCreateTokens,
              ${PROJECT_DIR} AS project,
              s.title AS title
       ${FROM_CLAUSE} ${sql}
       ORDER BY mu.started_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as Array<any>;

  const pricing = loadPricing();
  return {
    total: totalRow.total,
    page,
    pageSize,
    rows: rows.map((r) => ({
      ...r,
      project: r.project.split("/").filter(Boolean).pop() ?? r.project,
      cost: costOf(pricing, r.modelId, r).cost,
    })),
  };
}

/** 工具调用统计:tool_usage 一行 = 一次工具调用,含错误/取消与耗时 */
export function getToolStats(range: Range): ToolStat[] {
  const { conds, params } = rangeConds("t.started_at", range);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT t.tool_name AS toolName,
              COUNT(*) AS calls,
              SUM(t.status = 'error') AS errors,
              SUM(t.status = 'cancelled') AS cancelled,
              AVG(t.duration_ms) AS avgMs,
              MAX(t.duration_ms) AS maxMs
       FROM tool_usage t ${where}
       GROUP BY t.tool_name
       ORDER BY calls DESC`,
    )
    .all(...params) as Array<any>;
  return rows.map((r) => ({
    toolName: r.toolName,
    calls: r.calls ?? 0,
    errors: r.errors ?? 0,
    cancelled: r.cancelled ?? 0,
    avgMs: r.avgMs != null ? Math.round(r.avgMs) : null,
    maxMs: r.maxMs ?? null,
  }));
}

/** 错误/取消/重试分析:不过滤状态,按 status 汇总 + 按错误类型分组 */
export function getErrorStats(range: Range): ErrorStats {
  const stat: ErrorStats = {
    total: 0,
    completed: 0,
    error: 0,
    cancelled: 0,
    cancelledByUser: 0,
    retriedRequests: 0,
    contextExceeded: 0,
    groups: [],
  };

  const { conds, params } = rangeConds("mu.started_at", range);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const statusRows = db
    .prepare(
      `SELECT mu.status AS status,
              COUNT(*) AS n,
              SUM(mu.cancelled_by_user) AS byUser,
              SUM(mu.retry_count > 0) AS retried,
              SUM(mu.context_exceeded) AS ctxExceeded
       FROM model_usage mu ${where}
       GROUP BY mu.status`,
    )
    .all(...params) as Array<any>;
  for (const r of statusRows) {
    stat.total += r.n;
    if (r.status === "completed") stat.completed += r.n;
    else if (r.status === "error") stat.error += r.n;
    else if (r.status === "cancelled") stat.cancelled += r.n;
    stat.cancelledByUser += r.byUser ?? 0;
    stat.retriedRequests += r.retried ?? 0;
    stat.contextExceeded += r.ctxExceeded ?? 0;
  }

  // 错误明细只看 error/cancelled 两类,按 error_type + error_code 归组
  const errConds = [...conds, "mu.status IN ('error', 'cancelled')"];
  stat.groups = db
    .prepare(
      `SELECT COALESCE(mu.error_type, '') AS errorType,
              COALESCE(mu.error_code, '') AS errorCode,
              COUNT(*) AS count,
              MAX(mu.error_message) AS sampleMessage
       FROM model_usage mu
       WHERE ${errConds.join(" AND ")}
       GROUP BY mu.error_type, mu.error_code
       ORDER BY count DESC`,
    )
    .all(...params) as Array<any>;
  return stat;
}

/** 延迟指标:取原始行在 TS 里算百分位(SQLite 无原生 PERCENTILE),仅 completed 行 */
export function getLatencyStats(range: Range): LatencyStat[] {
  const { conds, params } = rangeConds("mu.started_at", range);
  conds.push("mu.status = 'completed'");
  const rows = db
    .prepare(
      `SELECT mu.model_id AS modelId,
              mu.duration_ms AS durationMs,
              mu.time_to_first_token_ms AS ttftMs
       FROM model_usage mu
       WHERE ${conds.join(" AND ")}`,
    )
    .all(...params) as Array<{ modelId: string; durationMs: number | null; ttftMs: number | null }>;

  const byModel = new Map<string, { durations: number[]; ttfts: number[] }>();
  for (const r of rows) {
    let m = byModel.get(r.modelId);
    if (!m) {
      m = { durations: [], ttfts: [] };
      byModel.set(r.modelId, m);
    }
    if (r.durationMs != null) m.durations.push(r.durationMs);
    if (r.ttftMs != null) m.ttfts.push(r.ttftMs);
  }

  /** 最近秩(percentile rank 取整):p50 即向上取第 50% 位元素 */
  const percentile = (sorted: number[], p: number): number | null => {
    if (sorted.length === 0) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  };

  const result: LatencyStat[] = [];
  for (const [modelId, m] of byModel) {
    const durations = [...m.durations].sort((a, b) => a - b);
    const ttfts = [...m.ttfts].sort((a, b) => a - b);
    const avg =
      m.durations.length > 0
        ? Math.round(m.durations.reduce((s, v) => s + v, 0) / m.durations.length)
        : null;
    result.push({
      modelId,
      requests: m.durations.length,
      avgMs: avg,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      ttftP50Ms: percentile(ttfts, 50),
      ttftP95Ms: percentile(ttfts, 95),
    });
  }
  return result.sort((a, b) => b.requests - a.requests);
}

/** 活跃热力图:星期 × 小时的调用次数(本地时间,含所有状态——反映活跃度而非成功量) */
export function getActivityHeatmap(range: Range): HeatCell[] {
  const { conds, params } = rangeConds("mu.started_at", range);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%w', mu.started_at/1000, 'unixepoch', 'localtime') AS INTEGER) AS dow,
              CAST(strftime('%H', mu.started_at/1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
              COUNT(*) AS calls
       FROM model_usage mu ${where}
       GROUP BY dow, hour
       ORDER BY dow, hour`,
    )
    .all(...params) as Array<any>;
  return rows.map((r) => ({ dow: r.dow, hour: r.hour, calls: r.calls ?? 0 }));
}
