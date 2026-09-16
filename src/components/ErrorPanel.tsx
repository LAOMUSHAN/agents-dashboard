import type { ErrorStats } from "../../shared/types";
import { fmtNumber, fmtPercent } from "../format";
import { PartyPopper } from "lucide-react";
import { Panel } from "./ui/panel";

const ZERO: ErrorStats = {
  total: 0,
  completed: 0,
  error: 0,
  cancelled: 0,
  cancelledByUser: 0,
  retriedRequests: 0,
  contextExceeded: 0,
  groups: [],
};

function Chip({ label, value, hint, danger }: { label: string; value: string; hint?: string; danger?: boolean }) {
  return (
    <div className="flex-1 min-w-28 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className={"mt-0.5 text-lg font-semibold tabular-nums " + (danger ? "text-rose-600 dark:text-rose-400" : "")}>
        {value}
        {hint && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}

export function ErrorPanel({ stats }: { stats: ErrorStats | null }) {
  const s = stats ?? ZERO;
  return (
    <Panel title="错误与取消" sub="含所有状态的请求">
      <div className="flex flex-wrap gap-2 px-2 pb-3">
        <Chip label="总请求" value={fmtNumber(s.total)} />
        <Chip label="错误" value={fmtNumber(s.error)} hint={fmtPercent(s.error, s.total)} danger={s.error > 0} />
        <Chip label="取消" value={fmtNumber(s.cancelled)} hint={`手动 ${fmtNumber(s.cancelledByUser)}`} />
        <Chip label="触发重试" value={fmtNumber(s.retriedRequests)} />
        <Chip label="上下文超限" value={fmtNumber(s.contextExceeded)} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="border-b border-border">
              <th className="px-2 py-2 text-left text-[11px] font-medium text-muted-foreground">类型</th>
              <th className="px-2 py-2 text-left text-[11px] font-medium text-muted-foreground">错误码</th>
              <th className="px-2 py-2 text-right text-[11px] font-medium text-muted-foreground">次数</th>
              <th className="px-2 py-2 text-left text-[11px] font-medium text-muted-foreground">最近错误消息</th>
            </tr>
          </thead>
          <tbody>
            {s.groups.map((g, i) => (
              <tr key={i} className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50">
                <td className="px-2 py-1.5 font-mono text-xs">{g.errorType || "-"}</td>
                <td className="px-2 py-1.5 font-mono text-xs">{g.errorCode || "-"}</td>
                <td className="px-2 py-1.5 text-right text-[13px] tabular-nums">{fmtNumber(g.count)}</td>
                <td className="max-w-0 truncate px-2 py-1.5 text-[13px] text-muted-foreground" title={g.sampleMessage ?? undefined}>
                  {g.sampleMessage || "-"}
                </td>
              </tr>
            ))}
            {s.groups.length === 0 && (
              <tr>
                <td colSpan={4} className="px-2 py-8 text-center text-[13px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <PartyPopper size={14} />
                    没有错误记录
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
