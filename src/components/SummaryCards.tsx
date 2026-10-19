import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Summary, TrendPoint } from "../../shared/types";
import { fmtCostSplit, fmtHitRate, fmtSpeed, fmtTokens } from "../format";
import { Delta, Sparkline } from "./ui/data-viz";
import { cn } from "@/lib/utils";

type Kpi = {
  label: string;
  value: string;
  unit?: string;
  hint: string;
  warn?: boolean;
  series: number[];
  /** pct = 相对变化；pp = 百分点（命中率） */
  mode: "pct" | "pp";
  /** 涨跌颜色语义：up=涨为好，down=跌为好，none=中性 */
  good?: "up" | "down" | "none";
  /** 速率类指标用平均，量类用求和 */
  avg?: boolean;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

function KpiCard({ item }: { item: Kpi }) {
  const values = item.series.filter((v) => Number.isFinite(v));
  const n = values.length;
  const cut = Math.floor(n / 2);
  const prev = n >= 2 ? (item.avg ? mean(values.slice(0, cut)) : sum(values.slice(0, cut))) : 0;
  const cur = n >= 2 ? (item.avg ? mean(values.slice(cut)) : sum(values.slice(cut))) : 0;

  return (
    <div className="group relative overflow-hidden rounded-panel bg-card px-4 pt-3 pb-2.5 shadow-panel transition-shadow hover:shadow-panel-hover">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10.5px] font-medium tracking-[0.09em] text-muted-foreground uppercase">
          {item.label}
        </div>
        <Delta current={cur} previous={prev} mode={item.mode} good={item.good} />
      </div>

      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="text-[26px] leading-none font-semibold tracking-tight tabular-nums">
          {item.value}
        </span>
        {item.unit && item.value !== "-" && (
          <span className="text-[11px] font-medium text-muted-foreground">{item.unit}</span>
        )}
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <span
          className={cn(
            "min-w-0 truncate text-[11px]",
            item.warn ? "font-medium text-warn" : "text-muted-foreground/85",
          )}
        >
          {item.hint}
        </span>
        <Sparkline values={values} className="h-7 w-[88px] shrink-0 opacity-90" />
      </div>
    </div>
  );
}

export function SummaryCards({
  summary,
  trend = [],
}: {
  summary: Summary | null;
  trend?: TrendPoint[];
}) {
  const [more, setMore] = useState(false);

  const series = {
    tokens: trend.map((p) => p.inputTokens + p.outputTokens),
    cost: trend.map((p) => p.cost),
    hit: trend.map((p) => (p.inputTokens > 0 ? p.cacheReadTokens / p.inputTokens : 0)),
    decode: trend.map((p) => p.decodeTokensPerSec ?? 0),
    cacheRead: trend.map((p) => p.cacheReadTokens),
    input: trend.map((p) => p.inputTokens),
    output: trend.map((p) => p.outputTokens),
    speed: trend.map((p) => p.tokensPerSec ?? 0),
  };

  const all: Kpi[] = summary
    ? [
        {
          label: "总 tokens",
          value: fmtTokens(summary.inputTokens + summary.outputTokens),
          hint: `缓存读 ${fmtTokens(summary.cacheReadTokens)}`,
          series: series.tokens,
          mode: "pct",
        },
        {
          label: "估算费用",
          value: fmtCostSplit(summary.costUsd, summary.costCny),
          hint: summary.unpricedModels.length > 0 ? `${summary.unpricedModels.length} 个模型未配置单价` : "逐请求计价 · 含峰谷",
          warn: summary.unpricedModels.length > 0,
          series: series.cost,
          mode: "pct",
        },
        {
          label: "缓存命中率",
          value: fmtHitRate(summary.cacheReadTokens, summary.inputTokens),
          hint: "缓存读 ÷ 总输入",
          series: series.hit,
          mode: "pp",
          avg: true,
          good: "up",
        },
        {
          label: "解码速度",
          value: fmtSpeed(summary.decodeTokensPerSec),
          unit: "tok/s",
          hint: "输出 ÷ (LLM 耗时 − 首 token)",
          series: series.decode,
          mode: "pct",
          avg: true,
          good: "up",
        },
        {
          label: "缓存读",
          value: fmtTokens(summary.cacheReadTokens),
          hint: `缓存写 ${fmtTokens(summary.cacheCreateTokens)}`,
          series: series.cacheRead,
          mode: "pct",
        },
        {
          label: "输入 tokens",
          value: fmtTokens(summary.inputTokens),
          hint: `含推理 ${fmtTokens(summary.reasoningTokens)}`,
          series: series.input,
          mode: "pct",
        },
        {
          label: "输出 tokens",
          value: fmtTokens(summary.outputTokens),
          hint: "含推理与工具调用",
          series: series.output,
          mode: "pct",
        },
        {
          label: "总速度",
          value: fmtSpeed(summary.tokensPerSec),
          unit: "tok/s",
          hint: "输出 ÷ LLM 耗时",
          series: series.speed,
          mode: "pct",
          avg: true,
          good: "up",
        },
      ]
    : Array.from({ length: 8 }, () => ({
        label: "",
        value: "…",
        hint: "",
        series: [],
        mode: "pct" as const,
      }));

  const primary = all.slice(0, 4);
  const secondary = all.slice(4);

  return (
    <section className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {primary.map((c, i) => (
          <KpiCard key={i} item={c} />
        ))}
      </div>

      <div className="flex justify-center">
        <button
          className="inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => setMore((v) => !v)}
          aria-expanded={more}
        >
          {more ? "收起指标" : "更多指标"}
          <ChevronDown size={12} className={cn("transition-transform", more && "rotate-180")} />
        </button>
      </div>

      {more && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {secondary.map((c, i) => (
            <KpiCard key={i} item={c} />
          ))}
        </div>
      )}
    </section>
  );
}

