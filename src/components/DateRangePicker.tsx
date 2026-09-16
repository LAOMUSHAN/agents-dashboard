import { useMemo, useState } from "react";
import { CalendarRange } from "lucide-react";
import type { Range } from "../api";
import { Dropdown, type DropdownOption } from "./Dropdown";

export type Preset = "today" | "yesterday" | "7d" | "30d" | "all" | "custom";

const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
  { key: "all", label: "全部" },
];

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfYesterday(): number {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 把 preset(+自定义日期)换算成查询范围 */
export function useRange(): {
  preset: Preset;
  setPreset: (p: Preset) => void;
  customFrom: string;
  customTo: string;
  setCustom: (from: string, to: string) => void;
  range: Range;
} {
  const [preset, setPresetState] = useState<Preset>("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const setPreset = (p: Preset) => {
    setPresetState(p);
    if (p !== "custom") {
      setCustomFrom("");
      setCustomTo("");
    }
  };

  const setCustom = (from: string, to: string) => {
    setCustomFrom(from);
    setCustomTo(to);
    if (from || to) setPresetState("custom");
  };

  // 用 useMemo 稳定 range 的对象身份,避免依赖它的 useEffect 无限循环。
  // 预设范围不设 to:上界由服务端按每次查询的时刻决定,定时刷新才能查到新产生的数据
  const range = useMemo(() => {
    const now = Date.now();
    switch (preset) {
      case "today":
        return { from: startOfToday() };
      // 昨天的数据不会新增,固定上界为今天零点
      case "yesterday":
        return { from: startOfYesterday(), to: startOfToday() };
      case "7d":
        return { from: now - 7 * 86400_000 };
      case "30d":
        return { from: now - 30 * 86400_000 };
      case "custom": {
        const from = customFrom ? new Date(customFrom + "T00:00:00").getTime() : undefined;
        const to = customTo ? new Date(customTo + "T23:59:59.999").getTime() : undefined;
        return { from, to };
      }
      default:
        return {};
    }
  }, [preset, customFrom, customTo]);

  return { preset, setPreset, customFrom, customTo, setCustom, range };
}

const DOW = ["一", "二", "三", "四", "五", "六", "日"];

function toKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function parseKey(s: string): Date {
  return new Date(s + "T00:00:00");
}

type RangeCalendarProps = {
  from: string;
  to: string;
  onPick: (from: string, to: string) => void;
  onClear: () => void;
  onDone: () => void;
};

type CalMode = "days" | "months" | "years";
const YEARS_PER_PAGE = 12;

/** 范围日历:先点开始再点结束,替代原生 date input;标题里的年/月可点开快选面板 */
function RangeCalendar({ from, to, onPick, onClear, onDone }: RangeCalendarProps) {
  const now = new Date();
  const nowY = now.getFullYear();
  const nowM = now.getMonth();
  const [view, setView] = useState(() => (from ? parseKey(from) : new Date()));
  const [mode, setMode] = useState<CalMode>("days");
  // 年份面板按 12 年一页翻页
  const [yearPage, setYearPage] = useState(
    () => Math.floor(view.getFullYear() / YEARS_PER_PAGE) * YEARS_PER_PAGE,
  );
  const vy = view.getFullYear();
  const vm = view.getMonth();
  const todayKey = toKey(now);

  // 统计是历史数据,不允许翻到未来年/月
  const canNext =
    mode === "days"
      ? vy < nowY || (vy === nowY && vm < nowM)
      : mode === "months"
        ? vy < nowY
        : yearPage + YEARS_PER_PAGE <= nowY;

  const shift = (dir: number) => {
    if (mode === "days") setView(new Date(vy, vm + dir, 1));
    else if (mode === "months") setView(new Date(vy + dir, vm, 1));
    else setYearPage((p) => p + dir * YEARS_PER_PAGE);
  };

  // 快选年/月可能落到未来(比如当前 8 月却选了 12 月),统一夹回当前月
  const pickView = (y: number, m: number) => {
    if (y > nowY || (y === nowY && m > nowM)) {
      setView(new Date(nowY, nowM, 1));
    } else {
      setView(new Date(y, m, 1));
    }
    setMode("days");
  };

  // 固定 6 行网格,周一起始;非本月格子留空
  const pad = (new Date(vy, vm, 1).getDay() + 6) % 7;
  const cells: Array<Date | null> = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(vy, vm, 1 - pad + i);
    cells.push(d.getMonth() === vm ? d : null);
  }

  const pick = (key: string) => {
    if (!from || to) onPick(key, "");
    else if (key >= from) onPick(from, key);
    else onPick(key, "");
  };

  const hint = !from ? "请选择开始日期" : !to ? "请选择结束日期" : `${from.slice(5)} ~ ${to.slice(5)}`;

  return (
    <div className="range-calendar">
      <div className="cal-head">
        <button
          type="button"
          className="cal-nav"
          onClick={() => shift(-1)}
          aria-label={mode === "days" ? "上个月" : mode === "months" ? "上一年" : "上一组年份"}
        >
          ‹
        </button>
        {mode === "years" ? (
          <span className="cal-title">
            {yearPage} - {yearPage + YEARS_PER_PAGE - 1}
          </span>
        ) : (
          <span className="cal-switch">
            <button
              type="button"
              className={"cal-switch-btn" + (mode === "months" ? " dimmed" : "")}
              onClick={() => {
                setYearPage(Math.floor(vy / YEARS_PER_PAGE) * YEARS_PER_PAGE);
                setMode("years");
              }}
            >
              {vy} 年
            </button>
            <button
              type="button"
              className="cal-switch-btn"
              onClick={() => setMode(mode === "months" ? "days" : "months")}
            >
              {vm + 1} 月
            </button>
          </span>
        )}
        <button
          type="button"
          className="cal-nav"
          onClick={() => shift(1)}
          aria-label={mode === "days" ? "下个月" : mode === "months" ? "下一年" : "下一组年份"}
          disabled={!canNext}
        >
          ›
        </button>
      </div>
      {mode === "days" && (
        <div className="cal-grid">
          {DOW.map((d) => (
            <span key={d} className="cal-dow">
              {d}
            </span>
          ))}
          {cells.map((d, i) => {
            if (!d) return <span key={`blank-${i}`} />;
            const key = toKey(d);
            const future = key > todayKey;
            const edge = key === from || key === to;
            const inRange = !!from && !!to && key > from && key < to;
            const cls =
              "cal-day" +
              (future ? " disabled" : "") +
              (inRange ? " in-range" : "") +
              (edge ? " edge" : "") +
              (key === todayKey ? " today" : "");
            return (
              <button key={key} type="button" className={cls} disabled={future} onClick={() => pick(key)}>
                {d.getDate()}
              </button>
            );
          })}
        </div>
      )}

      {mode === "months" && (
        <div className="cal-panel">
          {Array.from({ length: 12 }, (_, m) => {
            const future = vy === nowY && m > nowM;
            const cls =
              "cal-cell" +
              (m === vm ? " selected" : "") +
              (vy === nowY && m === nowM ? " today" : "") +
              (future ? " disabled" : "");
            return (
              <button key={m} type="button" className={cls} disabled={future} onClick={() => pickView(vy, m)}>
                {m + 1} 月
              </button>
            );
          })}
        </div>
      )}

      {mode === "years" && (
        <div className="cal-panel">
          {Array.from({ length: YEARS_PER_PAGE }, (_, i) => {
            const y = yearPage + i;
            const future = y > nowY;
            const cls =
              "cal-cell" +
              (y === vy ? " selected" : "") +
              (y === nowY ? " today" : "") +
              (future ? " disabled" : "");
            return (
              <button key={y} type="button" className={cls} disabled={future} onClick={() => pickView(y, vm)}>
                {y}
              </button>
            );
          })}
        </div>
      )}

      <div className="cal-foot">
        <span className="cal-hint">{hint}</span>
        <span className="cal-actions">
          <button type="button" className="cal-btn" onClick={onClear}>
            清空
          </button>
          <button type="button" className="cal-btn primary" onClick={onDone} disabled={!from || !to}>
            确定
          </button>
        </span>
      </div>
    </div>
  );
}

export function DateRangePicker(props: ReturnType<typeof useRange>) {
  const { preset, setPreset, customFrom, customTo, setCustom } = props;

  // 自定义范围时触发器/选项显示紧凑的 MM-DD 区间,未选完则用省略号占位
  const options = useMemo<DropdownOption<Preset>[]>(() => {
    const customLabel =
      customFrom || customTo
        ? `${customFrom ? customFrom.slice(5) : "…"} ~ ${customTo ? customTo.slice(5) : "…"}`
        : "自定义";
    return [
      ...PRESETS.map((p) => ({ value: p.key, label: p.label })),
      { value: "custom", label: customLabel, keepOpen: true },
    ];
  }, [customFrom, customTo]);

  return (
    <Dropdown
      value={preset}
      options={options}
      onChange={setPreset}
      icon={CalendarRange}
      title="时间范围"
      dropUp
      extra={({ close }) =>
        preset === "custom" ? (
          <RangeCalendar
            from={customFrom}
            to={customTo}
            onPick={setCustom}
            onClear={() => setCustom("", "")}
            onDone={close}
          />
        ) : null
      }
    />
  );
}
