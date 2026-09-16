import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 数字单元格:tabular-nums 保证纵向对齐,muted 降调次要数值 */
export function NumCell({
  children,
  muted,
  className,
}: {
  children: ReactNode;
  muted?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        "p-2 text-right align-middle text-[13px] tabular-nums",
        muted && "text-muted-foreground",
        className,
      )}
    >
      {children}
    </td>
  );
}

/** 等宽文本单元格(模型ID/错误码/路径) */
export function MonoCell({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td
      title={title}
      className={cn("p-2 align-middle font-mono text-xs", className)}
    >
      {children}
    </td>
  );
}
