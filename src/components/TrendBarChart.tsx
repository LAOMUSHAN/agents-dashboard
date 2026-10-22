import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtBucket, fmtCostRaw, fmtShare, fmtSpeed, fmtTokens } from "../format";
import { useChartPalette } from "../hooks/useChartPalette";
import { Panel } from "./ui/panel";
import { Segmented } from "./ui/segmented";
import { ChartTip } from "./ui/chart-tip";

type Metric = "tokens" | "cost" | "speed" | "decodeSpeed";
export type TrendValue = {
  tokens: number;
  cost: number;
  tokensPerSec: number | null;
  decodeTokensPerSec: number | null;
};
export type TrendDatum = { bucket: string; values: Record<string, TrendValue> };

const TOP_N = 8;
const OTHER = "其他";
const METRICS: { value: Metric; label: string }[] = [
  { value: "tokens", label: "Token" },
  { value: "cost", label: "费用" },
  { value: "speed", label: "总速度" },
  { value: "decodeSpeed", label: "解码速度" },
];

function colorOf(palette: ReturnType<typeof useChartPalette>, name: string, i: number): string {
  // 灰色固定给"其他";其余系列按稳定序号循环取色
  if (name === OTHER) return palette.series[palette.series.length - 1];
  return palette.series[i % (palette.series.length - 1)];
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/** 小时桶显示 "10-23 14:00–15:00";日桶显示 "10-18" */
function fmtBucketRange(bucket: string): string {
  const label = fmtBucket(bucket);
  const m = bucket.match(/T(\d{2}):00:00$/);
  if (!m) return label;
  const end = String(Number(m[1]) + 1).padStart(2, "0");
  return `${label}–${end}:00`;
}

type Hover =
  | { kind: "segment"; bucket: string; name: string; value: number; color: string; x: number; y: number }
  | { kind: "axis"; bucket: string; x: number; y: number };

function SegmentBar({ x, y, width, height, fill, name, bucket, value, onHover, onLeave }: any) {
  if (!(height > 0)) return null;
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      fill={fill}
      rx={1.5}
      onMouseEnter={(e) => onHover(e, { bucket, name, value, color: fill })}
      onMouseLeave={onLeave}
    />
  );
}

export function TrendBarChart({
  title,
  points,
  nameOf,
}: {
  title: string;
  points: TrendDatum[];
  nameOf: (name: string) => string;
}) {
  const palette = useChartPalette();
  const [metric, setMetric] = useState<Metric>("tokens");
  const [hover, setHover] = useState<Hover | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const isBar = metric === "tokens" || metric === "cost";

  // 按区间内总 token 选前 TOP_N 个系列,其余合并为"其他";
  // 只在一个时间桶出现的系列即使排不进 TOP_N 也单独保留。
  const seriesInfo = useMemo(() => {
    const totals = new Map<string, number>();
    const activeBuckets = new Map<string, number>();
    let grand = 0;
    for (const p of points) {
      for (const [name, v] of Object.entries(p.values)) {
        totals.set(name, (totals.get(name) ?? 0) + v.tokens);
        if (v.tokens > 0) activeBuckets.set(name, (activeBuckets.get(name) ?? 0) + 1);
        grand += v.tokens;
      }
    }
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const topN = sorted.slice(0, TOP_N);
    const singles = sorted.slice(TOP_N).filter((name) => (activeBuckets.get(name) ?? 0) === 1);
    const list = [...topN, ...singles];
    if (sorted.length > list.length) list.push(OTHER);
    const rest = grand - list.filter((name) => name !== OTHER).reduce((s, name) => s + (totals.get(name) ?? 0), 0);
    return { list, totals, grand, rest };
  }, [points]);
  const series = seriesInfo.list;
  const topSet = useMemo(() => new Set(series.filter((name) => name !== OTHER)), [series]);
  const colorIndex = useMemo(() => new Map(series.map((name, i) => [name, i])), [series]);

  const keyOf = (name: string) => (topSet.has(name) ? name : series.includes(OTHER) ? OTHER : null);

  const data = useMemo(() => {
    return points.map((p) => {
      const row: Record<string, number | null | string> = { bucket: p.bucket, label: fmtBucket(p.bucket) };
      // 数量模式堆叠必须补 0;速度模式缺失桶用 null 让折线断开
      for (const name of series) row[name] = isBar ? 0 : null;
      for (const [name, v] of Object.entries(p.values)) {
        const key = keyOf(name);
        if (key == null) continue;
        if (!isBar) {
          // "其他"是多个系列合并,无法加权出速度,不参与速度图
          if (key === OTHER) continue;
          row[key] = metric === "speed" ? v.tokensPerSec : v.decodeTokensPerSec;
        } else {
          row[key] = (row[key] as number) + v[metric];
        }
      }
      return row;
    });
  }, [points, series, metric, isBar, topSet]);

  // 柱状图从下往上堆叠;把所选口径下总量更大的系列排在下面
  const stackOrder = useMemo(() => {
    if (!isBar) return series;
    const totals = new Map<string, number>();
    for (const p of points) {
      for (const [name, v] of Object.entries(p.values)) {
        const key = keyOf(name);
        if (key == null) continue;
        totals.set(key, (totals.get(key) ?? 0) + v[metric]);
      }
    }
    return [...series].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  }, [series, points, metric, isBar, topSet]);

  const hourly = String(data[0]?.bucket ?? "").includes("T");
  const fmtV = metric === "cost" ? fmtCostRaw : metric === "tokens" ? fmtTokens : fmtSpeed;
  const singleVal = (key: string) => data.filter((r: any) => r[key] != null).length === 1;
  const dotOf = (color: string, key: string, single: boolean): ((p: any) => any) => (p: any) => {
    const v = p.payload?.[key];
    return single && v != null ? <circle key={p.index} cx={p.cx} cy={p.cy} r={3} fill={color} stroke="none" /> : null;
  };

  useEffect(() => {
    setHover(null);
  }, [points, metric]);

  const colorOfName = (name: string) => colorOf(palette, name, colorIndex.get(name) ?? 0);

  const positionOf = (e: ReactMouseEvent, cardH: number) => {
    const rect = chartRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return {
      x: clamp(x + 12, 8, Math.max(8, rect.width - 260)),
      y: clamp(y - cardH, 8, Math.max(8, rect.height - cardH)),
    };
  };

  const onSegmentHover = (
    e: ReactMouseEvent,
    info: { bucket: string; name: string; value: number; color: string },
  ) => {
    const pos = positionOf(e, 64);
    if (pos) setHover({ kind: "segment", ...info, ...pos });
  };

  const onAxisHover = (e: ReactMouseEvent, bucket: string) => {
    const pos = positionOf(e, 220);
    if (pos) setHover({ kind: "axis", bucket, ...pos });
  };

  const onLeave = () => setHover(null);
  const changeMetric = (next: Metric) => {
    setMetric(next);
    setHover(null);
  };

  // X 轴刻度:悬浮日期/小时时展示该桶所有系列;用透明矩形扩大命中区
  const AxisTick = (props: any) => {
    const { x, y, payload } = props;
    const row =
      data.find((d) => d.label === payload?.value) ??
      (payload?.index != null ? data[payload.index] : undefined);
    const bucket = typeof row?.bucket === "string" ? row.bucket : undefined;
    return (
      <g onMouseEnter={(e) => bucket && onAxisHover(e, bucket)} onMouseLeave={onLeave}>
        <rect x={x - 18} y={y - 2} width={36} height={20} fill="transparent" />
        <text x={x} y={y} dy={12} textAnchor="middle" fill={palette.tick} fontSize={10.5}>
          {payload?.value}
        </text>
      </g>
    );
  };

  const axisRow = hover?.kind === "axis" ? data.find((d) => d.bucket === hover.bucket) : null;
  const axisRows =
    hover?.kind === "axis"
      ? stackOrder
          .map((name) => ({ name, value: Number(axisRow?.[name] ?? 0), color: colorOfName(name) }))
          .filter((r) => r.value > 0)
          .sort((a, b) => b.value - a.value)
          .map((r) => ({ key: r.name, color: r.color, name: nameOf(r.name), value: fmtV(r.value) }))
      : [];
  const axisTotal =
    hover?.kind === "axis" && axisRows.length > 1
      ? fmtV(stackOrder.reduce((sum, name) => sum + Number(axisRow?.[name] ?? 0), 0))
      : undefined;

  return (
    <Panel
      title={title}
      sub={`${hourly ? "按小时" : "按天"} · ${isBar ? "堆叠柱" : "折线"}`}
      actions={<Segmented value={metric} options={METRICS} onChange={changeMetric} />}
    >
      {series.length === 0 ? (
        <div className="px-2 py-8 text-center text-[13px] text-muted-foreground">暂无数据</div>
      ) : (
        <>
          <div ref={chartRef} className="relative" onMouseLeave={onLeave}>
            <ResponsiveContainer width="100%" height={320} className="px-1 pb-2">
              <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={palette.grid} strokeDasharray="2 8" strokeOpacity={0.55} vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={
                    isBar
                      ? (props: any) => <AxisTick {...props} />
                      : { fill: palette.tick, fontSize: 10.5 }
                  }
                  tickLine={false}
                  axisLine={{ stroke: palette.grid }}
                  minTickGap={24}
                />
                <YAxis
                  tickFormatter={(v) => fmtV(v)}
                  tick={{ fill: palette.tick, fontSize: 10.5 }}
                  tickLine={false}
                  axisLine={false}
                  width={metric === "speed" || metric === "decodeSpeed" ? 70 : 56}
                />
                {!isBar && (
                  <Tooltip
                    cursor={{ stroke: palette.tick, strokeDasharray: "4 4" }}
                    content={({ active, payload, label }) => {
                      const rows = (payload ?? [])
                        .filter((p: any) => p.value != null)
                        .sort((a: any, b: any) => b.value - a.value)
                        .map((p: any) => ({
                          key: p.name,
                          color: p.stroke ?? p.color ?? p.fill,
                          name: p.name,
                          value: fmtV(p.value),
                        }));
                      return <ChartTip active={active} label={label} rows={rows} />;
                    }}
                  />
                )}
                {isBar
                  ? stackOrder.map((name) => (
                      <Bar
                        key={name}
                        stackId="trend"
                        dataKey={(row: any) => row[name]}
                        name={nameOf(name)}
                        fill={colorOfName(name)}
                        fillOpacity={0.92}
                        isAnimationActive={false}
                        maxBarSize={hourly ? 26 : 44}
                        shape={(props: any) => (
                          <SegmentBar
                            {...props}
                            fill={colorOfName(name)}
                            name={nameOf(name)}
                            bucket={props.payload?.bucket}
                            value={Number(props.payload?.[name] ?? 0)}
                            onHover={onSegmentHover}
                            onLeave={onLeave}
                          />
                        )}
                      />
                    ))
                  : series.map((name) => {
                      // 速度是各系列独立值,用折线展示(null 断开),不做堆叠
                      if (name === OTHER) return null;
                      const color = colorOfName(name);
                      return (
                        <Line
                          key={name}
                          type="monotone"
                          dataKey={(row: any) => row[name]}
                          name={nameOf(name)}
                          stroke={color}
                          strokeWidth={1.5}
                          dot={dotOf(color, name, singleVal(name))}
                          isAnimationActive={false}
                        />
                      );
                    })}
              </ComposedChart>
            </ResponsiveContainer>

            {isBar && hover && (
              <div className="pointer-events-none absolute z-30" style={{ left: hover.x, top: hover.y }}>
                {hover.kind === "segment" ? (
                  <div className="max-w-[260px] rounded-lg border border-border bg-popover/95 px-3 py-2 shadow-lg backdrop-blur-sm">
                    <div className="text-[10.5px] text-muted-foreground">{fmtBucketRange(hover.bucket)}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs">
                      <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: hover.color }} />
                      <span className="min-w-0 break-words text-muted-foreground">{hover.name}</span>
                      <span className="ml-auto pl-3 font-medium tabular-nums text-foreground">{fmtV(hover.value)}</span>
                    </div>
                  </div>
                ) : (
                  <ChartTip
                    active
                    label={fmtBucketRange(hover.bucket)}
                    rows={axisRows}
                    total={axisTotal}
                  />
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3 text-xs text-muted-foreground">
            {stackOrder.map((name) => {
              if (!isBar && name === OTHER) return null;
              const share = name === OTHER ? seriesInfo.rest : seriesInfo.totals.get(name) ?? 0;
              return (
                <span className="inline-flex items-center gap-1.5" key={name} title={name}>
                  <span className="size-2 rounded-full" style={{ background: colorOfName(name) }} />
                  {nameOf(name)}
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
