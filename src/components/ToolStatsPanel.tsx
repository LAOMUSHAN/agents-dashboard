import type { ToolStat } from "../../shared/types";
import { fmtDuration, fmtNumber, fmtPercent } from "../format";
import { Panel } from "./ui/panel";
import { StatBadge } from "./ui/stat-badge";

const TH_NUM = "px-2 py-2 text-right text-[11px] font-medium text-muted-foreground whitespace-nowrap";
const TD_NUM = "px-2 py-1.5 text-right text-[13px] tabular-nums whitespace-nowrap";

export function ToolStatsPanel({ stats }: { stats: ToolStat[] }) {
  // 第一名的调用量作为比例条的满格基准
  const maxCalls = stats[0]?.calls ?? 0;
  return (
    <Panel title="工具调用统计" sub={`${fmtNumber(stats.length)} 种工具`}>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="border-b border-border">
              <th className="px-2 py-2 text-left text-[11px] font-medium text-muted-foreground">工具</th>
              <th className={TH_NUM}>调用</th>
              <th className={TH_NUM}>取消</th>
              <th className={TH_NUM}>错误</th>
              <th className={TH_NUM}>错误率</th>
              <th className={TH_NUM}>平均耗时</th>
              <th className={TH_NUM}>最大耗时</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((t) => (
              <tr key={t.toolName} className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50">
                <td className="relative px-2 py-1.5">
                  <div
                    aria-hidden
                    className="absolute inset-y-1 left-2 rounded-sm bg-sky-500/12"
                    style={{ width: `${maxCalls ? (t.calls / maxCalls) * 92 : 0}%` }}
                  />
                  <span className="relative font-mono text-xs">{t.toolName}</span>
                </td>
                <td className={TD_NUM}>{fmtNumber(t.calls)}</td>
                <td className={TD_NUM + " text-muted-foreground"}>{t.cancelled || "-"}</td>
                <td className={TD_NUM}>
                  {t.errors ? <StatBadge tone="err">{fmtNumber(t.errors)}</StatBadge> : "-"}
                </td>
                <td className={TD_NUM + " text-muted-foreground"}>{t.errors ? fmtPercent(t.errors, t.calls) : "-"}</td>
                <td className={TD_NUM}>{fmtDuration(t.avgMs)}</td>
                <td className={TD_NUM}>{fmtDuration(t.maxMs)}</td>
              </tr>
            ))}
            {stats.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-8 text-center text-[13px] text-muted-foreground">
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
