export function fmtTokens(n: number | null | undefined): string {
  const v = n ?? 0;
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(v);
}

export function fmtNumber(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("zh-CN");
}

/** 侧栏行尾用的紧凑 Token 数：2.4M / 812k / 1.2B，整数部分够长时省掉小数 */
export function fmtTokensCompact(n: number | null | undefined): string {
  const v = n ?? 0;
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + "B";
  if (abs >= 1e6) return (v / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + "M";
  if (abs >= 1e3) return (v / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(v));
}

/**
 * 汇率配置:后端所有金额一律以美元计算与存储,这里只保留汇率本身。
 * 展示币种不再有全局开关——每个费用单元格按**该行价格表条目的币种**显示
 * (见 fmtCostIn / fmtCostSplit),否则价格表混用两种币种时总有一边贴错符号。
 * usdCny 是"1 美元折合的人民币数",用于把美元口径金额还原成人民币金额
 */
let usdCny = 7.1;

/** 用一份定价配置的汇率刷新折算系数(改完单价后由 reloadKey 触发) */
export function setUsdCnyRate(rate: number) {
  if (rate > 0 && isFinite(rate)) usdCny = rate;
}

/** 当前 1 美元折合的人民币数(汇率本身,与展示币种无关) */
export function moneyRate(): number {
  return usdCny;
}

/** 美元金额不折算也不带符号:总览图表按数值绘制用 */
export function fmtCostRaw(usd: number | null | undefined): string {
  const v = usd ?? 0;
  if (v !== 0 && Math.abs(v) < 0.01) return v.toFixed(4);
  return v.toFixed(2);
}

function amount(x: number | null | undefined): string {
  const v = x ?? 0;
  return v !== 0 && Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(2);
}

/** 该币种标记是否按人民币计价(与后端 is_cny_currency 同一套别名) */
export function isCnyCurrency(currency: string | null | undefined): boolean {
  const c = (currency ?? "usd").trim().toLowerCase();
  return c === "cny" || c === "rmb" || c === "¥";
}

/**
 * 把美元口径金额按该行价格表的币种展示——费用单元格的唯一入口。
 * 币种来自该模型的价格条目,与「模型单价」面板逐行显示的单位必然一致
 */
export function fmtCostIn(usd: number | null | undefined, currency: string | null | undefined): string {
  return isCnyCurrency(currency) ? "¥" + amount((usd ?? 0) * usdCny) : "$" + amount(usd);
}

/** 展示一个已经是该币种的金额,不做任何换算(合计拆成"美元部分 · 人民币部分"时用) */
export function fmtAmount(amount_: number | null | undefined, currency: "usd" | "cny"): string {
  return (currency === "cny" ? "¥" : "$") + amount(amount_);
}

/**
 * 分币种合计:两侧各是真实金额(不是同一总额的两种换算),人民币在前。
 * 项目/供应商这类分组下可能同时有人民币与美元定价的模型,单贴一个符号必然错一边;
 * 只有一侧非零时省略另一侧,免得并排出现"$0.00"这种噪声
 */
export function fmtCostSplit(usd: number | null | undefined, cny: number | null | undefined): string {
  const u = usd ?? 0;
  const c = cny ?? 0;
  if (c === 0) return "$" + amount(u);
  if (u === 0) return "¥" + amount(c);
  return `¥${amount(c)} · $${amount(u)}`;
}

/** 金额的整数位数（0.xx 记 1 位） */
function integerDigits(v: number): number {
  return Math.max(1, Math.trunc(Math.abs(v)).toString().length);
}

/**
 * 单侧金额缩写：按该侧整数位数选单位。
 * 4 位→K(2.7K)、5 位→W(2.7W)、6 位→W(27W)、7 位→M(2.7M)、8 位→M(27M)、
 * 9 位→M(270M)，10 位以上→B(2.7B/27B)。W=万、M=百万、B=十亿。
 *
 * 小数用截断而非四舍五入：2.771K 显示 2.7K（与口径示例一致，也避免 999→1.0K
 * 这种「涨了一档」的错觉）。缩放后整数部分 ≥10 时省略小数（27W 而不是 27.0W）。
 * `decimals=0` 是窄窗口下的更短兜底（3K）。
 */
function abbreviate(value: number, decimals: number): string {
  const digits = integerDigits(value);
  // 不足 1000 的一侧不缩写：合计位数达标时可能是「3 位 + 5 位」，
  // 把它写成 0.9K / 0K 反而更难读，保留原始整数更清楚。
  if (digits <= 3) return String(Math.trunc(value));
  let divisor: number;
  let unit: string;
  if (digits <= 4) {
    divisor = 1e3;
    unit = "K";
  } else if (digits <= 6) {
    divisor = 1e4;
    unit = "W";
  } else if (digits <= 9) {
    divisor = 1e6;
    unit = "M";
  } else {
    divisor = 1e9;
    unit = "B";
  }
  const scaled = Math.abs(value) / divisor;
  const sign = value < 0 ? "-" : "";
  // 缩放后 ≥10 或 decimals=0 时不带小数；否则截断到 1 位小数
  const showDecimals = decimals > 0 && scaled < 10;
  const shown = showDecimals ? Math.trunc(scaled * 10) / 10 : Math.trunc(scaled);
  return `${sign}${shown}${unit}`;
}

/**
 * 估算费用 KPI 的候选显示串，按精度从高到低排列。
 * 组件用真实宽度探针挑出「放得下且最精确」的那个：宽则小数位多，窄则少。
 *
 * 两侧整数位合计 ≥8 时（如 ¥2771 · $1396）优先用 K/W/M 缩写，避免 26px 字号下
 * 完整数字被硬截断成两行；<8 时优先完整数字。两种档位都作为候选保留：
 * 超宽窗口仍能读到完整值，极窄窗口也不会折行（缩写是最短兜底）。
 * 分以下的金额仍走 4 位小数，避免被抹成 0。
 */
export function costSplitCandidates(
  usd: number | null | undefined,
  cny: number | null | undefined,
): string[] {
  const u = usd ?? 0;
  const c = cny ?? 0;
  const tiny = (v: number) => v !== 0 && Math.abs(v) < 0.01;
  if (tiny(u) || tiny(c)) return [fmtCostSplit(u, c)];

  const parts: { symbol: string; value: number }[] = [];
  if (c !== 0) parts.push({ symbol: "¥", value: c });
  if (u !== 0) parts.push({ symbol: "$", value: u });
  if (parts.length === 0) return ["$0.00"];

  const full: string[] = [];
  for (let d = 2; d >= 0; d--) {
    full.push(parts.map((p) => `${p.symbol}${p.value.toFixed(d)}`).join(" · "));
  }
  const compact: string[] = [];
  for (const d of [1, 0]) {
    compact.push(parts.map((p) => `${p.symbol}${abbreviate(p.value, d)}`).join(" · "));
  }

  const totalDigits = parts.reduce((sum, p) => sum + integerDigits(p.value), 0);
  // 合计 ≥8：缩写优先（避免硬截断），完整值留给超宽窗口；
  // 合计 <8：完整值优先，缩写作为「连 0 位小数都放不下」时的最终兜底。
  // 去重：6 位/8 位时缩写 1 位与 0 位相同，小金额的完整 0 位与缩写也可能撞串。
  const ordered = totalDigits >= 8 ? [...compact, ...full] : [...full, ...compact];
  return [...new Set(ordered)];
}

/** 占比:part/total,total 为 0 时返回 "-" */
export function fmtPercent(part: number, total: number): string {
  if (!total) return "-";
  return `${((part / total) * 100).toFixed(1)}%`;
}

/** 占比(小值保留两位):0.06% 这类极小占比不失真 */
export function fmtShare(part: number, total: number): string {
  if (!total) return "-";
  const pct = (part / total) * 100;
  if (pct === 0) return "0%";
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

/** 秒值(固定 1 位小数);无数据时显示 "-" */
export function fmtSeconds(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms)) return "-";
  return `${(ms / 1000).toFixed(1)}s`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 速度值(tok/s 口径,显示不带单位);无耗时数据时显示 "-";≥100 时省略小数位 */
export function fmtSpeed(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "-";
  if (n >= 100) return String(Math.round(n));
  return n.toFixed(1);
}

/**
 * 速率的顶栏展示：≥1000 用 k/M 缩写，<1000 走 fmtSpeed 的小数位规则。
 * 不能直接用 fmtTokens——它对 <1000 的值是 String(v)，会把 50.47336942755826 原样吐出来。
 */
export function fmtRate(n: number | null | undefined): string {
  const v = n ?? 0;
  if (!isFinite(v)) return "-";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return fmtSpeed(v);
}

/**
 * 缓存命中率 = 缓存读 ÷ 总 prompt。
 * `input` 是统一表的 input_tokens：已含缓存读，但不含 cache_creation（计价口径），
 * 所以分母要加回 cacheWrite：read / (input + write)。
 * 总 prompt 为 0 时显示 "-"。
 */
export function fmtHitRate(cacheRead: number, input: number, cacheWrite = 0): string {
  const total = input + Math.max(cacheWrite, 0);
  if (total <= 0) return "-";
  return `${((cacheRead / total) * 100).toFixed(1)}%`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 趋势图分桶键 → 展示标签 */
export function fmtBucket(bucket: string): string {
  // "2026-08-21T14:00:00"(小时)或 "2026-08-21"(天)
  const m = bucket.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):00:00)?$/);
  if (!m) return bucket;
  const md = `${m[2]}-${m[3]}`;
  return m[4] != null ? `${md} ${m[4]}:00` : md;
}

export function fmtTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
