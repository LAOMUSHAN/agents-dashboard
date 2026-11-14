import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { Summary, TrendPoint } from "../../shared/types";
import { costSplitCandidates, fmtHitRate, fmtSpeed, fmtTokens } from "../format";
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
  /** 按可用宽度挑选的候选显示串（小数位从多到少）；有则用真实探针测量后取值 */
  candidates?: string[];
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/**
 * 数值行的可用宽度 → 从候选中挑「放得下且小数位最多」的串。
 *
 * 性能约束（侧栏展开/收起有 200ms 宽度动画，逐帧触发 ResizeObserver）：
 * - 探针只创建一次并复用，不在每帧 append/remove DOM；
 * - 回调按 rAF 合并，同一帧内 RO + window.resize 只测一次；
 * - 卡片宽度未变（±1px）直接跳过，不做 getBoundingClientRect 强制同步布局；
 * - 只有选中的串变化才 setState，避免无谓重渲染。
 * 探针挂在视口外、与数值同字体同字号：不占位、不产生根滚动条。
 */
function useFittedValue(candidates: string[] | undefined, fallback: string) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(fallback);
  // 用内容做依赖：父组件每 30 秒刷新会重建候选数组，引用不稳会导致重复挂载 RO。
  const listRef = useRef(candidates);
  listRef.current = candidates;
  const key = candidates?.join("\u0001") ?? "";

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || list.length === 0) {
      setValue(fallback);
      return;
    }
    const card = cardRef.current;
    if (!card) return;

    const probe = document.createElement("span");
    probe.className = "text-[26px] leading-none font-semibold tracking-tight tabular-nums";
    probe.style.cssText =
      "position:fixed;left:-9999px;top:0;white-space:nowrap;visibility:hidden;pointer-events:none;";
    document.body.appendChild(probe);

    const shortest = list.reduce((a, b) => (b.length < a.length ? b : a), list[0]);
    let lastWidth = -1;
    let lastMeasureAt = 0;
    let throttleTimer = 0;
    let settleTimer = 0;

    const measure = () => {
      lastMeasureAt = Date.now();
      // 数值行左右各 px-4(16px)；unit（如 tok/s）与 gap 预留约 44px
      const available = Math.max(80, card.clientWidth - 32 - (card.dataset.hasUnit === "1" ? 44 : 0));
      if (Math.abs(available - lastWidth) < 1) return;
      lastWidth = available;
      let chosen = shortest;
      for (const c of list) {
        probe.textContent = c;
        if (probe.getBoundingClientRect().width <= available) {
          chosen = c;
          break;
        }
      }
      setValue((prev) => (prev === chosen ? prev : chosen));
    };

    /**
     * 侧栏展开是 200ms 宽度动画，ResizeObserver 逐帧触发。
     * 连续变化期间最多每 80ms 测一次；停止变化 120ms 后补一次最终测量，
     * 保证动画结束落在正确档位。用 setTimeout 而非 rAF：WebView2 失焦时
     * rAF 会被节流停摆，收尾补测必须可靠触发。
     */
    const schedule = () => {
      clearTimeout(settleTimer);
      settleTimer = window.setTimeout(measure, 120);
      const wait = Math.max(0, 80 - (Date.now() - lastMeasureAt));
      if (!throttleTimer) {
        throttleTimer = window.setTimeout(() => {
          throttleTimer = 0;
          measure();
        }, wait);
      }
    };

    measure();
    // 字体加载完成后再测一次：首屏跑在 webfont 应用之前，探针宽度偏小会误判。
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (cancelled) return;
      lastWidth = -1;
      measure();
    });
    const ro = new ResizeObserver(schedule);
    ro.observe(card);
    window.addEventListener("resize", schedule);
    return () => {
      cancelled = true;
      clearTimeout(throttleTimer);
      clearTimeout(settleTimer);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      probe.remove();
    };
  }, [key, fallback]);

  return { cardRef, value };
}

function KpiCard({ item }: { item: Kpi }) {
  const values = item.series.filter((v) => Number.isFinite(v));
  const n = values.length;
  const cut = Math.floor(n / 2);
  const prev = n >= 2 ? (item.avg ? mean(values.slice(0, cut)) : sum(values.slice(0, cut))) : 0;
  const cur = n >= 2 ? (item.avg ? mean(values.slice(cut)) : sum(values.slice(cut))) : 0;
  const { cardRef, value } = useFittedValue(item.candidates, item.value);
  const display = item.candidates ? value : item.value;

  return (
    <div
      ref={cardRef}
      data-has-unit={item.unit && display !== "-" ? "1" : undefined}
      className="group relative overflow-hidden rounded-panel bg-card px-4 pt-3 pb-2.5 shadow-panel transition-shadow hover:shadow-panel-hover"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10.5px] font-medium tracking-[0.09em] text-muted-foreground uppercase">
          {item.label}
        </div>
        <Delta current={cur} previous={prev} mode={item.mode} good={item.good} />
      </div>

      <div className="mt-1.5 flex items-baseline gap-1">
        <span
          data-kpi-value={item.label}
          className="text-[26px] leading-none font-semibold tracking-tight tabular-nums"
        >
          {display}
        </span>
        {item.unit && display !== "-" && (
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
  capabilities = [],
  source = "all",
}: {
  summary: Summary | null;
  trend?: TrendPoint[];
  /** 聚合范围下不完整的指标（如 DSH 不提供 reasoning tokens） */
  capabilities?: string[];
  /** 当前数据源范围；用于把「仅 zcode」与「部分来源未提供」说清楚 */
  source?: "all" | "zcode" | "dsh" | "claude";
}) {
  const [more, setMore] = useState(false);
  // 费用候选按精度排好序；首个就是 8 位以上场景的缩写串，用作探针测量前的首屏兜底，
  // 避免先闪一下完整长串再收缩。summary 变化时重算。
  const costCandidates = useMemo(
    () => (summary ? costSplitCandidates(summary.costUsd, summary.costCny) : ["$0.00"]),
    [summary?.costUsd, summary?.costCny],
  );
  const partialReasoning = capabilities.includes("reasoningTokens");
  const partialCacheWrite = capabilities.includes("cacheCreateTokens");
  const partialDecode = capabilities.includes("decodeSpeed");
  const partialNote =
    source === "dsh"
      ? "（DSH 未提供）"
      : source === "claude"
        ? "（Claude 未提供）"
        : source === "all"
          ? "（部分来源未提供）"
          : "（仅 zcode）";

  const series = {
    tokens: trend.map((p) => p.inputTokens + p.outputTokens),
    cost: trend.map((p) => p.cost),
    hit: trend.map((p) => {
      const total = p.inputTokens + p.cacheCreateTokens;
      return total > 0 ? p.cacheReadTokens / total : 0;
    }),
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
          value: costCandidates[0] ?? "$0.00",
          candidates: costCandidates,
          hint: summary.unpricedModels.length > 0 ? `${summary.unpricedModels.length} 个模型未配置单价` : "逐请求计价 · 含峰谷",
          warn: summary.unpricedModels.length > 0,
          series: series.cost,
          mode: "pct",
        },
        {
          label: "缓存命中率",
          value: fmtHitRate(
            summary.cacheReadTokens,
            summary.inputTokens,
            summary.cacheCreateTokens,
          ),
          hint: "缓存读 ÷ 总 prompt（含缓存写）",
          series: series.hit,
          mode: "pp",
          avg: true,
          good: "up",
        },
        {
          label: "解码速度",
          value: fmtSpeed(summary.decodeTokensPerSec),
          unit: "tok/s",
          hint: partialDecode
            ? "输出 ÷ (LLM 耗时 − 首 token) · 仅含有流式时间戳的请求"
            : "输出 ÷ (LLM 耗时 − 首 token)",
          series: series.decode,
          mode: "pct",
          avg: true,
          good: "up",
        },
        {
          label: "缓存读",
          value: fmtTokens(summary.cacheReadTokens),
          hint: `缓存写 ${fmtTokens(summary.cacheCreateTokens)}${partialCacheWrite ? partialNote : ""}`,
          series: series.cacheRead,
          mode: "pct",
        },
        {
          label: "输入 tokens",
          value: fmtTokens(summary.inputTokens),
          hint: `含推理 ${fmtTokens(summary.reasoningTokens)}${partialReasoning ? partialNote : ""}`,
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

