import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BadgeTone = "ok" | "err" | "warn" | "info" | "dsh" | "muted";

const TONES: Record<BadgeTone, string> = {
  ok: "bg-success/12 text-success border-success/25",
  err: "bg-danger/12 text-danger border-danger/25",
  warn: "bg-warn/14 text-warn border-warn/25",
  info: "bg-clay-soft text-clay border-clay/25",
  dsh: "bg-dsh-soft text-dsh-text border-dsh-border",
  muted: "bg-muted text-muted-foreground border-transparent",
};

/** 状态徽标：按 tone 输出对应色调 */
export function StatBadge({
  tone,
  children,
  className,
  title,
}: {
  tone: BadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
