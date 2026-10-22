import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { CalendarDays, X } from "lucide-react";
import type { HeatCell } from "../../shared/types";
import type { Range } from "../api";
import { fmtNumber } from "../format";
import { Panel } from "./ui/panel";
import { Segmented } from "./ui/segmented";
import { cn } from "@/lib/utils";

type Preset = "today" | "yesterday" | "7d" | "30d" | "all" | "custom";
type Mode = "single" | "dates" | "weekdays";

type TipBase = {
  cellKey: string;
  label: string;
  time: string;
  calls: number;
  share: number;
  shareRange: number;
  shareLabel: string;
};
type CellTip = TipBase & {
  left: number;
  top: number;
  placement: "top" | "bottom";
  align: "center" | "left" | "right";
};

type HoverFn = (
  e: ReactMouseEvent<HTMLElement> | ReactFocusEvent<HTMLElement>,
  base: TipBase,
  anchor?: Element | null,
) => void;
type PinFn = (e: ReactMouseEvent<HTMLElement>, base: TipBase, anchor?: Element | null) => void;

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DOW_CN = ["日", "一", "二", "三", "四", "五", "六"];
const DOW_FULL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/** 长期范围按星期聚合时用周一开头，符合中文日历习惯 */
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
const LEVELS = ["bg-muted/45", "bg-clay/30", "bg-clay/50", "bg-clay/75", "bg-clay"];
const GRID_COLS = "84px repeat(24, minmax(0, 1fr)) 54px";
const DAY_MS = 86_400_000;
const LONG_VIEW_OPTIONS = [
  { value: "weekdays", label: "按星期" },
  { value: "dates", label: "按日期" },
] as const;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function fmtDay(key: string): string {
  const d = parseDay(key);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtLongDay(key: string): string {
  const d = parseDay(key);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function weekday(key: string): string {
  return `周${DOW_CN[parseDay(key).getDay()]}`;
}

function lastNDays(today: Date, n: number): string[] {
  return Array.from({ length: n }, (_, i) => dayKey(addDays(today, i - n + 1)));
}

/** 闭区间日期列表；上限 400 天，避免异常输入把渲染拖死 */
function dayKeys(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = parseDay(from);
  const end = parseDay(to);
  while (cur <= end && out.length < 400) {
    out.push(dayKey(cur));
    cur = addDays(cur, 1);
  }
  return out;
}

function spanDays(from: string, to: string): number {
  return Math.max(1, Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / DAY_MS) + 1);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function hourRange(h: number): string {
  return `${pad2(h)}:00–${pad2(h + 1)}:00`;
}

function fmtPct(v: number): string {
  const p = v * 100;
  if (p >= 10) return `${Math.round(p)}%`;
  if (p >= 1) return `${p.toFixed(1)}%`;
  return p > 0 ? "<1%" : "0%";
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-[10px] tracking-[0.04em] text-muted-foreground">{label}</span>
      <span className="text-[12px] font-semibold tabular-nums text-foreground">{value}</span>
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </span>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
      <span>少</span>
      {LEVELS.map((c, i) => (
        <span key={i} className={cn("size-2.5 rounded-[3px]", c)} />
      ))}
      <span>多</span>
    </div>
  );
}

function ShareBar({ label, value }: { label: string; value: number }) {
  const width = value > 0 ? Math.min(100, Math.max(2, value * 100)) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums text-foreground">{fmtPct(value)}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-accent">
        <div className="h-full rounded-full bg-clay transition-[width]" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function HeatTip({
  tip,
  expanded,
  onClose,
}: {
  tip: CellTip;
  expanded?: boolean;
  onClose?: () => void;
}) {
  return (
    <div
      className={cn(
        "relative rounded-xl border border-border/70 bg-popover/95 p-3 text-popover-foreground shadow-popover backdrop-blur-md",
        expanded ? "w-[214px]" : "w-[188px]",
      )}
    >
      {expanded && (
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭详情"
          className="absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X size={12} />
        </button>
      )}
      <div className="pr-5 text-[10px] font-medium tracking-[0.04em] text-muted-foreground">{tip.label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-[20px] font-semibold leading-none tabular-nums text-foreground">{fmtNumber(tip.calls)}</span>
        <span className="text-[10.5px] text-muted-foreground">次调用</span>
      </div>
      <div className="mt-1 text-[10.5px] tabular-nums text-muted-foreground">{tip.time}</div>
      {expanded ? (
        <div className="mt-2.5 space-y-2">
          <ShareBar label={tip.shareLabel} value={tip.share} />
          {tip.shareLabel !== "占区间" && Math.abs(tip.share - tip.shareRange) > 0.0005 && (
            <ShareBar label="占区间" value={tip.shareRange} />
          )}
        </div>
      ) : (
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span>{tip.shareLabel}</span>
          <span className="tabular-nums text-foreground">{fmtPct(tip.share)}</span>
        </div>
      )}
    </div>
  );
}

function TipLayer({
  tip,
  expanded,
  onClose,
}: {
  tip: CellTip;
  expanded?: boolean;
  onClose?: () => void;
}) {
  const origin = `${tip.placement === "top" ? "bottom" : "top"} ${
    tip.align === "left" ? "left" : tip.align === "right" ? "right" : "center"
  }`;
  return (
    <div
      className={cn(
        "absolute z-50",
        tip.align === "center" && "-translate-x-1/2",
        tip.align === "right" && "-translate-x-full",
        tip.placement === "top" && "-translate-y-full",
        expanded ? "pointer-events-auto" : "pointer-events-none",
      )}
      style={{
        left: tip.left,
        top: tip.placement === "top" ? tip.top - 8 : tip.top + 8,
      }}
    >
      <div
        data-heat-card={expanded ? "" : undefined}
        className="heat-tip-in"
        key={expanded ? tip.cellKey : "hover"}
        style={{ transformOrigin: origin }}
      >
        <HeatTip tip={tip} expanded={expanded} onClose={onClose} />
      </div>
    </div>
  );
}

function HeatCellButton({
  base,
  levelClass,
  rowH,
  pinned,
  onHover,
  onPin,
  onLeave,
}: {
  base: TipBase;
  levelClass: string;
  rowH: number;
  pinned: boolean;
  onHover: HoverFn;
  onPin: PinFn;
  onLeave: () => void;
}) {
  return (
    <button
      type="button"
      data-heat-cell
      aria-label={`${base.label} ${base.time}，${base.calls} 次调用`}
      aria-pressed={pinned}
      className={cn(
        "heat-cell relative w-full rounded-[3px] outline-none transition-transform duration-150 hover:z-10 hover:scale-[1.12] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-clay/50",
        levelClass,
        pinned && "ring-2 ring-clay/70",
      )}
      style={{ height: rowH }}
      onMouseEnter={(e) => onHover(e, base)}
      onMouseLeave={onLeave}
      onFocus={(e) => onHover(e, base)}
      onBlur={onLeave}
      onClick={(e) => onPin(e, base)}
    />
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-2 py-10 text-center">
      <span className="flex size-9 items-center justify-center rounded-full bg-accent text-muted-foreground">
        <CalendarDays size={16} />
      </span>
      <p className="text-[12px] text-muted-foreground">该时间范围内没有调用</p>
      <p className="text-[10px] text-muted-foreground/70">{label}</p>
    </div>
  );
}

export function ActivityHeatmap({
  cells,
  preset,
  range,
  customFrom,
  customTo,
}: {
  cells: HeatCell[];
  preset: Preset;
  range: Range;
  customFrom: string;
  customTo: string;
}) {
  const today = useMemo(() => startOfDay(new Date()), []);
  const todayKey = dayKey(today);
  const yesterdayKey = dayKey(addDays(today, -1));
  const cellDays = useMemo(() => [...new Set(cells.map((c) => c.day))].sort(), [cells]);
  const [longView, setLongView] = useState<"weekdays" | "dates">("weekdays");

  const win = useMemo<{ mode: Mode; keys: string[]; label: string; longRange: boolean }>(() => {
    const plain = (mode: Mode, keys: string[], label: string) => ({ mode, keys, label, longRange: false });
    const long = (from: string, to: string, span: number) => ({
      mode: (longView === "dates" ? "dates" : "weekdays") as Mode,
      keys: longView === "dates" ? dayKeys(from, to) : cellDays,
      label:
        longView === "dates"
          ? `按日期 · ${fmtDay(from)} – ${fmtDay(to)} · ${span} 天`
          : `按星期聚合 · ${fmtDay(from)} – ${fmtDay(to)}`,
      longRange: true,
    });

    switch (preset) {
      case "today":
        return plain("single", [todayKey], `今天 · ${fmtLongDay(todayKey)}`);
      case "yesterday":
        return plain("single", [yesterdayKey], `昨天 · ${fmtLongDay(yesterdayKey)}`);
      case "7d": {
        const keys = lastNDays(today, 7);
        return plain("dates", keys, `${fmtDay(keys[0])} – ${fmtDay(keys[6])} · 7 天`);
      }
      case "30d": {
        const keys = lastNDays(today, 30);
        return plain("dates", keys, `${fmtDay(keys[0])} – ${fmtDay(keys[29])} · 30 天`);
      }
      case "custom": {
        const from = customFrom || (range.from ? dayKey(new Date(range.from)) : cellDays[0]);
        const to = customTo || (range.to ? dayKey(new Date(range.to)) : cellDays[cellDays.length - 1] ?? todayKey);
        if (!from || !to || from > to) return plain("dates", [], "自定义");
        const span = spanDays(from, to);
        if (span === 1) return plain("single", [from], `自定义 · ${fmtLongDay(from)}`);
        if (span > 31) return long(from, to, span);
        const keys = dayKeys(from, to);
        return plain("dates", keys, `${fmtDay(from)} – ${fmtDay(to)} · ${keys.length} 天`);
      }
      case "all": {
        if (cellDays.length === 0) return plain("dates", [], "全部");
        const from = cellDays[0];
        const to = cellDays[cellDays.length - 1];
        const span = spanDays(from, to);
        if (span === 1) return plain("single", [from], `全部 · ${fmtLongDay(from)}`);
        if (span > 31) return long(from, to, span);
        return plain("dates", dayKeys(from, to), `全部 · ${fmtDay(from)} – ${fmtDay(to)}`);
      }
    }
  }, [preset, range.from, range.to, customFrom, customTo, cellDays, today, todayKey, yesterdayKey, longView]);

  const agg = useMemo(() => {
    const dayMap = new Map<string, number[]>();
    const dowMap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    const active = new Set<string>();

    if (win.mode === "weekdays") {
      for (const c of cells) {
        if (c.dow < 0 || c.dow > 6 || c.hour < 0 || c.hour > 23) continue;
        dowMap[c.dow][c.hour] += c.calls;
        if (c.calls > 0) active.add(c.day);
      }
    } else {
      for (const key of win.keys) dayMap.set(key, Array<number>(24).fill(0));
      for (const c of cells) {
        const row = dayMap.get(c.day);
        if (!row || c.hour < 0 || c.hour > 23) continue;
        row[c.hour] += c.calls;
        if (c.calls > 0) active.add(c.day);
      }
    }

    const hourTotals = Array<number>(24).fill(0);
    if (win.mode === "weekdays") {
      for (const row of dowMap) for (let h = 0; h < 24; h++) hourTotals[h] += row[h];
    } else {
      for (const row of dayMap.values()) for (let h = 0; h < 24; h++) hourTotals[h] += row[h];
    }

    const total = hourTotals.reduce((a, b) => a + b, 0);
    let maxCell = 0;
    if (win.mode === "weekdays") {
      for (const row of dowMap) for (const v of row) maxCell = Math.max(maxCell, v);
    } else {
      for (const row of dayMap.values()) for (const v of row) maxCell = Math.max(maxCell, v);
    }
    const maxHour = Math.max(...hourTotals, 0);
    const peakHour = maxHour > 0 ? hourTotals.indexOf(maxHour) : -1;
    const activeHours = hourTotals.filter((v) => v > 0).length;

    const dayTotals = new Map<string, number>();
    for (const [key, row] of dayMap) dayTotals.set(key, row.reduce((a, b) => a + b, 0));
    const dowTotals = dowMap.map((row) => row.reduce((a, b) => a + b, 0));

    let mostActive: { label: string; calls: number } | null = null;
    if (win.mode === "weekdays") {
      let best = 0;
      for (let d = 1; d < 7; d++) if (dowTotals[d] > dowTotals[best]) best = d;
      if (dowTotals[best] > 0) mostActive = { label: DOW_FULL[best], calls: dowTotals[best] };
    } else if (win.mode === "dates") {
      let bestKey = "";
      let best = 0;
      for (const [key, v] of dayTotals) {
        if (v > best) {
          best = v;
          bestKey = key;
        }
      }
      if (best > 0) mostActive = { label: `${fmtDay(bestKey)} ${weekday(bestKey)}`, calls: best };
    }

    return {
      dayMap,
      dowMap,
      hourTotals,
      total,
      maxCell,
      maxHour,
      peakHour,
      activeHours,
      activeDays: active.size,
      dayTotals,
      dowTotals,
      mostActive,
    };
  }, [cells, win]);

  const level = (calls: number) =>
    calls <= 0 || agg.maxCell <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((calls / agg.maxCell) * 4)));

  const hostRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<CellTip | null>(null);
  const [pinned, setPinned] = useState<CellTip | null>(null);

  // 切换范围后旧的锚点已失效，收起浮层并回到默认的星期视图
  useEffect(() => {
    setHover(null);
    setPinned(null);
    setLongView("weekdays");
  }, [preset, range.from, range.to, customFrom, customTo]);

  const makeTip = (
    base: TipBase,
    e: ReactMouseEvent<HTMLElement> | ReactFocusEvent<HTMLElement>,
    anchor?: Element | null,
  ): CellTip | null => {
    const host = hostRef.current;
    if (!host) return null;
    const target = anchor ?? e.currentTarget;
    const r = target.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    const placement: "top" | "bottom" = spaceBelow >= 200 || spaceBelow >= spaceAbove ? "bottom" : "top";
    const cardW = 214;
    const cellLeft = r.left - h.left;
    const cellRight = r.right - h.left;
    let align: "center" | "left" | "right" = "center";
    let left = cellLeft + r.width / 2;
    if (h.width >= 260 && cellLeft < 110) {
      align = "left";
      left = clamp(cellRight + 8, 8, Math.max(8, h.width - cardW - 8));
    } else if (h.width >= 260 && h.width - cellRight < 110) {
      align = "right";
      left = clamp(cellLeft - 8, cardW + 8, Math.max(cardW + 8, h.width - 8));
    } else {
      left = clamp(left, 106, Math.max(106, h.width - 106));
    }
    return {
      ...base,
      left,
      top: placement === "top" ? r.top - h.top : r.bottom - h.top,
      placement,
      align,
    };
  };

  const onHover: HoverFn = (e, base, anchor) => {
    const tip = makeTip(base, e, anchor);
    if (tip) setHover(tip);
  };

  const onPin: PinFn = (e, base, anchor) => {
    const tip = makeTip(base, e, anchor);
    if (!tip) return;
    setHover(null);
    setPinned((prev) => (prev?.cellKey === tip.cellKey ? null : tip));
  };

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("[data-heat-card]") || t?.closest("[data-heat-cell]")) return;
      setPinned(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  const dayTip = (key: string, hour: number, calls: number): TipBase => {
    const dayTotal = agg.dayTotals.get(key) ?? 0;
    return {
      cellKey: `${key}|${hour}`,
      label: `${fmtLongDay(key)} ${weekday(key)}`,
      time: hourRange(hour),
      calls,
      share: dayTotal > 0 ? calls / dayTotal : 0,
      shareRange: agg.total > 0 ? calls / agg.total : 0,
      shareLabel: "占当日",
    };
  };

  const weekdayTip = (dow: number, hour: number, calls: number): TipBase => {
    const dowTotal = agg.dowTotals[dow] ?? 0;
    return {
      cellKey: `dow:${dow}|${hour}`,
      label: DOW_FULL[dow],
      time: hourRange(hour),
      calls,
      share: dowTotal > 0 ? calls / dowTotal : 0,
      shareRange: agg.total > 0 ? calls / agg.total : 0,
      shareLabel: "占该星期",
    };
  };

  const totalTip = (hour: number, calls: number): TipBase => ({
    cellKey: `total|${hour}`,
    label: "区间合计",
    time: hourRange(hour),
    calls,
    share: agg.total > 0 ? calls / agg.total : 0,
    shareRange: agg.total > 0 ? calls / agg.total : 0,
    shareLabel: "占区间",
  });

  const hasData = cells.length > 0 && agg.total > 0;
  const rowH = win.mode === "weekdays" ? 18 : win.keys.length > 20 ? 15 : 18;
  const dayHours = win.mode === "single" ? agg.dayMap.get(win.keys[0]) ?? Array<number>(24).fill(0) : [];

  return (
    <Panel
      title="活跃时段"
      sub="本地时间 · 模型调用次数"
      actions={
        <div className="flex items-center gap-2">
          {win.longRange && (
            <Segmented
              value={longView}
              options={LONG_VIEW_OPTIONS}
              onChange={setLongView}
              className="h-6 [&_button]:px-2 [&_button]:text-[10px]"
            />
          )}
          <span className="inline-flex max-w-[300px] items-center gap-1.5 rounded-full border border-border/70 bg-accent/50 px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
            <CalendarDays size={11} className="shrink-0" />
            <span className="truncate" title={win.label}>
              {win.label}
            </span>
          </span>
        </div>
      }
    >
      <div ref={hostRef} className="relative">
        {!hasData ? (
          <Empty label={win.label} />
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 px-1 pb-2.5">
              <Metric label="调用" value={fmtNumber(agg.total)} />
              {agg.peakHour >= 0 && (
                <Metric label="峰值" value={`${pad2(agg.peakHour)}:00`} hint={`${fmtNumber(agg.maxHour)} 次`} />
              )}
              {win.mode === "single" ? (
                <Metric label="活跃小时" value={`${agg.activeHours} 小时`} />
              ) : (
                <>
                  {agg.mostActive && (
                    <Metric
                      label={win.mode === "weekdays" ? "最活跃" : "最活跃日"}
                      value={agg.mostActive.label}
                      hint={`${fmtNumber(agg.mostActive.calls)} 次`}
                    />
                  )}
                  <Metric label="活跃日" value={`${agg.activeDays} 天`} />
                </>
              )}
            </div>

            {win.mode === "single" ? (
              <div className="mt-1">
                <div className="relative flex h-[104px] items-end gap-[3px] border-b border-border/60 px-1" role="group" aria-label="24 小时活跃时段">
                  {dayHours.map((calls, hour) => {
                    const base = dayTip(win.keys[0], hour, calls);
                    const h = agg.maxCell > 0 ? Math.max(2, (calls / agg.maxCell) * 92) : 2;
                    return (
                      <button
                        key={hour}
                        type="button"
                        data-heat-cell
                        aria-label={`${base.label} ${base.time}，${calls} 次调用`}
                        aria-pressed={pinned?.cellKey === base.cellKey}
                        className="group relative flex h-full flex-1 items-end justify-center outline-none focus-visible:z-10"
                        onMouseEnter={(e) => onHover(e, base, e.currentTarget.firstElementChild)}
                        onMouseLeave={() => setHover(null)}
                        onFocus={(e) => onHover(e, base, e.currentTarget.firstElementChild)}
                        onBlur={() => setHover(null)}
                        onClick={(e) => onPin(e, base, e.currentTarget.firstElementChild)}
                      >
                        <span
                          className={cn(
                            "heat-bar w-full rounded-t-[3px] transition-[filter,background-color] duration-150 group-hover:brightness-110",
                            calls === 0 ? "bg-muted/45" : LEVELS[level(calls)],
                            pinned?.cellKey === base.cellKey
                              ? "ring-2 ring-clay/70"
                              : hour === agg.peakHour && "ring-1 ring-clay/60 ring-offset-1 ring-offset-card",
                          )}
                          style={{ height: `${h}px`, animationDelay: `${hour * 12}ms` }}
                        />
                      </button>
                    );
                  })}
                </div>
                <div
                  className="mt-1 grid gap-[3px] px-1 text-center text-[9px] tabular-nums text-muted-foreground"
                  style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}
                >
                  {HOURS.map((h) => (
                    <span key={h}>{h % 2 === 0 ? pad2(h) : ""}</span>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mt-1">
                <div
                  className="max-h-[430px] overflow-auto rounded-lg border border-border/50 bg-card"
                  onScroll={() => {
                    setHover(null);
                    setPinned(null);
                  }}
                >
                  <div className="min-w-[720px]" role="group" aria-label="活跃时段热力图">
                    <div
                      className="sticky top-0 z-20 grid items-center gap-[3px] border-b border-border/60 bg-card px-2 py-1.5"
                      style={{ gridTemplateColumns: GRID_COLS }}
                    >
                      <span className="sticky left-0 z-30 bg-card text-[9.5px] text-muted-foreground">
                        {win.mode === "weekdays" ? "星期" : "日期"}
                      </span>
                      {HOURS.map((h) => (
                        <span key={h} className="text-center text-[9px] tabular-nums text-muted-foreground">
                          {h % 3 === 0 ? pad2(h) : ""}
                        </span>
                      ))}
                      <span className="text-right text-[9.5px] text-muted-foreground">合计</span>
                    </div>

                    {win.mode === "weekdays"
                      ? MONDAY_FIRST.map((dow) => {
                          const row = agg.dowMap[dow];
                          const dowTotal = agg.dowTotals[dow] ?? 0;
                          return (
                            <div
                              key={dow}
                              className="grid items-center gap-[3px] border-b border-border/30 px-2 py-[3px] last:border-0 hover:bg-accent/30"
                              style={{ gridTemplateColumns: GRID_COLS }}
                            >
                              <div className="sticky left-0 z-10 flex items-baseline gap-1.5 bg-card py-0.5 pr-2">
                                <span className="text-[11px] font-medium text-foreground">{DOW_FULL[dow]}</span>
                              </div>
                              {row.map((calls, hour) => {
                                const base = weekdayTip(dow, hour, calls);
                                return (
                                  <HeatCellButton
                                    key={hour}
                                    base={base}
                                    levelClass={LEVELS[level(calls)]}
                                    rowH={rowH}
                                    pinned={pinned?.cellKey === base.cellKey}
                                    onHover={onHover}
                                    onPin={onPin}
                                    onLeave={() => setHover(null)}
                                  />
                                );
                              })}
                              <span
                                className={cn(
                                  "text-right text-[10px] tabular-nums",
                                  dowTotal > 0 ? "text-foreground" : "text-muted-foreground/45",
                                )}
                              >
                                {fmtNumber(dowTotal)}
                              </span>
                            </div>
                          );
                        })
                      : win.keys.map((key) => {
                          const hours = agg.dayMap.get(key) ?? Array<number>(24).fill(0);
                          const dayTotal = agg.dayTotals.get(key) ?? 0;
                          const isToday = key === todayKey;
                          const isYesterday = key === yesterdayKey;
                          return (
                            <div
                              key={key}
                              className="grid items-center gap-[3px] border-b border-border/30 px-2 py-[3px] last:border-0 hover:bg-accent/30"
                              style={{ gridTemplateColumns: GRID_COLS }}
                            >
                              <div className="sticky left-0 z-10 flex items-baseline gap-1.5 bg-card py-0.5 pr-2">
                                <span className="text-[11px] font-medium tabular-nums text-foreground">{fmtDay(key)}</span>
                                <span
                                  className={cn(
                                    "text-[9.5px]",
                                    isToday ? "font-medium text-clay" : "text-muted-foreground",
                                  )}
                                >
                                  {isToday ? "今天" : isYesterday ? "昨天" : weekday(key)}
                                </span>
                              </div>
                              {hours.map((calls, hour) => {
                                const base = dayTip(key, hour, calls);
                                return (
                                  <HeatCellButton
                                    key={hour}
                                    base={base}
                                    levelClass={LEVELS[level(calls)]}
                                    rowH={rowH}
                                    pinned={pinned?.cellKey === base.cellKey}
                                    onHover={onHover}
                                    onPin={onPin}
                                    onLeave={() => setHover(null)}
                                  />
                                );
                              })}
                              <span
                                className={cn(
                                  "text-right text-[10px] tabular-nums",
                                  dayTotal > 0 ? "text-foreground" : "text-muted-foreground/45",
                                )}
                              >
                                {fmtNumber(dayTotal)}
                              </span>
                            </div>
                          );
                        })}

                    <div
                      className="sticky bottom-0 z-20 grid items-end gap-[3px] border-t border-border/60 bg-card px-2 py-1.5"
                      style={{ gridTemplateColumns: GRID_COLS }}
                    >
                      <span className="sticky left-0 z-30 bg-card text-[10px] font-medium text-muted-foreground">合计</span>
                      {agg.hourTotals.map((calls, hour) => {
                        const base = totalTip(hour, calls);
                        const h = agg.maxHour > 0 ? Math.max(2, (calls / agg.maxHour) * 24) : 2;
                        return (
                          <button
                            key={hour}
                            type="button"
                            data-heat-cell
                            aria-label={`${base.label} ${base.time}，${calls} 次调用`}
                            aria-pressed={pinned?.cellKey === base.cellKey}
                            className="group flex h-[26px] items-end justify-center outline-none focus-visible:z-10"
                            onMouseEnter={(e) => onHover(e, base, e.currentTarget.firstElementChild)}
                            onMouseLeave={() => setHover(null)}
                            onFocus={(e) => onHover(e, base, e.currentTarget.firstElementChild)}
                            onBlur={() => setHover(null)}
                            onClick={(e) => onPin(e, base, e.currentTarget.firstElementChild)}
                          >
                            <span
                              className={cn(
                                "w-full rounded-t-[2px] transition-[height,background-color,filter] duration-200 group-hover:brightness-110",
                                calls === 0 ? "bg-muted/40" : hour === agg.peakHour ? "bg-clay" : "bg-clay/50",
                                pinned?.cellKey === base.cellKey && "ring-2 ring-clay/70",
                              )}
                              style={{ height: `${h}px` }}
                            />
                          </button>
                        );
                      })}
                      <span className="text-right text-[10.5px] font-semibold tabular-nums text-foreground">
                        {fmtNumber(agg.total)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-2 flex items-center justify-between gap-3 px-1">
              <span className="text-[10px] text-muted-foreground">
                {win.mode === "weekdays" ? "长期范围按星期聚合" : win.mode === "single" ? "按小时" : "按日期排列"}
              </span>
              <Legend />
            </div>
          </>
        )}

        {hover && <TipLayer tip={hover} />}
        {pinned && <TipLayer tip={pinned} expanded onClose={() => setPinned(null)} />}
      </div>
    </Panel>
  );
}
