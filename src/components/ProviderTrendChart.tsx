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
import type { ProviderTrendPoint } from "../../shared/types";
import { fmtBucket, fmtCostRaw, fmtShare, fmtSpeed, fmtTokens } from "../format";
import { useChartPalette } from "../hooks/useChartPalette";
import { Panel } from "./ui/panel";
import { ChartTip } from "./ui/chart-tip";
import { cn } from "@/lib/utils";

type Metric = "tokens" | "cost" | "speed" | "decodeSpeed";

/** 最多展示前 8 个供应商,其余合并为"其他" */
const TOP_N = 8;
const OTHER = "其他";

function colorOf(palette: ReturnType<typeof useChartPalette>, name: string, i: number): string {
  // 灰色固定给"其他";追加的单日系列按序号循环取色,避免与灰色混淆
  if (name === OTHER) return palette.series[palette.series.length - 1];
  return palette.series[i % (palette.series.length - 1)];
}

export function ProviderTrendChart({
  points,
  names,
}: {
  points: ProviderTrendPoint[];
  /** providerId -> 展示名(来自按供应商表格的数据) */
  names: Record<string, string>;
}) {
  const palette = useChartPalette();
  const [metric, setMetric] = useState<Metric>("tokens");

  // 按区间内总 token 排序,取前 TOP_N 个供应商,其余合并为"其他"
  // 区间内只用了 1 天的供应商即使排不进 TOP_N 也单独展出(单点显示圆点),不并入"其他"
  // 同时保留每个系列的 token 总计,供图例标注占比
  const seriesInfo = useMemo(() => {
    const totals = new Map<string, number>();
    const activeDays = new Map<string, number>();
    let grand = 0;
    for (const p of points) {
      for (const [id, v] of Object.entries(p.providers)) {
        totals.set(id, (totals.get(id) ?? 0) + v.tokens);
        if (v.tokens > 0) activeDays.set(id, (activeDays.get(id) ?? 0) + 1);
        grand += v.tokens;
      }
    }
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const topN = sorted.slice(0, TOP_N);
    const singles = sorted.slice(TOP_N).filter((id) => (activeDays.get(id) ?? 0) === 1);
    const list = [...topN, ...singles];
    if (sorted.length > list.length) list.push(OTHER);
    // "其他"的占比 = 总量减去各独立供应商
    const rest = grand - list.filter((s) => s !== OTHER).reduce((s, id) => s + (totals.get(id) ?? 0), 0);
    return { list, totals, grand, rest };
  }, [points]);
  const series = seriesInfo.list;

  const labelOf = (id: string) => names[id] ?? id;

  // dataKey 用函数取值,避免键被 Recharts 当成嵌套路径
  const data = useMemo(() => {
    const topSet = new Set(series.filter((s) => s !== OTHER));
    return points.map((p) => {
      const row: Record<string, number | null | string> = { bucket: p.bucket, label: fmtBucket(p.bucket) };
      // 速度模式下缺失的桶用 null,让折线在该处断开;数量模式堆叠必须补 0
      for (const id of series) row[id] = metric === "tokens" || metric === "cost" ? 0 : null;
      for (const [id, v] of Object.entries(p.providers)) {
        const key = topSet.has(id) ? id : series.includes(OTHER) ? OTHER : null;
        if (key == null) continue;
        if (metric === "speed" || metric === "decodeSpeed") {
          // "其他"是多个供应商的合并,无法加权出速度,不参与速度图
          if (key === OTHER) continue;
          row[key] = metric === "speed" ? v.tokensPerSec : v.decodeTokensPerSec;
        } else {
          row[key] = (row[key] as number) + v[metric];
        }
      }
      return row;
    });
  }, [points, series, metric]);

  const hourly = String(data[0]?.bucket ?? "").includes("T");
  // 费用按原值绘制,不做币种折算
  const fmt = metric === "cost" ? fmtCostRaw : metric === "tokens" ? fmtTokens : fmtSpeed;
  // 有值点只有一个时连不成线,绘制同色圆点兜底,避免"有数据却看不到"
  // dot 用函数:零值/空值点不画(对象形态会让整条序列的所有点都出点)
  const singleVal = (key: string) =>
    data.filter((r: any) => (metric === "tokens" || metric === "cost" ? r[key] > 0 : r[key] != null)).length === 1;
  // 堆叠面积的点值 entry.value 是 [底,顶] 数组,不能直接比较;payload 里才是原始行值
  const dotOf = (color: string, key: string, single: boolean): ((p: any) => any) => (p: any) => {
    const v = p.payload?.[key];
    return single && (metric === "tokens" || metric === "cost" ? v > 0 : v != null) ? (
      <circle key={p.index} cx={p.cx} cy={p.cy} r={3} fill={color} stroke="none" />
    ) : null;
  };

  const SEG: { value: Metric; label: string }[] = [
    { value: "tokens", label: "Token" },
    { value: "cost", label: "费用" },
    { value: "speed", label: "总速度" },
    { value: "decodeSpeed", label: "解码速度" },
  ];

  return (
    <Panel
      title="供应商用量趋势"
      sub={hourly ? "按小时 · 堆叠" : "按天 · 堆叠"}
      actions={
        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
          {SEG.map((s) => (
            <button
              key={s.value}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                metric === s.value
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setMetric(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
      }
    >
      {series.length === 0 ? (
        <div className="px-2 py-8 text-center text-[13px] text-muted-foreground">暂无数据</div>
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
                tickFormatter={(v) => fmt(v)}
                tick={{ fill: palette.tick, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={metric === "speed" || metric === "decodeSpeed" ? 70 : 56}
              />
              <Tooltip
                cursor={{ stroke: palette.tick, strokeDasharray: "4 4" }}
                content={({ active, payload, label }) => {
                  const fmtV = metric === "cost" ? fmtCostRaw : metric === "tokens" ? fmtTokens : fmtSpeed;
                  const rows = (payload ?? [])
                    .filter((p: any) => p.value > 0 || (metric !== "tokens" && metric !== "cost" && p.value != null))
                    .sort((a: any, b: any) => b.value - a.value)
                    .map((p: any) => ({
                      key: p.name,
                      color: p.stroke ?? p.color ?? p.fill,
                      name: labelOf(p.name) ?? p.name,
                      value: fmtV(p.value),
                    }));
                  const total = rows.reduce((acc: number, r: any) => acc + Number(r.value), 0);
                  return (
                    <ChartTip
                      active={active}
                      label={label}
                      rows={rows}
                      total={rows.length > 1 && (metric === "tokens" || metric === "cost") ? fmtV(total) : undefined}
                    />
                  );
                }}
              />
              {series.map((id, i) =>
                metric === "speed" || metric === "decodeSpeed" ? (
                  // 速度是各供应商独立值,用折线展示(null 断开),不做堆叠
                  <Line
                    key={id}
                    type="monotone"
                    dataKey={(row: any) => row[id]}
                    name={labelOf(id)}
                    stroke={colorOf(palette, id, i)}
                    strokeWidth={1.5}
                    dot={dotOf(colorOf(palette, id, i), id, singleVal(id))}
                    isAnimationActive={false}
                  />
                ) : (
                  <Area
                    key={id}
                    stackId="providers"
                    type="monotone"
                    dataKey={(row: any) => row[id]}
                    name={labelOf(id)}
                    stroke={colorOf(palette, id, i)}
                    strokeWidth={1.5}
                    fill={colorOf(palette, id, i)}
                    fillOpacity={palette.areaOpacity}
                    dot={dotOf(colorOf(palette, id, i), id, singleVal(id))}
                    isAnimationActive={false}
                  />
                ),
              )}
            </ComposedChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3 text-xs text-muted-foreground">
            {series.map((id, i) => {
              // 速度模式下"其他"无数据,图例不展示
              if ((metric === "speed" || metric === "decodeSpeed") && id === OTHER) return null;
              const share =
                id === OTHER
                  ? seriesInfo.rest
                  : (seriesInfo.totals.get(id) ?? 0);
              return (
                <span className="inline-flex items-center gap-1.5" key={id} title={id}>
                  <span className="size-2 rounded-full" style={{ background: colorOf(palette, id, i) }} />
                  {labelOf(id)}
                  {metric === "tokens" && (
                    <span className="tabular-nums opacity-70">{fmtShare(share, seriesInfo.grand)}</span>
                  )}
                </span>
              );
            })}
          </div>
        </>
      )}
    </Panel>
  );
}
