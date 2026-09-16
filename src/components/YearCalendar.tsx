import { useMemo } from "react";
import type { DailyActivityPoint } from "../../shared/types";
import { fmtTokens } from "../format";
import { Panel } from "./ui/panel";

const DOW_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const MONTH_LABELS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

/** "YYYY-MM-DD" → 本地时间零点(避免 UTC 解析偏移) */
function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function fmtDay(day: string): string {
  const d = parseDay(day);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

type CalDay = { key: string; calls: number; out: number; inRange: boolean };
type CalWeek = { days: CalDay[]; /** 该周要显示的月份下标,null=不显示 */ label: number | null };

export function YearCalendar({ points }: { points: DailyActivityPoint[] }) {
  const byDay = useMemo(() => {
    const m = new Map<string, DailyActivityPoint>();
    for (const p of points) m.set(p.day, p);
    return m;
  }, [points]);

  // 连续 12 个月:从 11 个月前的 1 号到本月末;列为周(周日开始),行为星期几
  // 月标签在该月第一个出现的周打标,构建时同步计算,避免渲染期 Date 解析错位
  const grid = useMemo<CalWeek[]>(() => {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth() - 11, 1);
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const cur = new Date(start);
    cur.setDate(cur.getDate() - cur.getDay()); // 回退到所在周的周日
    const weeks: CalWeek[] = [];
    let labeledMonth = -1;
    while (cur <= end) {
      const days: CalDay[] = [];
      let label: number | null = null;
      for (let i = 0; i < 7; i++) {
        const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
        const inRange = cur >= start && cur <= end;
        const p = byDay.get(key);
        days.push({ key, calls: p?.calls ?? 0, out: p?.outputTokens ?? 0, inRange });
        if (inRange && cur.getMonth() !== labeledMonth) {
          label = cur.getMonth();
          labeledMonth = cur.getMonth();
        }
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push({ days, label });
    }
    return weeks;
  }, [byDay]);

  const max = points.reduce((mx, p) => Math.max(mx, p.calls), 0);
  // GitHub 风格五档色阶
  const level = (calls: number) =>
    calls === 0 || max === 0 ? 0 : Math.min(4, Math.ceil((calls / max) * 4));
  const CELL_COLORS = [
    "bg-muted",
    "bg-sky-900/70 dark:bg-sky-950",
    "bg-sky-700/70 dark:bg-sky-800",
    "bg-sky-500/80 dark:bg-sky-600",
    "bg-sky-400 dark:bg-sky-400",
  ];

  return (
    <Panel title="活跃日历" sub="近 12 个月 · 模型调用次数">
      {points.length === 0 ? (
        <div className="px-2 py-8 text-center text-[13px] text-muted-foreground">该时间范围内没有数据</div>
      ) : (
        <>
          <div className="overflow-x-auto px-2 pb-1">
            <div className="inline-flex flex-col gap-1">
              {/* 月标签行:h-4 占位 + 与格子行同款列步进(w-3+gap-0.5),标签不压圆点不错位 */}
              <div className="flex h-4 gap-0.5 pl-[26px]">
                {grid.map((week, wi) => (
                  <div key={wi} className="relative w-3 shrink-0">
                    {week.label != null && (
                      <span className="absolute left-0 top-0 whitespace-nowrap text-[9px] leading-4 text-muted-foreground">
                        {MONTH_LABELS[week.label]}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-0.5">
                <div className="mr-0.5 flex w-6 shrink-0 flex-col gap-0.5">
                  {DOW_LABELS.map((l, i) => (
                    <span key={i} className="flex h-3 items-center text-[9px] leading-none text-muted-foreground">
                      {i % 2 === 0 ? l : ""}
                    </span>
                  ))}
                </div>
                {grid.map((week, wi) => (
                  <div key={wi} className="flex shrink-0 flex-col gap-0.5">
                    {week.days.map((c) => (
                      <div
                        key={c.key}
                        title={c.inRange ? `${fmtDay(c.key)} · ${c.calls} 次 · 输出 ${fmtTokens(c.out)}` : undefined}
                        className={
                          "size-3 rounded-sm " +
                          (c.inRange ? CELL_COLORS[level(c.calls)] : "bg-transparent")
                        }
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 px-2 pt-1 text-[11px] text-muted-foreground">
            <span>少</span>
            {CELL_COLORS.map((c, i) => (
              <span key={i} className={`size-3 rounded-sm ${c}`} />
            ))}
            <span>多</span>
          </div>
        </>
      )}
    </Panel>
  );
}
