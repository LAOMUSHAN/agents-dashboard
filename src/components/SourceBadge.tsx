import { StatBadge } from "./ui/stat-badge";

/** 数据源徽标：聚合视图里区分同名模型/供应商行 */
export function SourceBadge({ source, className }: { source: string; className?: string }) {
  const dsh = source === "dsh";
  return (
    <StatBadge
      tone={dsh ? "info" : "muted"}
      className={className}
      title={dsh ? "来自 DSH 会话日志" : "来自 zcode 用量库"}
    >
      {dsh ? "DSH" : "zcode"}
    </StatBadge>
  );
}
