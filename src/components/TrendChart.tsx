import { useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MonthPoint, TrendPoint } from "../../shared/types";
import { fmtBucket, fmtCostRaw, fmtSpeed, fmtTokens } from "../format";
import { useChartPalette } from "../hooks/useChartPalette";
import { Panel } from "./ui/panel";
import { ChartTip } from "./ui/chart-tip";
import { cn } from "@/lib/utils";

const SERIES = [
  { key: "inputTokens", name: "输入(含缓存读)" },
  { key: "outputTokens", name: "输出" },
  { key: "cacheCreateTokens", name: "缓存写" },
] as const;

type View = "tokens" | "speed" | "decodeSpeed";
type Grain = "default" | "month";

const SEG = [
  { value: "tokens", label: "Token" },
  { value: "speed", label: "总速度" },
  { value: "decodeSpeed", label: "解码速度" },
] as const;

const GRAIN_SEG = [
  { value: "default", label: "自动" },
  { value: "month", label: "月" },
] as const;

export function TrendChart({ points, monthly }: { points: TrendPoint[]; monthly?: MonthPoint[] }) {
  const palette = useChartPalette();
  const [view, setView] = useState<View>("tokens");
  const [grain, setGrain] = useState<Grain>("default");

  // 月视图数据:MonthPoint 与 TrendPoint 字段兼容,补 label 即可
  const monthlyData = useMemo(
    () => (monthly ?? []).map((m) => ({ ...m, label: m.bucket })),
    [monthly],
  );

  // 月视图图例注解:峰值月份与环比
  const monthlyNote = useMemo(() => {
    const rows = monthly ?? [];
    if (rows.length === 0) return null;
    const peak = rows.reduce((a, b) => (b.outputTokens > a.outputTokens ? b : a));
    let mom: number | null = null;
    if (rows.length >= 2) {
      const last = rows[rows.length - 1];
      const prev = rows[rows.length - 2];
      if (prev.outputTokens > 0) mom = ((last.outputTokens - prev.outputTokens) / prev.outputTokens) * 100;
    }
    return { peak, mom };
  }, [monthly]);

  const isMonth = grain === "month" && monthlyData.length > 0;
  const data = isMonth
    ? monthlyData
    : points.map((p) => ({ ...p, label: fmtBucket(p.bucket) }));
  const hourly = !isMonth && (data[0]?.bucket.includes("T") ?? false);
  // 全零序列(如缓存写历史恒为 0)不渲染,避免在堆叠顶部产生误导性描边
  const visibleSeries = SERIES.filter((s) => data.some((d) => d[s.key]));
  // 有值点只有一个时连不成线,绘制同色圆点兜底,避免"有数据却看不到"
  // dot 用函数:零值点不画(对象形态会让整条序列的所有点都出点)
  const singleAny = (key: string) => data.filter((d: any) => d[key] != null).length === 1;
  const singleVal = (key: string) => data.filter((d: any) => d[key] > 0).length === 1;
  // 堆叠面积的点值 entry.value 是 [底,顶] 数组,不能直接比较;payload 里才是原始行值
  const dotOf = (color: string, key: string, single: boolean): ((p: any) => any) => (p: any) => {
    const v = p.payload?.[key];
    return single && (view === "tokens" ? v > 0 : v != null) ? (
      <circle key={p.index} cx={p.cx} cy={p.cy} r={3} fill={color} stroke="none" />
    ) : null;
  };
  const speedKey = view === "speed" ? "tokensPerSec" : "decodeTokensPerSec";
  const speedName = view === "speed" ? "总速度" : "解码速度";

  return (
    <Panel
      title={
        <>
          用量趋势
          <span className="ml-1.5 font-normal text-muted-foreground">
            {isMonth ? "按月" : hourly ? "按小时" : "按天"}
          </span>
        </>
      }
      actions={
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
            {GRAIN_SEG.map((g) => (
              <button
                key={g.value}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  grain === g.value
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setGrain(g.value)}
                title={g.value === "month" ? "按月聚合" : "跨度 ≤24h 按小时,否则按天"}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
            {SEG.map((s) => (
              <button
                key={s.value}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  view === s.value
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setView(s.value)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {view !== "tokens" ? (
        <>
          <ResponsiveContainer width="100%" height={320} className="px-1 pb-2">
            <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: palette.tick, fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: palette.grid }}
                minTickGap={24}
              />
              <YAxis
                yAxisId="speed"
                tickFormatter={(v) => fmtSpeed(v)}
                tick={{ fill: palette.tick, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={64}
              />
              <Tooltip
                cursor={{ stroke: palette.tick, strokeDasharray: "4 4" }}
                content={({ active, payload, label }) => (
                  <ChartTip
                    active={active}
                    label={label}
                    rows={(payload ?? []).map((p: any) => ({
                      key: p.dataKey,
                      color: p.stroke ?? p.color,
                      name: p.name,
                      value: fmtSpeed(p.value),
                    }))}
                  />
                )}
              />
              <Line
                yAxisId="speed"
                type="monotone"
                dataKey={speedKey}
                name={speedName}
                stroke={palette.series[0]}
                strokeWidth={1.5}
                dot={dotOf(palette.series[0], speedKey, singleAny(speedKey))}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap items-center gap-4 px-4 pb-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: palette.series[0] }} />
              {speedName}
            </span>
            {isMonth && monthlyNote && (
              <>
                <span>
                  峰值月份 <span className="font-medium text-foreground">{monthlyNote.peak.bucket}</span>（输出 {fmtTokens(monthlyNote.peak.outputTokens)}）
                </span>
                {monthlyNote.mom != null && (
                  <span>
                    环比 <span className={cn("font-medium tabular-nums", monthlyNote.mom >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                      {monthlyNote.mom >= 0 ? "+" : ""}{monthlyNote.mom.toFixed(1)}%
                    </span>
                  </span>
                )}
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={320} className="px-1 pb-2">
            <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: palette.tick, fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: palette.grid }}
                minTickGap={24}
              />
              <YAxis
                yAxisId="tokens"
                tickFormatter={(v) => fmtTokens(v)}
                tick={{ fill: palette.tick, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={52}
              />
              <YAxis
                yAxisId="cost"
                orientation="right"
                // 按数值绘制:不做币种折算(内部值即美元口径的原值)
                tickFormatter={(v) => fmtCostRaw(v)}
                tick={{ fill: palette.cost, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={52}
              />
              <Tooltip
                cursor={{ stroke: palette.tick, strokeDasharray: "4 4" }}
                content={({ active, payload, label }) => {
                  const rows = (payload ?? []).map((p: any) => ({
                    key: p.dataKey,
                    color: p.stroke ?? p.fill ?? p.color,
                    name: p.name,
                    value:
                      p.dataKey === "cost"
                        ? fmtCostRaw(p.value)
                        : fmtTokens(p.value),
                  }));
                  // 总 token = 输入 + 输出(与 zcode provider_total_tokens 口径一致)
                  const hasTokens = (payload ?? []).some(
                    (p: any) => p.dataKey === "inputTokens" || p.dataKey === "outputTokens",
                  );
                  const total = (payload ?? []).reduce(
                    (s: number, p: any) =>
                      p.dataKey === "inputTokens" || p.dataKey === "outputTokens" ? s + (p.value ?? 0) : s,
                    0,
                  );
                  return (
                    <ChartTip
                      active={active}
                      label={label}
                      rows={rows}
                      total={hasTokens ? fmtTokens(total) : undefined}
                      totalLabel="总 token"
                    />
                  );
                }}
              />
              {visibleSeries.map((s, i) => (
                  <Area
                    key={s.key}
                    yAxisId="tokens"
                    stackId="trend"
                    type="monotone"
                    dataKey={s.key}
                    name={s.name}
                    stroke={palette.series[i]}
                    strokeWidth={1.5}
                    fill={palette.series[i]}
                    fillOpacity={palette.areaOpacity}
                    dot={dotOf(palette.series[i], s.key, singleVal(s.key))}
                    isAnimationActive={false}
                  />
                ))}
              <Line
                yAxisId="cost"
                type="monotone"
                dataKey="cost"
                name="费用"
                stroke={palette.cost}
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={dotOf(palette.cost, "cost", singleVal("cost"))}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap items-center gap-4 px-4 pb-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              总 token
              <span className="tabular-nums">
                {fmtTokens(data.reduce((s, d) => s + d.inputTokens + d.outputTokens, 0))}
              </span>
            </span>
            {visibleSeries.map((s, i) => (
              <span key={s.key} className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: palette.series[i] }} />
                {s.name}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: palette.cost }} />
              费用
            </span>
            {isMonth && monthlyNote && (
              <>
                <span>
                  峰值月份 <span className="font-medium text-foreground">{monthlyNote.peak.bucket}</span>（输出 {fmtTokens(monthlyNote.peak.outputTokens)}）
                </span>
                {monthlyNote.mom != null && (
                  <span>
                    环比 <span className={cn("font-medium tabular-nums", monthlyNote.mom >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                      {monthlyNote.mom >= 0 ? "+" : ""}{monthlyNote.mom.toFixed(1)}%
                    </span>
                  </span>
                )}
              </>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
