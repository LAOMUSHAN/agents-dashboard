import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 面板壳:替代旧 .panel/.panel-title-row/.panel-title 组合。
 * 标题行右侧 slot 用于放置切换按钮组/副标题。
 */
export function Panel({
  title,
  sub,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-panel bg-card text-card-foreground shadow-panel",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2">
        <div className="min-w-0 text-[13px] font-semibold tracking-wide text-foreground">
          {title}
          {sub != null && (
            <span className="ml-2 font-normal text-muted-foreground">{sub}</span>
          )}
        </div>
        {actions}
      </div>
      <div className="px-3 pb-3">{children}</div>
    </section>
  );
}
