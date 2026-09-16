import type { ReactNode } from "react";
import { fmtBucket } from "../../format";

/**
 * 图表统一悬浮卡:替代旧 .chart-tooltip 类,直接用设计令牌着色。
 * rows 由调用方给出行描述(dot 色 / 名称 / 格式化值),合计行可选。
 */
export function ChartTip({
  active,
  label,
  rows,
  total,
  totalLabel = "合计",
}: {
  active?: boolean;
  label?: string | number;
  rows: { key: string | number; color: string; name: ReactNode; value: ReactNode }[];
  total?: ReactNode;
  totalLabel?: string;
}) {
  if (!active || rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-popover/95 px-3 py-2 shadow-lg backdrop-blur-sm">
      {label != null && (
        <div className="mb-1 text-[11px] font-semibold text-foreground">{fmtBucket(String(label))}</div>
      )}
      <div className="flex flex-col gap-1">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2 text-xs">
            <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: r.color }} />
            <span className="text-muted-foreground">{r.name}</span>
            <span className="ml-auto pl-3 font-medium tabular-nums text-foreground">{r.value}</span>
          </div>
        ))}
        {total != null && (
          <div className="mt-1 flex items-center gap-2 border-t border-border/60 pt-1 text-xs">
            <span className="text-muted-foreground">{totalLabel}</span>
            <span className="ml-auto font-semibold tabular-nums">{total}</span>
          </div>
        )}
      </div>
    </div>
  );
}
