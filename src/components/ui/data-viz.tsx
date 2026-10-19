import { cn } from "@/lib/utils";

/* ==========================================================================
   数据可视化原子：KPI 火花线、比例条、堆叠条、耗时瀑布、命中率药丸。
   颜色一律取 CDS 变量，明暗两套自动跟随。
   ========================================================================== */

/**
 * 长条长度换算：asinh 压缩。
 * - 小于 knee 的区间近似线性，短条之间仍可比较；
 * - 大于 knee 后接近对数，不会因为一个极大值把其他条压成一条线。
 * 返回 0..1，调用方乘 100 作为百分比宽度。
 */
export function barScale(value: number, max: number, knee?: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  // 拐点默认取最大值的 1%：小于它的区间近似线性，大于它的区间接近对数
  const k = Math.max(knee && knee > 0 ? knee : max / 100, 1e-9);
  return Math.min(1, Math.asinh(value / k) / Math.asinh(max / k));
}

/** 迷你趋势线：零基线面积 + 陶土描边，用于 KPI 卡右下角 */
export function Sparkline({
  values,
  className,
  height = 28,
}: {
  values: number[];
  className?: string;
  height?: number;
}) {
  if (values.length < 2) return null;
  const w = 100;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = height - 2 - (Math.max(v, 0) / max) * (height - 4);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = pts.join(" ");
  const area = `0,${height} ${line} ${w},${height}`;

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className={cn("block overflow-visible", className)}
      aria-hidden
    >
      <polygon points={area} fill="var(--cds-clay-soft)" />
      <polyline
        points={line}
        fill="none"
        stroke="var(--cds-clay)"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** 涨跌标记：series 前后两半对比，pct = 相对变化，pp = 百分点（命中率用）。
 *  good 决定颜色语义：up = 涨为好、down = 跌为好、none = 中性（量类指标）。 */
export function Delta({
  current,
  previous,
  mode = "pct",
  good = "none",
}: {
  current: number;
  previous: number;
  mode?: "pct" | "pp";
  good?: "up" | "down" | "none";
}) {
  if (!isFinite(current) || !isFinite(previous) || previous === 0) return null;
  const value = mode === "pct" ? ((current - previous) / previous) * 100 : (current - previous) * 100;
  if (!isFinite(value) || Math.abs(value) < 0.05) return null;
  const up = value > 0;
  const tone =
    good === "none"
      ? "bg-accent text-muted-foreground"
      : (up && good === "up") || (!up && good === "down")
        ? "bg-success/10 text-success"
        : "bg-danger/10 text-danger";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums",
        tone,
      )}
      title={mode === "pp" ? "与区间上半段相比的百分点变化" : "与区间上半段相比"}
    >
      {up ? "▲" : "▼"} {Math.abs(value).toFixed(1)}
      {mode === "pp" ? "pp" : "%"}
    </span>
  );
}

/** 细比例条：请求量 / 占比一类。knee 控制 asinh 压缩的拐点 */
export function MiniBar({
  value,
  max,
  knee,
  className,
  tone = "var(--cds-clay)",
}: {
  value: number;
  max: number;
  knee?: number;
  className?: string;
  tone?: string;
}) {
  const pct = barScale(value, max, knee) * 100;
  return (
    <div
      title="条形按 asinh 压缩，便于比较数量级差异"
      className={cn("h-1 w-full overflow-hidden rounded-full bg-accent/60", className)}
      aria-hidden
    >
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone }} />
    </div>
  );
}

/** 堆叠条：token 构成（缓存读 / 未命中输入 / 输出）。
 *  max + knee 存在时按 asinh 压缩缩放填充宽度，轨道保留满格作为参照。 */
export function StackBar({
  segments,
  className,
  max,
  knee,
}: {
  segments: { value: number; color: string }[];
  className?: string;
  max?: number;
  knee?: number;
}) {
  const total = segments.reduce((s, x) => s + Math.max(x.value, 0), 0);
  const fill = max && max > 0 ? barScale(total, max, knee) * 100 : 100;
  return (
    <div
      title="条形按 asinh 压缩，便于比较数量级差异"
      className={cn("h-1 overflow-hidden rounded-full bg-accent/60", className)}
      aria-hidden
    >
      <div className="flex h-full overflow-hidden rounded-full" style={{ width: `${fill}%` }}>
        {total > 0 &&
          segments.map((s, i) => (
            <div key={i} style={{ width: `${(Math.max(s.value, 0) / total) * 100}%`, background: s.color }} />
          ))}
      </div>
    </div>
  );
}

/** 耗时瀑布：首 token（陶土）+ 解码（暖灰）；外宽按 asinh 压缩，内部分段保持真实比例 */
export function Waterfall({
  durationMs,
  ttftMs,
  maxMs,
  knee,
  className,
}: {
  durationMs: number | null;
  ttftMs: number | null;
  maxMs: number;
  knee?: number;
  className?: string;
}) {
  const total = Math.max(durationMs ?? 0, 0);
  if (total <= 0) {
    return <div className={cn("h-1 w-full rounded-full bg-accent/60", className)} aria-hidden />;
  }
  const width = barScale(total, Math.max(maxMs, total, 1), knee) * 100;
  const ttft = Math.min(Math.max(ttftMs ?? 0, 0), total);
  const ttftPct = (ttft / total) * 100;

  return (
    <div
      title="条形按 asinh 压缩；陶土段为首 token，灰色段为解码"
      className={cn("h-1 w-full overflow-hidden rounded-full bg-accent/60", className)}
      aria-hidden
    >
      <div className="flex h-full overflow-hidden rounded-full" style={{ width: `${width}%` }}>
        <div style={{ width: `${ttftPct}%`, background: "var(--cds-clay)" }} />
        <div style={{ width: `${100 - ttftPct}%`, background: "var(--cds-gray-400)" }} />
      </div>
    </div>
  );
}

/** 命中率药丸：≥80% 绿、≥50% 琥珀、其余红；无输入时灰色占位 */
export function HitRatePill({ read, input }: { read: number; input: number }) {
  if (!input) return <span className="text-[11px] text-muted-foreground">—</span>;
  const rate = read / input;
  const tone =
    rate >= 0.8 ? "text-success bg-success/10" : rate >= 0.5 ? "text-warn bg-warn/10" : "text-danger bg-danger/10";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium tabular-nums",
        tone,
      )}
    >
      <span className="size-1 rounded-full bg-current opacity-70" />
      {(rate * 100).toFixed(1)}%
    </span>
  );
}


