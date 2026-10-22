import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { CalendarDays, ChevronDown, X } from "lucide-react";
import type { HeatCell } from "../../shared/types";
import type { Range } from "../api";
import { fmtTokens } from "../format";
import { barScale } from "./ui/data-viz";
import { Panel } from "./ui/panel";
import { Segmented } from "./ui/segmented";
import { cn } from "@/lib/utils";

type Preset = "today" | "yesterday" | "7d" | "30d" | "all" | "custom";
type Mode = "single" | "dates" | "hours";

type TipBase = {
  cellKey: string;
  label: string;
  time: string;
  tokens: number;
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
const LEVELS = ["bg-muted/45", "bg-clay/30", "bg-clay/50", "bg-clay/75", "bg-clay"];
const GRID_COLS = "84px repeat(24, minmax(0, 1fr)) 72px 54px";
const DAY_MS = 86_400_000;
const HOUR_VIEW_OPTIONS = [
  { value: "day", label: "按天" },
  { value: "hour", label: "按小时" },
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
        <span className="text-[20px] font-semibold leading-none tabular-nums text-foreground">{fmtTokens(tip.tokens)}</span>
        <span className="text-[10.5px] text-muted-foreground">Token</span>
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
      aria-label={`${base.label} ${base.time}，${fmtTokens(base.tokens)} Token`}
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

function VolumeBar({ value, max, delay = 0 }: { value: number; max: number; delay?: number }) {
  // 与「用量明细 / 请求日志」同一套 barScale(asinh) 压缩；标尺取整个所选范围的最大日 Token
  const pct = value > 0 && max > 0 ? barScale(value, max) * 100 : 0;
  return (
    <div className="flex h-full items-center pr-1" aria-hidden>
      <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-accent/70">
        <span
          className="heat-volume absolute inset-y-0 left-0 rounded-full bg-clay"
          style={{ width: `${pct}%`, animationDelay: `${delay}ms` }}
        />
      </span>
    </div>
  );
}

function HourBars({
  values,
  tip,
  ariaLabel,
  max,
  peakHour,
  pinned,
  levelOf,
  onHover,
  onPin,
  onLeave,
}: {
  values: number[];
  tip: (hour: number, tokens: number) => TipBase;
  ariaLabel: string;
  max: number;
  peakHour: number;
  pinned: CellTip | null;
  levelOf: (tokens: number) => string;
  onHover: HoverFn;
  onPin: PinFn;
  onLeave: () => void;
}) {
  return (
    <div className="mt-1">
      <div className="relative flex h-[104px] items-end gap-[3px] border-b border-border/60 px-1" role="group" aria-label={ariaLabel}>
        {values.map((tokens, hour) => {
          const base = tip(hour, tokens);
          const h = max > 0 ? Math.max(2, (tokens / max) * 92) : 2;
          return (
            <button
              key={hour}
              type="button"
              data-heat-cell
              aria-label={`${base.label} ${base.time}，${fmtTokens(tokens)} Token`}
              aria-pressed={pinned?.cellKey === base.cellKey}
              className="group relative flex h-full flex-1 items-end justify-center outline-none focus-visible:z-10"
              onMouseEnter={(e) => onHover(e, base, e.currentTarget.firstElementChild)}
              onMouseLeave={onLeave}
              onFocus={(e) => onHover(e, base, e.currentTarget.firstElementChild)}
              onBlur={onLeave}
              onClick={(e) => onPin(e, base, e.currentTarget.firstElementChild)}
            >
              <span
                className={cn(
                  "heat-bar w-full rounded-t-[3px] transition-[filter,background-color] duration-150 group-hover:brightness-110",
                  tokens === 0 ? "bg-muted/45" : levelOf(tokens),
                  pinned?.cellKey === base.cellKey
                    ? "ring-2 ring-clay/70"
                    : hour === peakHour && "ring-1 ring-clay/60 ring-offset-1 ring-offset-card",
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
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-2 py-10 text-center">
      <span className="flex size-9 items-center justify-center rounded-full bg-accent text-muted-foreground">
        <CalendarDays size={16} />
      </span>
      <p className="text-[12px] text-muted-foreground">该时间范围内没有数据</p>
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
  const [hourView, setHourView] = useState<"day" | "hour">("day");
  const [visibleDays, setVisibleDays] = useState(7);

  const win = useMemo<{ mode: Mode; keys: string[]; label: string }>(() => {
    const plain = (mode: Mode, keys: string[], label: string) => ({ mode, keys, label });
    const dayView = (from: string, to: string, span: number, allowHour: boolean) => {
      const mode: Mode = allowHour && hourView === "hour" ? "hours" : "dates";
      return {
        mode,
        keys: dayKeys(from, to),
        label:
          mode === "hours"
            ? `按小时 · ${fmtDay(from)} – ${fmtDay(to)} · ${span} 天`
            : `${fmtDay(from)} – ${fmtDay(to)} · ${span} 天`,
      };
    };

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
        return dayView(keys[0], keys[29], 30, true);
      }
      case "custom": {
        const from = customFrom || (range.from ? dayKey(new Date(range.from)) : cellDays[0]);
        const to = customTo || (range.to ? dayKey(new Date(range.to)) : cellDays[cellDays.length - 1] ?? todayKey);
        if (!from || !to || from > to) return plain("dates", [], "自定义");
        const span = spanDays(from, to);
        if (span === 1) return plain("single", [from], `自定义 · ${fmtLongDay(from)}`);
        if (span > 31) return dayView(from, to, span, false);
        const keys = dayKeys(from, to);
        return plain("dates", keys, `${fmtDay(from)} – ${fmtDay(to)} · ${keys.length} 天`);
      }
      case "all": {
        if (cellDays.length === 0) return plain("dates", [], "全部");
        const from = cellDays[0];
        const to = cellDays[cellDays.length - 1];
        const span = spanDays(from, to);
        if (span === 1) return plain("single", [from], `全部 · ${fmtLongDay(from)}`);
        return dayView(from, to, span, true);
      }
    }
  }, [preset, range.from, range.to, customFrom, customTo, cellDays, today, todayKey, yesterdayKey, hourView]);

  const showHourToggle =
    (preset === "30d" || preset === "all") && win.mode !== "single" && win.keys.length > 1;

  const totalDays = win.keys.length;
  const shownKeys = useMemo(() => {
    if (win.mode !== "dates") return win.keys;
    return win.keys.length > visibleDays ? win.keys.slice(-visibleDays) : win.keys;
  }, [win, visibleDays]);
  const activeKeys = win.mode === "dates" ? shownKeys : win.keys;

  const agg = useMemo(() => {
    const dayMap = new Map<string, number[]>();
    const active = new Set<string>();

    if (win.mode === "hours") {
      const inRange = new Set(win.keys);
      const hourTotals = Array<number>(24).fill(0);
      for (const c of cells) {
        if (!inRange.has(c.day) || c.hour < 0 || c.hour > 23) continue;
        hourTotals[c.hour] += c.tokens;
        if (c.tokens > 0) active.add(c.day);
      }
      const total = hourTotals.reduce((a, b) => a + b, 0);
      const maxHour = Math.max(...hourTotals, 0);
      const peakHour = maxHour > 0 ? hourTotals.indexOf(maxHour) : -1;
      const activeHours = hourTotals.filter((v) => v > 0).length;
      return {
        dayMap,
        hourTotals,
        total,
        maxCell: maxHour,
        maxHour,
        peakHour,
        activeHours,
        activeDays: active.size,
        dayTotals: new Map<string, number>(),
        mostActive: null,
      };
    }

    for (const key of activeKeys) dayMap.set(key, Array<number>(24).fill(0));
    for (const c of cells) {
      const row = dayMap.get(c.day);
      if (!row || c.hour < 0 || c.hour > 23) continue;
      row[c.hour] += c.tokens;
      if (c.tokens > 0) active.add(c.day);
    }

    const hourTotals = Array<number>(24).fill(0);
    for (const row of dayMap.values()) for (let h = 0; h < 24; h++) hourTotals[h] += row[h];

    const total = hourTotals.reduce((a, b) => a + b, 0);
    let maxCell = 0;
    for (const row of dayMap.values()) for (const v of row) maxCell = Math.max(maxCell, v);
    const maxHour = Math.max(...hourTotals, 0);
    const peakHour = maxHour > 0 ? hourTotals.indexOf(maxHour) : -1;
    const activeHours = hourTotals.filter((v) => v > 0).length;

    const dayTotals = new Map<string, number>();
    for (const [key, row] of dayMap) dayTotals.set(key, row.reduce((a, b) => a + b, 0));

    let mostActive: { label: string; tokens: number } | null = null;
    if (win.mode === "dates") {
      let bestKey = "";
      let best = 0;
      for (const [key, v] of dayTotals) {
        if (v > best) {
          best = v;
          bestKey = key;
        }
      }
      if (best > 0) mostActive = { label: `${fmtDay(bestKey)} ${weekday(bestKey)}`, tokens: best };
    }

    return {
      dayMap,
      hourTotals,
      total,
      maxCell,
      maxHour,
      peakHour,
      activeHours,
      activeDays: active.size,
      dayTotals,
      mostActive,
    };
  }, [cells, win, shownKeys]);

  // Token 条沿用 tokens 条的页面级标尺：取整个所选范围的最大日 Token，
  // 展开/收起时同一天的条长不跳变。
  const barMax = useMemo(() => {
    if (win.mode === "hours") return 0;
    const inRange = new Set(win.keys);
    const totals = new Map<string, number>();
    for (const c of cells) {
      if (inRange.has(c.day)) totals.set(c.day, (totals.get(c.day) ?? 0) + c.tokens);
    }
    return Math.max(...totals.values(), 0);
  }, [cells, win]);

  const level = (tokens: number) =>
    tokens <= 0 || agg.maxCell <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((tokens / agg.maxCell) * 4)));

  const hostRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<CellTip | null>(null);
  const [pinned, setPinned] = useState<CellTip | null>(null);

  // 切换范围后旧的锚点已失效，收起浮层并回到默认的按天视图
  useEffect(() => {
    setHover(null);
    setPinned(null);
    setHourView("day");
    setVisibleDays(7);
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

  const dayTip = (key: string, hour: number, tokens: number): TipBase => {
    const dayTotal = agg.dayTotals.get(key) ?? 0;
    return {
      cellKey: `${key}|${hour}`,
      label: `${fmtLongDay(key)} ${weekday(key)}`,
      time: hourRange(hour),
      tokens,
      share: dayTotal > 0 ? tokens / dayTotal : 0,
      shareRange: agg.total > 0 ? tokens / agg.total : 0,
      shareLabel: "占当日",
    };
  };

  const hourTip = (hour: number, tokens: number): TipBase => ({
    cellKey: `hour|${hour}`,
    label: "区间按小时",
    time: hourRange(hour),
    tokens,
    share: agg.total > 0 ? tokens / agg.total : 0,
    shareRange: agg.total > 0 ? tokens / agg.total : 0,
    shareLabel: "占区间",
  });

  const totalTip = (hour: number, tokens: number): TipBase => ({
    cellKey: `total|${hour}`,
    label: "区间合计",
    time: hourRange(hour),
    tokens,
    share: agg.total > 0 ? tokens / agg.total : 0,
    shareRange: agg.total > 0 ? tokens / agg.total : 0,
    shareLabel: "占区间",
  });

  const hasData = cells.length > 0 && win.keys.length > 0 && (win.mode === "dates" || agg.total > 0);
  const rowH = win.mode === "dates" ? (shownKeys.length > 20 ? 15 : 18) : 18;
  const dayHours = win.mode === "single" ? agg.dayMap.get(win.keys[0]) ?? Array<number>(24).fill(0) : [];
  const nextVisible = visibleDays < 30 ? Math.min(30, totalDays) : Math.min(totalDays, visibleDays + 30);
  const nextLabel =
    visibleDays < 30
      ? `展开到 ${nextVisible} 天`
      : totalDays - visibleDays <= 30
        ? `展开剩余 ${totalDays - visibleDays} 天`
        : "再展开 30 天";
  const expandNext = () =>
    setVisibleDays((v) => (v < 30 ? Math.min(30, totalDays) : Math.min(totalDays, v + 30)));

  return (
    <Panel
      title="活跃时段"
      sub="本地时间 · 总 Token"
      actions={
        <div className="flex items-center gap-2">
          {showHourToggle && (
            <Segmented
              value={hourView}
              options={HOUR_VIEW_OPTIONS}
              onChange={setHourView}
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
              <Metric
                label="总 Token"
                value={fmtTokens(agg.total)}
                hint={win.mode === "dates" && shownKeys.length < totalDays ? `近 ${shownKeys.length} 天` : undefined}
              />
              {agg.peakHour >= 0 && (
                <Metric label="峰值" value={`${pad2(agg.peakHour)}:00`} hint={`${fmtTokens(agg.maxHour)} Token`} />
              )}
              {win.mode === "single" ? (
                <Metric label="活跃小时" value={`${agg.activeHours} 小时`} />
              ) : win.mode === "hours" ? (
                <>
                  <Metric label="活跃小时" value={`${agg.activeHours} 小时`} />
                  <Metric label="活跃日" value={`${agg.activeDays} 天`} />
                </>
              ) : (
                <>
                  {agg.mostActive && (
                    <Metric
                      label="最活跃日"
                      value={agg.mostActive.label}
                      hint={`${fmtTokens(agg.mostActive.tokens)} Token`}
                    />
                  )}
                  <Metric label="活跃日" value={`${agg.activeDays} 天`} />
                </>
              )}
            </div>

            {win.mode === "dates" && totalDays > 7 && (
              <div className="flex items-center justify-between gap-3 px-1 pb-1.5 text-[10px] text-muted-foreground">
                <span>
                  {shownKeys.length < totalDays
                    ? `最近 ${shownKeys.length} 天 · 共 ${totalDays} 天`
                    : `已显示全部 ${totalDays} 天`}
                </span>
                {shownKeys.length < totalDays && (
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={expandNext}
                      className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-accent/50 px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-accent"
                    >
                      {nextLabel}
                      <ChevronDown size={11} />
                    </button>
                    {totalDays > 30 && (
                      <button
                        type="button"
                        onClick={() => setVisibleDays(totalDays)}
                        className="text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                      >
                        全部展开
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {win.mode === "single" ? (
              <HourBars
                values={dayHours}
                tip={(hour, tokens) => dayTip(win.keys[0], hour, tokens)}
                ariaLabel="24 小时活跃时段"
                max={agg.maxCell}
                peakHour={agg.peakHour}
                pinned={pinned}
                levelOf={(v) => LEVELS[level(v)]}
                onHover={onHover}
                onPin={onPin}
                onLeave={() => setHover(null)}
              />
            ) : win.mode === "hours" ? (
              <HourBars
                values={agg.hourTotals}
                tip={hourTip}
                ariaLabel="区间按小时 Token 分布"
                max={agg.maxHour}
                peakHour={agg.peakHour}
                pinned={pinned}
                levelOf={(v) => LEVELS[level(v)]}
                onHover={onHover}
                onPin={onPin}
                onLeave={() => setHover(null)}
              />
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
                      <span className="sticky left-0 z-30 bg-card text-[9.5px] text-muted-foreground">日期</span>
                      {HOURS.map((h) => (
                        <span key={h} className="text-center text-[9px] tabular-nums text-muted-foreground">
                          {h % 3 === 0 ? pad2(h) : ""}
                        </span>
                      ))}
                      <span className="pl-0.5 text-[9.5px] text-muted-foreground">分布</span>
                      <span className="text-right text-[9.5px] text-muted-foreground">Token</span>
                    </div>

                    {shownKeys.map((key, rowIndex) => {
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
                              {hours.map((tokens, hour) => {
                                const base = dayTip(key, hour, tokens);
                                return (
                                  <HeatCellButton
                                    key={hour}
                                    base={base}
                                    levelClass={LEVELS[level(tokens)]}
                                    rowH={rowH}
                                    pinned={pinned?.cellKey === base.cellKey}
                                    onHover={onHover}
                                    onPin={onPin}
                                    onLeave={() => setHover(null)}
                                  />
                                );
                              })}
                              <VolumeBar value={dayTotal} max={barMax} delay={rowIndex * 16} />
                              <span
                                className={cn(
                                  "text-right text-[10px] tabular-nums",
                                  dayTotal > 0 ? "text-foreground" : "text-muted-foreground/45",
                                )}
                              >
                                {fmtTokens(dayTotal)}
                              </span>
                            </div>
                          );
                        })}

                    <div
                      className="sticky bottom-0 z-20 grid items-end gap-[3px] border-t border-border/60 bg-card px-2 py-1.5"
                      style={{ gridTemplateColumns: GRID_COLS }}
                    >
                      <span className="sticky left-0 z-30 bg-card text-[10px] font-medium text-muted-foreground">合计</span>
                      {agg.hourTotals.map((tokens, hour) => {
                        const base = totalTip(hour, tokens);
                        const h = agg.maxHour > 0 ? Math.max(2, (tokens / agg.maxHour) * 24) : 2;
                        return (
                          <button
                            key={hour}
                            type="button"
                            data-heat-cell
                            aria-label={`${base.label} ${base.time}，${fmtTokens(tokens)} Token`}
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
                                tokens === 0 ? "bg-muted/40" : hour === agg.peakHour ? "bg-clay" : "bg-clay/50",
                                pinned?.cellKey === base.cellKey && "ring-2 ring-clay/70",
                              )}
                              style={{ height: `${h}px` }}
                            />
                          </button>
                        );
                      })}
                      <span aria-hidden />
                      <span className="text-right text-[10.5px] font-semibold tabular-nums text-foreground">
                        {fmtTokens(agg.total)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-2 flex items-center justify-between gap-3 px-1">
              <span className="text-[10px] text-muted-foreground">
                {win.mode === "hours" ? "按小时聚合" : win.mode === "single" ? "按小时" : "按天排列"}
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
