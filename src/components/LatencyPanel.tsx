import type { LatencyStat } from "../../shared/types";
import { fmtDuration, fmtNumber, fmtSeconds, fmtSpeed } from "../format";
import { Panel } from "./ui/panel";

const TH_NUM = "px-2 py-2 text-right text-[11px] font-medium text-muted-foreground whitespace-nowrap";
const TD_NUM = "px-2 py-1.5 text-right text-[13px] tabular-nums whitespace-nowrap";

export function LatencyPanel({ stats }: { stats: LatencyStat[] }) {
  return (
    <Panel title="模型延迟" sub="端到端耗时 · 首 token 延迟">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="border-b border-border">
              <th className="px-2 py-2 text-left text-[11px] font-medium text-muted-foreground">模型</th>
              <th className={TH_NUM}>请求</th>
              <th className={TH_NUM}>平均</th>
              <th className={TH_NUM}>P50</th>
              <th className={TH_NUM}>P95</th>
              <th className={TH_NUM}>首tok P50</th>
              <th className={TH_NUM}>首tok P95</th>
              <th className={TH_NUM}>总速度</th>
              <th className={TH_NUM}>解码速度</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((m) => (
              <tr key={m.modelId} className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50">
                <td className="px-2 py-1.5 font-mono text-xs">{m.modelId}</td>
                <td className={TD_NUM}>{fmtNumber(m.requests)}</td>
                <td className={TD_NUM}>{fmtDuration(m.avgMs)}</td>
                <td className={TD_NUM}>{fmtDuration(m.p50Ms)}</td>
                <td className={TD_NUM}>{fmtDuration(m.p95Ms)}</td>
                <td className={TD_NUM}>{fmtDuration(m.ttftP50Ms)}</td>
                <td className={TD_NUM}>{fmtDuration(m.ttftP95Ms)}</td>
                <td className={TD_NUM}>{fmtSpeed(m.tokensPerSec)}</td>
                <td className={TD_NUM}>{fmtSpeed(m.decodeTokensPerSec)}</td>
              </tr>
            ))}
            {stats.length === 0 && (
              <tr>
                <td colSpan={9} className="px-2 py-8 text-center text-[13px] text-muted-foreground">
                  该时间范围内没有数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
