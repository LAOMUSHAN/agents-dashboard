import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ModelStat, PeakWindow, PriceEntry, PricingConfig } from "../../shared/types";
import { api, type Range } from "../api";
import { fmtAmount, fmtCostIn, isCnyCurrency, moneyRate, setUsdCnyRate } from "../format";
import { Panel } from "./ui/panel";
import { Hint, HintText } from "./ui/hint";
import { cn } from "@/lib/utils";

/** 一行 = 一个模型的价格草稿(全部以字符串保存,便于编辑中的空值/小数) */
interface Row {
  modelId: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  currency: "usd" | "cny";
  /** 峰谷:启用后峰时段按倍率上浮;时段只影响本模型 */
  peakEnabled: boolean;
  peakMultiplier: string;
  peakKind: "peak" | "offPeak";
  peakWindows: PeakWindow[];
  /** 长上下文:启用后输入达到阈值时全部单价乘倍率 */
  longEnabled: boolean;
  longThreshold: string;
  longMultiplier: string;
  /** 价格估算(美元,后端按逐请求口径算当前范围);undefined = 计算中 */
  est?: number;
}

const num = (s: string) => (Number(s) || 0);

function toRow(modelId: string, e?: PriceEntry): Row {
  return {
    modelId,
    input: String(e?.input ?? 0),
    output: String(e?.output ?? 0),
    cacheRead: String(e?.cacheRead ?? 0),
    cacheWrite: String(e?.cacheWrite ?? 0),
    currency: e?.currency?.toLowerCase() === "cny" ? "cny" : "usd",
    peakEnabled: e?.peak != null,
    peakMultiplier: String(e?.peak?.multiplier ?? 2),
    peakKind: (e?.peak?.kind ?? "peak") === "offPeak" ? "offPeak" : "peak",
    peakWindows: e?.peak ? e.peak.windows.map((w) => ({ ...w })) : DEFAULT_PEAK_WINDOWS.map((w) => ({ ...w })),
    longEnabled: e?.longContext != null,
    longThreshold: e?.longContext ? String(e.longContext.thresholdTokens) : "",
    longMultiplier: e?.longContext ? String(e.longContext.multiplier) : "2",
  };
}

/** 草稿行 → 提交给后端的 PriceEntry(未启用的档位传 null) */
function toEntry(r: Row): PriceEntry {
  const mult = num(r.peakMultiplier);
  const threshold = Math.round(num(r.longThreshold));
  const longMult = num(r.longMultiplier);
  return {
    input: num(r.input),
    output: num(r.output),
    cacheRead: num(r.cacheRead),
    cacheWrite: num(r.cacheWrite),
    currency: r.currency === "cny" ? "cny" : null,
    // 未启用峰谷的模型传 null:后端就不做任何峰谷判定
    peak: r.peakEnabled
      ? { multiplier: mult > 1 ? mult : 2, kind: r.peakKind, windows: r.peakWindows }
      : null,
    longContext:
      r.longEnabled && threshold > 0 && longMult > 0
        ? { thresholdTokens: threshold, multiplier: longMult }
        : null,
  };
}

/** 数字输入框去掉原生上下调节箭头:微调易误改价格,箭头本身也占掉框内一位数字的位置 */
const NO_SPINNER =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

/** 单行估算签名:只有这些字段真的变了才需要重算(输入中的 "1." 与 "1" 视为同一行) */
const estKey = (r: Row) =>
  [
    r.input, r.output, r.cacheRead, r.cacheWrite, r.currency,
    r.peakEnabled, r.peakMultiplier, r.peakKind,
    r.peakWindows.map((w) => `${w.startMin}-${w.endMin}`).join(","),
    r.longEnabled, r.longThreshold, r.longMultiplier,
  ].join("|");

/** 四项价格输入框:去掉箭头后再多留一位数字,「100.25」这类四位带小数也能整串显示 */
/** 汇率输入框:与价格输入框同规格(w-16 容纳 7.15 这类汇率) */
const RATE_INPUT =
  "w-16 rounded-md border border-border bg-background px-1.5 py-1 text-right text-xs tabular-nums transition-colors focus:border-ring focus:outline-none " +
  NO_SPINNER;

const PRICE_INPUT =
  "w-16 rounded-md border border-border bg-background px-1.5 py-1 text-right text-xs tabular-nums transition-colors focus:border-ring focus:outline-none disabled:opacity-40 " +
  NO_SPINNER;

const TIME_INPUT =
  "w-[86px] rounded-md border border-border bg-background px-1.5 py-1 text-center text-xs tabular-nums transition-colors focus:border-ring focus:outline-none disabled:opacity-40";

const CELL = "px-2 py-1.5 text-right text-[13px] tabular-nums";

const DAY_MIN = 1440;

/** 新建/未配置时的默认峰时段:08:00–12:00 与 14:00–18:00 */
const DEFAULT_PEAK_WINDOWS: PeakWindow[] = [
  { startMin: 8 * 60, endMin: 12 * 60 },
  { startMin: 14 * 60, endMin: 18 * 60 },
];

/** 分钟数 → HH:MM(1440 显示为 24:00) */
function hhmm(min: number): string {
  const v = Math.max(0, Math.min(DAY_MIN, Math.round(min)));
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59) return null;
  const v = h * 60 + mi;
  return v <= DAY_MIN ? v : null;
}

/**
 * 当日补集:把列出的时段归并后取剩余时间。
 * 用于"选了峰时段就自动算出谷时段"(以及反之),不需要用户再填另一类
 */
function complementWindows(windows: PeakWindow[]): PeakWindow[] {
  const segs: [number, number][] = [];
  for (const w of windows) {
    const s = Math.max(0, Math.min(DAY_MIN, Math.round(w.startMin)));
    const e = Math.max(0, Math.min(DAY_MIN, Math.round(w.endMin)));
    if (e <= s) continue;
    if (s === 0 && e === DAY_MIN) return [];
    segs.push([s, e]);
  }
  segs.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const seg of segs) {
    const last = merged[merged.length - 1];
    if (last && seg[0] <= last[1]) last[1] = Math.max(last[1], seg[1]);
    else merged.push([seg[0], seg[1]]);
  }
  const out: PeakWindow[] = [];
  let cur = 0;
  for (const [s, e] of merged) {
    if (s > cur) out.push({ startMin: cur, endMin: s });
    cur = Math.max(cur, e);
  }
  if (cur < DAY_MIN) out.push({ startMin: cur, endMin: DAY_MIN });
  return out;
}

/** 编辑中的空窗口(0–0)不算错误,只是还没填 */
const isBlankWindow = (w: PeakWindow) => w.startMin === 0 && w.endMin === 0;
const isBadWindow = (w: PeakWindow) => !isBlankWindow(w) && w.endMin <= w.startMin;

/**
 * 时段输入:24:00 不是 <input type="time"> 的合法取值,该端点用文本输入呈现(失焦提交)
 */
function TimeInput({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  if (value >= DAY_MIN) {
    return (
      <input
        className={TIME_INPUT}
        type="text"
        defaultValue="24:00"
        disabled={disabled}
        onClick={stop}
        onBlur={(e) => {
          const v = parseHHMM(e.target.value);
          if (v != null) onChange(v);
          else e.target.value = "24:00";
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    );
  }
  return (
    <input
      className={TIME_INPUT}
      type="time"
      step={900}
      value={hhmm(value)}
      disabled={disabled}
      onClick={stop}
      onChange={(e) => {
        const v = parseHHMM(e.target.value);
        if (v != null) onChange(v);
      }}
    />
  );
}

/** 设置开关:文案固定不变(启用只改配色),避免整行列宽随状态跳动 */
function ToggleBtn({
  active,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <Hint content={<HintText>{hint}</HintText>} className="w-[230px]">
      <button
        className={cn(
          "w-16 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
          active
            ? "border-clay/40 bg-clay-soft text-clay"
            : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        {label}
      </button>
    </Hint>
  );
}

/**
 * 模型单价编辑面板:逐模型币种、峰谷加价(峰时段倍数)、长上下文加价,行尾显示价格估算。
 * 列表与估算范围都跟随侧栏的时间选择;点击行空白处展开该模型的设置区
 */
export function PricingPanel({
  range,
  models,
  onSaved,
}: {
  range: Range;
  models: ModelStat[];
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [config, setConfig] = useState<PricingConfig | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newModel, setNewModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moneyTimer = useRef<number | null>(null);
  /** 提交计数:只有它变化才触发估算,输入过程不递增 */
  const [estSeq, setEstSeq] = useState(0);
  /** 汇率输入框的编辑中文本:失焦/回车才提交,避免逐键落盘与全表重算 */
  const [rateText, setRateText] = useState("");
  /** modelId → 上次估算所依据的签名;签名没变就跳过,一次提交通常只查改动的那一个模型 */
  const estimatedRef = useRef<Map<string, string>>(new Map());
  /** debounce 回调里读最新草稿与配置 */
  const rowsRef = useRef<Row[]>([]);
  const configRef = useRef<PricingConfig | null>(null);
  rowsRef.current = rows;
  configRef.current = config;

  // 模型列表直接复用总览已加载的数据，避免打开设置页时再打一次同步查询。
  // 聚合范围下同一模型会按来源出现两行，单价是模型级的，这里按 modelId 去重。
  const uniqueModels = useMemo(() => {
    const seen = new Set<string>();
    return models.filter((m) => {
      if (seen.has(m.modelId)) return false;
      seen.add(m.modelId);
      return true;
    });
  }, [models]);
  const modelKey = useMemo(() => uniqueModels.map((m) => m.modelId).sort().join("|"), [uniqueModels]);
  useEffect(() => {
    let alive = true;
    api
      .pricing()
      .then((cfg) => {
        if (!alive) return;
        setConfig(cfg);
        // 只列出该范围内使用过的模型;范围变化时保留已编辑但未保存的草稿
        const next = uniqueModels
          .map((m) => toRow(m.modelId, cfg.models[m.modelId]))
          .sort((a, b) => a.modelId.localeCompare(b.modelId));
        setRows((prev) => {
          const draft = new Map(prev.map((r) => [r.modelId, r]));
          return next.map((r) => draft.get(r.modelId) ?? r);
        });
        // 范围变了,之前的估算全部作废
        refreshEstimate(true);
        // 已启用高级设置的模型默认展开,便于直接看到参数
        setExpanded(
          new Set(
            uniqueModels
              .filter((m) => {
                const e = cfg.models[m.modelId];
                return e?.peak != null || e?.longContext != null;
              })
              .map((m) => m.modelId),
          ),
        );
      })
      .catch((e) => setError(String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, modelKey]);

  // 汇率框文本跟随已落盘的配置(改动提交后与配置一致,无未提交编辑时始终显示真值)
  useEffect(() => {
    if (config) setRateText(String(config.usdCnyRate));
  }, [config]);

  const update = <K extends keyof Row>(i: number, field: K, value: Row[K]) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, [field]: value } : r)));
  };

  const toggleExpand = (modelId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });

  /** 以现有配置为基底合成模型表:当前范围没展示到的模型价格原样保留 */
  const buildModels = (cfg: PricingConfig) => {
    const models: Record<string, PriceEntry> = { ...cfg.models };
    for (const r of rowsRef.current) {
      if (!r.modelId.trim()) continue;
      models[r.modelId.trim()] = toEntry(r);
    }
    return models;
  };

  /**
   * 触发价格估算:只在「提交」时调用——失焦/回车、切换范围、增删模型、保存。
   * 逐键重算会给整表每个模型各打一次后端查询,输入过程必然卡顿,所以输入期间一律不重算。
   * all=false 时按签名跳过没变的行,因此一次提交通常只查改动的那一个模型。
   */
  const refreshEstimate = (all = false) => {
    if (all) estimatedRef.current.clear();
    setEstSeq((s) => s + 1);
  };

  /** 失焦/回车提交:输入框里的数字这时才参与估算(草稿值本身即时保存,不丢) */
  const commitOnBlur = () => refreshEstimate();
  const commitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  useEffect(() => {
    if (estSeq === 0) return;
    for (const r of rowsRef.current) {
      const id = r.modelId.trim();
      if (!id) continue;
      const key = estKey(r);
      if (estimatedRef.current.get(id) === key) continue;
      estimatedRef.current.set(id, key);
      api
        .estimateCost(id, toEntry(r), range)
        .then((v) => setRows((prev) => prev.map((x) => (x.modelId === id ? { ...x, est: v } : x))))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estSeq]);

  /**
   * 配置改动(汇率/峰谷时段):改完即落盘,并刷新模块级汇率。
   * 各页面的费用符号取自**该行价格表条目的币种**(不是全局开关),所以改币种或汇率后
   * 由 onSaved() 触发数据重拉,总览/明细/日志等页面按新配置重算
   */
  /** 汇率提交:非法或没变就还原输入框;变了才落盘,并按新汇率整表重算估算 */
  const commitRate = (text: string) => {
    const v = Number(text);
    if (!config || !isFinite(v) || v <= 0) {
      setRateText(config ? String(config.usdCnyRate) : "");
      return;
    }
    if (v === config.usdCnyRate) return;
    persistConfig({ ...config, usdCnyRate: v }, true);
  };

  const persistConfig = (next: PricingConfig, reestimateAll = false) => {
    setConfig(next);
    if (moneyTimer.current) window.clearTimeout(moneyTimer.current);
    moneyTimer.current = window.setTimeout(() => {
      const cfg = configRef.current;
      if (!cfg) return;
      api
        .savePricing({ ...cfg, models: buildModels(cfg) })
        .then((saved) => {
          setConfig(saved);
          setUsdCnyRate(saved.usdCnyRate);
          // 汇率影响人民币价行的折算金额:等落盘后再重算,拿到的才是新价
          if (reestimateAll) refreshEstimate(true);
          onSaved();
        })
        .catch((e) => setError(String(e)));
    }, 500);
  };

  // ---- 峰谷时段(逐模型,跟价格草稿一起编辑) ----

  const setWindows = (i: number, windows: PeakWindow[]) => {
    update(i, "peakWindows", windows);
    refreshEstimate();
  };

  const patchWindow = (i: number, wi: number, patch: Partial<PeakWindow>) =>
    setWindows(
      i,
      rowsRef.current[i].peakWindows.map((w, j) => (j === wi ? { ...w, ...patch } : w)),
    );

  /**
   * 切换基准:把列表换算成另一类的时段,时间表本身不变。
   * 例如「峰 08:00–12:00、14:00–18:00」切到以谷时段为准 → 列表变成「谷 12:00–14:00、18:00–08:00」
   */
  const switchPeakKind = (i: number, kind: "peak" | "offPeak") => {
    const r = rowsRef.current[i];
    if (!r) return;
    const wasPeak = r.peakKind !== "offPeak";
    if ((kind !== "offPeak") === wasPeak) return;
    const windows = complementWindows(r.peakWindows);
    update(i, "peakKind", kind);
    setWindows(i, windows.length > 0 ? windows : [{ startMin: 0, endMin: DAY_MIN }]);
    refreshEstimate();
  };

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const saved = await api.savePricing({ ...config, models: buildModels(config) });
      setConfig(saved);
      setUsdCnyRate(saved.usdCnyRate);
      // 后端可能归一化(如峰谷倍率 ≤1 被清空),按落盘结果重算估算
      refreshEstimate(true);
      onSaved();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // 合计按币种分开:美元定价的与人民币定价的各算各的,不做"统一折算后再相加"
  const totals = useMemo(() => {
    let usd = 0;
    let cny = 0;
    for (const r of rows) {
      if (!r.modelId.trim()) continue;
      if (isCnyCurrency(r.currency)) cny += r.est ?? 0;
      else usd += r.est ?? 0;
    }
    return { usd, cny };
  }, [rows]);

  return (
    <Panel
      title="模型单价"
      sub="价格估算按各模型自己的币种展示;合计分币种各自相加"
      actions={
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          汇率 1$ =
          <Hint
            className="w-[250px]"
            content={<HintText>改完这一格再失焦或回车才生效；输入过程中不重算也不落盘。</HintText>}
          >
            <input
              className={cn(RATE_INPUT, "text-foreground")}
              type="number"
              min="0"
              step="0.01"
              value={rateText}
              onChange={(e) => setRateText(e.target.value)}
              onBlur={(e) => commitRate(e.target.value)}
              onKeyDown={commitOnEnter}
            />
          </Hint>
          ¥
        </label>
      }
    >
      <p className="px-2 pb-2 text-[11px] leading-relaxed text-muted-foreground">
        单位为「每百万 token」,四项价格按谷时段填写(峰时段按各模型的倍率上浮)。输入价只作用于未命中缓存的输入。
        价格改完失焦或回车才重算估算(输入过程不重算,避免卡顿)。
        峰谷时段与长上下文按模型分别设置:点行空白处展开;价格估算与合计都按各模型自己的币种展示。
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 whitespace-nowrap">
          <thead>
            <tr className="border-b border-border text-[11px] font-medium text-muted-foreground">
              <th className="px-2 py-2 text-left">模型 ID</th>
              <th className="px-2 py-2 text-left">币种</th>
              <th className="px-2 py-2 text-right">输入 /M</th>
              <th className="px-2 py-2 text-right">输出 /M</th>
              <th className="px-2 py-2 text-right">缓存读 /M</th>
              <th className="px-2 py-2 text-right">缓存写 /M</th>
              <th className="px-2 py-2 text-center">峰谷</th>
              <th className="px-2 py-2 text-center">长上下文</th>
              <th className="px-2 py-2 text-right">价格估算</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const open = expanded.has(r.modelId);
              return (
                <Fragment key={r.modelId + i}>
                  <tr
                    className={cn(
                      "cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-muted/40",
                      open && "bg-muted/30",
                    )}
                    onClick={() => toggleExpand(r.modelId)}
                  >
                    <td className="max-w-48 truncate px-2 py-1.5 font-mono text-xs" title={r.modelId}>
                      <Hint
                        className="w-[250px]"
                        content={<HintText>点击展开/收起该模型的峰谷与长上下文设置</HintText>}
                      >
                        <span className="mr-1.5 inline-block text-muted-foreground">{open ? "▾" : "▸"}</span>
                      </Hint>
                      {r.modelId}
                    </td>
                    <td className="px-2 py-1.5">
                      <Hint
                        className="w-[250px]"
                        content={<HintText>该行价格数字的币种；人民币价会按汇率折成美元参与计算。</HintText>}
                      >
                        <select
                          className="rounded-md border border-border bg-background px-1.5 py-1 text-xs"
                          value={r.currency}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            update(i, "currency", e.target.value as Row["currency"]);
                            refreshEstimate();
                          }}
                        >
                          <option value="usd">$</option>
                          <option value="cny">¥</option>
                        </select>
                      </Hint>
                    </td>
                    {(["input", "output", "cacheRead", "cacheWrite"] as const).map((f) => (
                      <td key={f} className={CELL}>
                        <input
                          className={PRICE_INPUT}
                          type="number"
                          min="0"
                          step="0.01"
                          value={r[f]}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => update(i, f, e.target.value)}
                          onBlur={commitOnBlur}
                          onKeyDown={commitOnEnter}
                        />
                      </td>
                    ))}
                    <td className="px-2 py-1.5 text-center">
                      <ToggleBtn
                        active={r.peakEnabled}
                        label="峰谷"
                        hint={
                          r.peakEnabled
                            ? `已启用：峰时段单价 = 谷时价 × ${r.peakMultiplier}（点击停用）`
                            : "启用峰时段加价"
                        }
                        onClick={() => {
                          update(i, "peakEnabled", !r.peakEnabled);
                          refreshEstimate();
                        }}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <ToggleBtn
                        active={r.longEnabled}
                        label="长上下文"
                        hint={r.longEnabled ? "已启用长上下文加价（点击停用）" : "启用长上下文加价"}
                        onClick={() => {
                          update(i, "longEnabled", !r.longEnabled);
                          refreshEstimate();
                        }}
                      />
                    </td>
                    <Hint
                      className="w-[270px]"
                      content={
                        <HintText>
                          按当前时间范围内的用量与编辑中的价格估算（未保存也生效）；币种跟随该行的币种设置。
                        </HintText>
                      }
                    >
                      <td className={cn(CELL, "text-muted-foreground")}>
                        {r.modelId.trim() ? (r.est == null ? "…" : fmtCostIn(r.est, r.currency)) : "—"}
                      </td>
                    </Hint>
                  </tr>
                  {open && (
                    <tr className="border-b border-border/40 bg-muted/25">
                      <td colSpan={9} className="px-2 py-2">
                        <div className="flex flex-col gap-2 pl-6 text-xs">
                          <div className={cn("flex flex-wrap items-center gap-2", !r.peakEnabled && "opacity-50")}>
                            <span className="w-16 font-medium text-foreground">峰谷定价</span>
                            <label className="flex items-center gap-1.5 text-muted-foreground">
                              峰时段单价 ×
                              <input
                                className={PRICE_INPUT}
                                type="number"
                                min="1"
                                step="0.1"
                                disabled={!r.peakEnabled}
                                value={r.peakMultiplier}
                                onChange={(e) => update(i, "peakMultiplier", e.target.value)}
                                onBlur={commitOnBlur}
                                onKeyDown={commitOnEnter}
                              />
                            </label>
                            <div className="flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5">
                              {([
                                ["peak", "峰"],
                                ["offPeak", "谷"],
                              ] as const).map(([k, label]) => (
                                <Hint
                                  key={k}
                                  className="w-[230px]"
                                  content={
                                    <HintText>
                                      {k === "peak" ? "下列时段是峰时段，其余为谷。" : "下列时段是谷时段，其余为峰。"}
                                    </HintText>
                                  }
                                >
                                  <button
                                    className={cn(
                                      "rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50",
                                      r.peakKind === k
                                        ? "bg-primary text-primary-foreground"
                                        : "text-muted-foreground hover:text-foreground",
                                    )}
                                    disabled={!r.peakEnabled}
                                    onClick={() => switchPeakKind(i, k)}
                                  >
                                    {label}
                                  </button>
                                </Hint>
                              ))}
                            </div>
                            <span className="text-muted-foreground">{r.peakKind === "offPeak" ? "谷" : "峰"}时段</span>
                            {r.peakWindows.map((w, wi) => (
                              <span key={wi} className="flex items-center gap-1">
                                <TimeInput
                                  value={w.startMin}
                                  disabled={!r.peakEnabled}
                                  onChange={(v) => patchWindow(i, wi, { startMin: v })}
                                />
                                <span className="text-muted-foreground">–</span>
                                <TimeInput
                                  value={w.endMin}
                                  disabled={!r.peakEnabled}
                                  onChange={(v) => patchWindow(i, wi, { endMin: v })}
                                />
                                <Hint className="w-[180px]" content={<HintText>删除该时段</HintText>}>
                                  <button
                                    className="rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                    disabled={!r.peakEnabled}
                                    onClick={() => setWindows(i, r.peakWindows.filter((_, j) => j !== wi))}
                                  >
                                    ✕
                                  </button>
                                </Hint>
                              </span>
                            ))}
                            <Hint className="w-[180px]" content={<HintText>添加一个时段</HintText>}>
                              <button
                                className="rounded-md border border-border bg-background px-2 py-1 text-[11px] transition-colors hover:bg-muted disabled:opacity-50"
                                disabled={!r.peakEnabled}
                                onClick={() => setWindows(i, [...r.peakWindows, { startMin: 0, endMin: 0 }])}
                              >
                                + 时段
                              </button>
                            </Hint>
                            {r.peakWindows.some(isBadWindow) && (
                              <span className="text-[11px] text-warn">结束时间需晚于开始时间</span>
                            )}
                          </div>
                          <div className={cn("flex flex-wrap items-center gap-3", !r.longEnabled && "opacity-50")}>
                            <span className="w-16 font-medium text-foreground">长上下文</span>
                            <label className="flex items-center gap-1.5 text-muted-foreground">
                              单次请求输入 ≥
                              <input
                                className={cn(PRICE_INPUT, "w-20")}
                                type="number"
                                min="0"
                                step="1000"
                                placeholder="270000"
                                disabled={!r.longEnabled}
                                value={r.longThreshold}
                                onChange={(e) => update(i, "longThreshold", e.target.value)}
                                onBlur={commitOnBlur}
                                onKeyDown={commitOnEnter}
                              />
                              tokens 时,全部单价 ×
                              <input
                                className={PRICE_INPUT}
                                type="number"
                                min="0"
                                step="0.1"
                                placeholder="2"
                                disabled={!r.longEnabled}
                                value={r.longMultiplier}
                                onChange={(e) => update(i, "longMultiplier", e.target.value)}
                                onBlur={commitOnBlur}
                                onKeyDown={commitOnEnter}
                              />
                            </label>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {rows.length === 0 && !error && (
              <tr>
                <td colSpan={9} className="px-2 py-8 text-center text-[13px] text-muted-foreground">
                  当前时间范围内没有使用过模型
                </td>
              </tr>
            )}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="text-[13px] font-medium">
                <td className="px-2 py-2 text-muted-foreground" colSpan={8}>
                  合计(当前时间范围,按编辑中的价格)
                </td>
                <Hint
                  align="end"
                  className="w-[280px]"
                  content={
                    <HintText>美元定价的模型合计（美元）· 人民币定价的模型合计（人民币）</HintText>
                  }
                >
                  <td className={cn(CELL, "text-foreground")}>
                    {fmtAmount(totals.cny * moneyRate(), "cny")} · {fmtAmount(totals.usd, "usd")}
                  </td>
                </Hint>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <div className="flex items-center gap-2 px-2 pt-3">
        <input
          className="w-56 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          placeholder="新增模型 ID,如 glm-5.3"
          value={newModel}
          onChange={(e) => setNewModel(e.target.value)}
        />
        <button
          className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
          onClick={() => {
            if (newModel.trim() && !rows.some((r) => r.modelId === newModel.trim())) {
              setRows([...rows, toRow(newModel.trim())]);
              refreshEstimate();
            }
            setNewModel("");
          }}
        >
          添加
        </button>
      </div>
      {error && <p className="px-2 pt-2 text-xs text-danger">{error}</p>}
      <div className="flex justify-end px-2 pt-3">
        <button
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={saving}
          onClick={save}
        >
          {saving ? "保存中…" : "保存单价"}
        </button>
      </div>
    </Panel>
  );
}

