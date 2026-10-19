import { useMemo, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import type { ModelStat, ProviderStat, Summary } from "../../shared/types";
import { fmtAmount, fmtCostSplit, fmtNumber, fmtPercent, fmtSpeed, fmtTokens } from "../format";
import { StatBadge } from "./ui/stat-badge";
import { cn } from "@/lib/utils";

type Insight = { text: string; tone?: "warn" | "info" };

export function InsightCard({
  summary,
  models,
  providers,
}: {
  summary: Summary | null;
  models: ModelStat[];
  providers: ProviderStat[];
}) {
  const insights = useMemo<Insight[]>(() => {
    const list: Insight[] = [];
    if (!summary) return list;
    const hit = summary.inputTokens > 0 ? summary.cacheReadTokens / summary.inputTokens : null;

    // 最活跃模型(按输出 tokens)
    const top = [...models].sort((a, b) => b.outputTokens - a.outputTokens)[0];
    if (top && top.outputTokens > 0) {
      list.push({
        text: `区间内最活跃模型是 ${top.modelId},输出 ${fmtTokens(top.outputTokens)} tokens,占全部输出的 ${fmtPercent(top.outputTokens, summary.outputTokens)}。`,
      });
    }

    // 缓存命中率提醒
    if (hit != null && hit < 0.7 && summary.inputTokens > 0) {
      list.push({
        text: `缓存命中率 ${fmtPercent(summary.cacheReadTokens, summary.inputTokens)},低于 70%。命中可按约 1/10 价格计费,请检查提示词前缀是否稳定。`,
        tone: "warn",
      });
    } else if (hit != null) {
      list.push({
        text: `缓存命中率 ${fmtPercent(summary.cacheReadTokens, summary.inputTokens)},命中部分按缓存读价计费,重复上下文的请求成本大幅降低。`,
      });
    }

    // 费用摘要:区间内可能混用两种定价,两侧各贴各的币种,不做折算后相加
    if (summary.cost > 0) {
      const n = summary.requests;
      list.push({
        text: `区间估算费用 ${fmtCostSplit(summary.costUsd, summary.costCny)},共 ${fmtNumber(n)} 次请求,平均单次 ${fmtCostSplit(
          n > 0 ? summary.costUsd / n : 0,
          n > 0 ? summary.costCny / n : 0,
        )}。`,
      });
    }

    // 解码最快模型
    const fastest = [...models]
      .filter((m) => m.decodeTokensPerSec != null)
      .sort((a, b) => (b.decodeTokensPerSec ?? 0) - (a.decodeTokensPerSec ?? 0))[0];
    if (fastest) {
      list.push({
        text: `解码速度最快的是 ${fastest.modelId},${fmtSpeed(fastest.decodeTokensPerSec)} tok/s(总速度 ${fmtSpeed(fastest.tokensPerSec)})。`,
      });
    }

    // 代理多样性
    if (providers.length > 1) {
      const top2 = [...providers].sort((a, b) => b.outputTokens - a.outputTokens);
      list.push({
        text: `使用了 ${providers.length} 个供应商,输出最多的是 ${top2[0].name}(${fmtTokens(top2[0].outputTokens)} tokens)。`,
      });
    }
    return list;
  }, [summary, models, providers]);

  const [idx, setIdx] = useState(0);
  if (!summary || insights.length === 0) return null;
  const active = idx % insights.length;
  const cur = insights[active];

  return (
    <section className="flex flex-col gap-3 rounded-panel bg-card px-4 py-3 shadow-panel sm:flex-row sm:items-center">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-clay-soft text-clay">
        <Sparkles size={15} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-relaxed">
          {cur.text}
          {cur.tone === "warn" && (
            <StatBadge tone="warn" className="ml-2">
              留意
            </StatBadge>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="tabular-nums">{fmtNumber(summary.requests)} 次请求</span>
          <span className="size-0.5 rounded-full bg-border" aria-hidden />
          <span className="tabular-nums">{fmtNumber(summary.sessions)} 个会话</span>
          {summary.cacheSavings > 0 && (
            <>
              <span className="size-0.5 rounded-full bg-border" aria-hidden />
              <span>
                缓存节省{" "}
                <span className="font-medium text-success tabular-nums">
                  ≈ {fmtAmount(summary.cacheSavingsCny, "cny")} · {fmtAmount(summary.cacheSavingsUsd, "usd")}
                </span>
              </span>
            </>
          )}
          {summary.unpricedModels.length > 0 && (
            <>
              <span className="size-0.5 rounded-full bg-border" aria-hidden />
              <span className="text-warn">{summary.unpricedModels.length} 个模型未计价</span>
            </>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="flex items-center gap-1" aria-hidden>
          {insights.map((_, i) => (
            <span
              key={i}
              className={cn(
                "size-1.5 rounded-full transition-colors",
                i === active ? "bg-clay" : "bg-border",
              )}
            />
          ))}
        </div>
        <button
          className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => setIdx((i) => i + 1)}
          title="换一条洞察"
        >
          <RefreshCw size={13} />
        </button>
      </div>
    </section>
  );
}
