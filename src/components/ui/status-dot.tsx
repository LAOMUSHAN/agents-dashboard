import { cn } from "@/lib/utils";

export type StatusKind = "completed" | "error" | "cancelled" | "running";

const TONES: Record<StatusKind, string> = {
  completed: "bg-success",
  error: "bg-danger",
  cancelled: "bg-muted-foreground/60",
  running: "bg-clay animate-pulse",
};

/** CDS 6px 状态灯：表格行、会话分组头、错误卡片共用 */
export function StatusDot({
  kind,
  className,
  title,
}: {
  kind: StatusKind;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      aria-hidden={title ? undefined : true}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", TONES[kind], className)}
    />
  );
}
