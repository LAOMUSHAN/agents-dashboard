import type { Summary } from "../../shared/types";
import { fmtCostSplit, fmtHitRate, fmtSpeed, fmtTokens } from "../format";

type CardItem = {
  label: string;
  value: string;
  hint: string;
  warn?: boolean;
  /** 数字用 tabular-nums 大字号;文本型(费用/速度)用同字号等宽 */
  numeric?: boolean;
};

export function SummaryCards({ summary }: { summary: Summary | null }) {
  const cards: CardItem[] = summary
    ? [
        { label: "总 tokens", value: fmtTokens(summary.inputTokens + summary.outputTokens), hint: "", numeric: true },
        {
          label: "缓存读",
          value: fmtTokens(summary.cacheReadTokens),
          hint: `缓存写 ${fmtTokens(summary.cacheCreateTokens)}`,
          numeric: true,
        },
        { label: "输入 tokens", value: fmtTokens(summary.inputTokens), hint: `含推理 ${fmtTokens(summary.reasoningTokens)}`, numeric: true },
        { label: "输出 tokens", value: fmtTokens(summary.outputTokens), hint: "", numeric: true },
        { label: "总速度", value: fmtSpeed(summary.tokensPerSec), hint: "输出 ÷ LLM 耗时" },
        { label: "解码速度", value: fmtSpeed(summary.decodeTokensPerSec), hint: "输出 ÷ (LLM 耗时 − 首 token)" },
        {
          label: "命中率",
          value: fmtHitRate(summary.cacheReadTokens, summary.inputTokens),
          hint: "缓存读 ÷ 总输入",
          numeric: true,
        },
        {
          label: "估算费用",
          // 两个币种各有各的真实合计,并排放在一行;不做"折算成单一币种再相加"。
          // 只有一侧有值时省略另一侧,免得出现"¥0.00"这种看着像 bug 的空账
          value: fmtCostSplit(summary.costUsd, summary.costCny),
          hint: summary.unpricedModels.length > 0 ? `${summary.unpricedModels.length} 个模型未配置单价` : "",
          warn: summary.unpricedModels.length > 0,
        },
      ]
    : Array.from({ length: 8 }, () => ({ label: "", value: "…", hint: "" }));

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((c, i) => (
        <div
          key={i}
          className="rounded-xl border border-border bg-card text-card-foreground shadow-xs px-4 py-3"
        >
          <div className="text-xs font-medium text-muted-foreground">{c.label}</div>
          <div className="mt-1 text-xl font-semibold tabular-nums tracking-tight whitespace-nowrap">{c.value}</div>
          <div className={"mt-0.5 min-h-4 text-[11px] " + (c.warn ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground/80")}>
            {c.hint}
          </div>
        </div>
      ))}
    </div>
  );
}
