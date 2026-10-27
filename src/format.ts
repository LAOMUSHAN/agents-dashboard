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
