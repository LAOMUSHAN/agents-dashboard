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

/**
 * 货币展示配置:后端所有金额一律以美元计算与存储,这里只负责折成展示币种并加符号。
 * 展示币种不再是独立选项,而是由价格表的币种推导(见 deriveDisplayCurrency)。
 * rate 是"展示折算系数"(展示美元时恒为 1),usdCny 保存汇率本身——双币种展示需要它
 */
let money = { symbol: "$", rate: 1, usdCny: 7.1 };

export function setMoneyConfig(displayCurrency: string, usdCnyRate: number) {
  const cny = displayCurrency?.toLowerCase() === "cny";
  const fx = usdCnyRate > 0 && isFinite(usdCnyRate) ? usdCnyRate : 7.1;
  money = {
    symbol: cny ? "¥" : "$",
    rate: cny ? fx : 1,
    usdCny: fx,
  };
}

/**
 * 展示币种由价格表推导:所有"已填价"(输入或输出不为 0)的模型都标了人民币价时
 * 按人民币展示,否则按美元。价格表币种变了,展示单位跟着变
 */
type PriceLike = { input?: number; output?: number; currency?: string | null } | undefined;

export function deriveDisplayCurrency(models: Record<string, PriceLike>): "usd" | "cny" {
  const priced = Object.values(models).filter((e) => e && ((e.input ?? 0) > 0 || (e.output ?? 0) > 0));
  if (priced.length === 0) return "usd";
  return priced.every((e) => (e!.currency ?? "usd").toLowerCase() === "cny") ? "cny" : "usd";
}

/** 用一份定价配置设置展示币种与汇率 */
export function setMoneyConfigFromPricing(cfg: { usdCnyRate?: number; models?: Record<string, PriceLike> }) {
  setMoneyConfig(deriveDisplayCurrency(cfg.models ?? {}), cfg.usdCnyRate ?? 0);
}

/** 当前 1 美元折合的人民币数(汇率本身,与展示币种无关) */
export function moneyRate(): number {
  return money.usdCny;
}

/** 当前展示币种符号(图表坐标轴等直接拼字符串的场景用) */
export function moneySymbol(): string {
  return money.symbol;
}

/** 把美元金额折成展示币种的数值(不改符号) */
export function toDisplayMoney(usd: number | null | undefined): number {
  return (usd ?? 0) * money.rate;
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

/** 把美元口径金额按指定币种展示:价格估算列跟随该行自己的币种设置 */
export function fmtCostIn(usd: number | null | undefined, currency: string | null | undefined): string {
  return isCnyCurrency(currency) ? "¥" + amount((usd ?? 0) * money.usdCny) : "$" + amount(usd);
}

/** 展示一个已经是该币种的金额,不做任何换算(合计拆成"美元部分 · 人民币部分"时用) */
export function fmtAmount(amount_: number | null | undefined, currency: "usd" | "cny"): string {
  return (currency === "cny" ? "¥" : "$") + amount(amount_);
}

export function fmtCost(n: number | null | undefined): string {
  const v = toDisplayMoney(n);
  if (v !== 0 && Math.abs(v) < 0.01) return money.symbol + v.toFixed(4);
  return money.symbol + v.toFixed(2);
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
 * 缓存命中率 = 缓存读 ÷ 总输入。
 * zcode 的 input_tokens 为总 prompt tokens(已含缓存命中部分),
 * cacheRead 是其子集(OpenAI usage 口径),故分母不再叠加 cacheRead。
 * 总输入为 0 时显示 "-"。
 */
export function fmtHitRate(cacheRead: number, input: number): string {
  if (input <= 0) return "-";
  return `${((cacheRead / input) * 100).toFixed(1)}%`;
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
