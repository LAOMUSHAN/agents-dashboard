import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BadgeTone = "ok" | "err" | "warn" | "info" | "muted";

const TONES: Record<BadgeTone, string> = {
  ok: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-emerald-500/25",
  err: "bg-rose-500/12 text-rose-600 dark:text-rose-400 border-rose-500/25",
  warn: "bg-amber-500/14 text-amber-600 dark:text-amber-400 border-amber-500/25",
  info: "bg-sky-500/12 text-sky-600 dark:text-sky-400 border-sky-500/25",
  muted: "bg-muted text-muted-foreground border-transparent",
};

/** 状态徽标:替代旧 .badge ok/err/warn/info,色调语义与旧版一致 */
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
