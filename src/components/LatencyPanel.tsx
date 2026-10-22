import type { LatencyStat } from "../../shared/types";
import { fmtDuration, fmtNumber, fmtSpeed } from "../format";
import { Panel } from "./ui/panel";
import { SourceBadge } from "./SourceBadge";

/**
 * 模型延迟：每个模型一张横向卡片，指标用自适应网格排布。
 * 窄窗口自动换行，不出现横向滚动条，也不靠固定列宽硬挤。
 */
export function LatencyPanel({ stats }: { stats: LatencyStat[] }) {
  return (
    <Panel title="模型延迟" sub="端到端耗时 · 首 token 延迟">
      {stats.length === 0 ? (
        <div className="px-2 py-10 text-center text-[13px] text-muted-foreground">
          该时间范围内没有数据
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-1 pb-1">
          {stats.map((m) => {
            const metrics: [string, string][] = [
              ["平均", fmtDuration(m.avgMs)],
              ["P50", fmtDuration(m.p50Ms)],
              ["P95", fmtDuration(m.p95Ms)],
              ["首tok P50", fmtDuration(m.ttftP50Ms)],
              ["首tok P95", fmtDuration(m.ttftP95Ms)],
              ["总速度", fmtSpeed(m.tokensPerSec)],
              ["解码速度", fmtSpeed(m.decodeTokensPerSec)],
            ];
            return (
              <div key={`${m.source}:${m.modelId}`} className="rounded-lg bg-accent/30 px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate font-mono text-[11px]" title={m.modelId}>
                      {m.modelId}
                    </span>
                    <SourceBadge source={m.source} className="shrink-0" />
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                    {fmtNumber(m.requests)} 次请求
                  </span>
                </div>
                <div className="mt-2 grid gap-x-3 gap-y-2 [grid-template-columns:repeat(auto-fit,minmax(72px,1fr))]">
                  {metrics.map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <div className="whitespace-nowrap text-[10px] text-muted-foreground">{label}</div>
                      <div className="truncate text-[13px] font-medium tabular-nums">{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}


