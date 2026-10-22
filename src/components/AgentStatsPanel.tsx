import type { AgentStat } from "../../shared/types";
import { fmtNumber, fmtSeconds, fmtSpeed, fmtTokens } from "../format";
import { Panel } from "./ui/panel";
import { StatBadge } from "./ui/stat-badge";
import { SourceBadge } from "./SourceBadge";

const TH_NUM = "px-2 py-2 text-right text-[11px] font-medium text-muted-foreground whitespace-nowrap";
const TD_NUM = "px-2 py-1.5 text-right text-[13px] tabular-nums whitespace-nowrap";

/** 代理展示名:去掉 zcode- 前缀,空值归为"未记录" */
function agentLabel(agent: string | null): string {
  return agent?.replace(/^zcode-/, "") ?? "未记录";
}

/** 主会话标识:general-purpose 之外的未知代理统一展示原名,主代理 high-light */
function isMain(agent: string | null): boolean {
  return agent == null || agent === "main" || agent === "zcode-main";
}

export function AgentStatsPanel({ stats }: { stats: AgentStat[] }) {
  const maxRequests = stats[0]?.requests ?? 0;
  const totalRequests = stats.reduce((s, a) => s + a.requests, 0);
  return (
    <Panel title="代理工作流对比" sub={`${fmtNumber(stats.length)} 类代理 · ${fmtNumber(totalRequests)} 次调用`}>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="border-b border-border">
              <th className="px-2 py-2 text-left text-[11px] font-medium text-muted-foreground">代理</th>
              <th className={TH_NUM}>调用</th>
              <th className={TH_NUM}>会话</th>
              <th className={TH_NUM}>输入</th>
              <th className={TH_NUM}>输出</th>
              <th className={TH_NUM}>缓存读</th>
              <th className={TH_NUM}>总速度</th>
              <th className={TH_NUM}>解码速度</th>
              <th className={TH_NUM}>首 tok</th>
              <th className={TH_NUM}>错误</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((a) => (
              <tr key={`${a.source}:${a.agent ?? "__none__"}`} className="border-b border-border/60 transition-colors last:border-0 hover:bg-accent/50">
                <td className="relative px-2 py-1.5">
                  <div
                    aria-hidden
                    className="absolute inset-y-1 left-2 rounded-sm bg-clay-soft"
                    style={{ width: `${maxRequests ? (a.requests / maxRequests) * 92 : 0}%` }}
                  />
                  <span className={"relative font-mono text-xs " + (isMain(a.agent) ? "font-semibold" : "")}>
                    {agentLabel(a.agent)}
                  </span>
                  <SourceBadge source={a.source} className="relative ml-1.5" />
                  {isMain(a.agent) && <StatBadge tone="info" className="relative ml-1.5">主</StatBadge>}
                </td>
                <td className={TD_NUM}>{fmtNumber(a.requests)}</td>
                <td className={TD_NUM + " text-muted-foreground"}>{fmtNumber(a.sessions)}</td>
                <td className={TD_NUM}>{fmtTokens(a.inputTokens)}</td>
                <td className={TD_NUM}>{fmtTokens(a.outputTokens)}</td>
                <td className={TD_NUM + " text-muted-foreground"}>{fmtTokens(a.cacheReadTokens)}</td>
                <td className={TD_NUM}>{fmtSpeed(a.tokensPerSec)}</td>
                <td className={TD_NUM}>{fmtSpeed(a.decodeTokensPerSec)}</td>
                <td className={TD_NUM}>{fmtSeconds(a.avgTtftMs)}</td>
                <td className={TD_NUM}>
                  {a.errors ? <StatBadge tone="err">{fmtNumber(a.errors)}</StatBadge> : "-"}
                </td>
              </tr>
            ))}
            {stats.length === 0 && (
              <tr>
                <td colSpan={10} className="px-2 py-8 text-center text-[13px] text-muted-foreground">
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
