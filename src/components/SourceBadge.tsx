import { sourceLabel } from "@/lib/source";
import { StatBadge } from "./ui/stat-badge";

/** 数据源徽标：聚合视图里区分同名模型/供应商行 */
export function SourceBadge({ source, className }: { source: string; className?: string }) {
  const tone = source === "dsh" ? "dsh" : source === "claude" ? "info" : "muted";
  const title =
    source === "dsh"
      ? "来自 DSH 会话日志"
      : source === "claude"
        ? "来自 Claude Code 会话日志"
        : "来自 zcode 用量库";
  return (
    <StatBadge tone={tone} className={className} title={title}>
      {sourceLabel(source)}
    </StatBadge>
  );
}
