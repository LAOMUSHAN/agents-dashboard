import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { RequestGroup, RequestRow, SourceFilter } from "../../shared/types";
import { api, type Range } from "../api";
import {
  fmtCostIn,
  fmtCostSplit,
  fmtNumber,
  fmtSeconds,
  fmtSpeed,
  fmtTokens,
  isCnyCurrency,
  moneyRate,
} from "../format";
import { ChevronDown, ChevronRight, ScrollText } from "lucide-react";
import { Panel } from "./ui/panel";
import { SourceBadge } from "./SourceBadge";
import { StatusDot, type StatusKind } from "./ui/status-dot";
import { HitRatePill, StackBar, Waterfall } from "./ui/data-viz";
import { cn } from "@/lib/utils";

/** 每页根会话数；滚动到底自动追加下一页 */
const PAGE_SIZE = 10;

/** 标题列的最小宽度：箭头 + 计数徽章 + 能看清标题开头的一段 */
const TITLE_MIN = 112;
/** 时间列的最小宽度：只保留「月-日」，分秒可以截断，日期不许截断 */
const TIME_MIN = 48;
/** Tokens 条的理想宽度；空间不够时先压条，再动时间列 */
const TOKEN_BAR_MIN = 90;

const isSubagentRow = (r: RequestRow) => r.taskType === "subagent_child";

const statusKind = (s: string): StatusKind =>
  s === "error" ? "error" : s === "cancelled" ? "cancelled" : s === "running" ? "running" : "completed";

const statusLabel = (s: string) =>
  s === "error" ? "失败" : s === "cancelled" ? "取消" : s === "running" ? "进行中" : "完成";

// 对齐规则（与「用量明细」表一致）：标识类文本左对齐，量值类数字右对齐。
// 居中是第三种锚点，会让行尾出现一条参差的扫描线，这里不使用。
const TH = "px-2 py-2 text-[10.5px] font-medium tracking-[0.06em] text-muted-foreground whitespace-nowrap";
const TH_NUM = cn(TH, "text-right");
const TD = "px-2 py-1.5 text-[12px] whitespace-nowrap";
const TD_NUM = cn(TD, "text-right tabular-nums");

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * 耗时固定格式：分秒各两位，单位 m / s 永远落在同一条竖线上。
 * 范围里出现 ≥1 小时的耗时后切到「时」模式：时槽固定 3ch，m/s 位置不变；
 * 不足 1 小时的行留空槽，不显示 0h，但槽宽保留。
 */
function Duration({ ms, withHours }: { ms: number | null | undefined; withHours: boolean }) {
  if (ms == null || !isFinite(ms)) return <span className="text-muted-foreground/60">—</span>;
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return (
    <span className="inline-flex items-baseline tabular-nums">
      {withHours && <span className="inline-block w-[3ch] text-right">{h > 0 ? `${h}h` : ""}</span>}
      <span>{pad2(m)}m</span>
      <span>{pad2(s)}s</span>
    </span>
  );
}

/**
 * 时间单元格：日期固定不缩，时间按「秒 → 分 → 时」分段截断。
 * 三段都渲染出来，由表格上的 time-l1/l2/l3 类决定隐藏到哪一段；
 * 隐藏测量时去掉这些类，量的始终是完整时间戳的宽度。
 */
function TimeCell({ startedAt }: { startedAt: number }) {
  const d = new Date(startedAt);
  return (
    <div className="flex min-w-0 items-baseline gap-1 font-mono text-[10.5px] text-muted-foreground">
      <span className="shrink-0">
        {pad2(d.getMonth() + 1)}-{pad2(d.getDate())}
      </span>
      <span className="time-wrap min-w-0 truncate">
        <span className="time-hh">{pad2(d.getHours())}</span>
        <span className="time-mm">:{pad2(d.getMinutes())}</span>
        <span className="time-ss">:{pad2(d.getSeconds())}</span>
      </span>
    </div>
  );
}

function groupStats(requests: RequestRow[]) {
  const input = requests.reduce((s, r) => s + r.inputTokens, 0);
  const output = requests.reduce((s, r) => s + r.outputTokens, 0);
  const cacheRead = requests.reduce((s, r) => s + r.cacheReadTokens, 0);
  const costUsd = requests.reduce((s, r) => (isCnyCurrency(r.currency) ? s : s + r.cost), 0);
  const costCny = requests.reduce((s, r) => (isCnyCurrency(r.currency) ? s + r.cost * moneyRate() : s), 0);
  const errors = requests.reduce((s, r) => s + (r.status === "error" ? 1 : 0), 0);
  const maxDuration = Math.max(...requests.map((r) => r.durationMs ?? 0), 1);
  const totalDuration = requests.reduce((s, r) => s + (r.durationMs ?? 0), 0);

  // 分组行的速度/首 tok：与后端 weighted_tokens_per_sec 同口径，
  // 用 Σ输出tokens ÷ Σ耗时，而不是各行速度的平均（否则短请求会被严重高估）
  let outputAll = 0;
  let durationAll = 0;
  let decodeOutput = 0;
  let decodeDuration = 0;
  let ttftSum = 0;
  let ttftCount = 0;
  for (const r of requests) {
    outputAll += r.outputTokens;
    if (r.durationMs != null) durationAll += r.durationMs;
    // 解码门禁与后端 decode_ms_of 一致：剔除整包缓冲的非流式响应
    const decodeMs =
      r.durationMs != null && r.timeToFirstTokenMs != null ? r.durationMs - r.timeToFirstTokenMs : null;
    if (decodeMs != null && decodeMs > 0 && decodeMs >= r.outputTokens) {
      decodeOutput += r.outputTokens;
      decodeDuration += decodeMs;
    }
    if (r.timeToFirstTokenMs != null) {
      ttftSum += r.timeToFirstTokenMs;
      ttftCount += 1;
    }
  }

  const models = [...new Set(requests.map((r) => r.modelId))];
  return {
    input,
    output,
    cacheRead,
    costUsd,
    costCny,
    errors,
    maxDuration,
    totalDuration,
    models,
    speed: durationAll > 0 ? outputAll / (durationAll / 1000) : null,
    decode: decodeDuration > 0 ? decodeOutput / (decodeDuration / 1000) : null,
    ttft: ttftCount > 0 ? ttftSum / ttftCount : null,
  };
}

export function RequestLog({ range, source }: { range: Range; source: SourceFilter }) {
  const [groups, setGroups] = useState<RequestGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const seq = useRef(0);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const load = (p: number, replace: boolean) => {
    const my = ++seq.current;
    loadingRef.current = true;
    setLoading(true);
    api
      .requests(range, p, PAGE_SIZE, source)
      .then(
        (d) => {
          if (my !== seq.current) return;
          setTotal(d.total);
          setGroups((prev) => (replace ? d.groups : [...prev, ...d.groups]));
          setDone(p * PAGE_SIZE >= d.total);
        },
        (e) => {
          if (my === seq.current) setError(String(e));
        },
      )
      .finally(() => {
        if (my !== seq.current) return;
        loadingRef.current = false;
        setLoading(false);
      });
  };

  // 切换范围：回到第一页并替换列表。定时刷新不再重置列表，避免每 5 秒闪一次。
  useEffect(() => {
    setExpanded(new Set());
    setPage(1);
    setGroups([]);
    setDone(false);
    setError(null);
    load(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, source]);

  // 追加下一页
  useEffect(() => {
    if (page > 1) load(page, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // 滚动到底自动加载：不显示页码按钮，只保留页面滚动条
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || done || loading) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loadingRef.current) {
          setPage((p) => p + 1);
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [done, loading, groups.length]);

  const toggleGroup = (sessionId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });

  // 已加载数据里是否出现 ≥1 小时的耗时：决定「时」槽要不要占位。
  // 按已显示的请求日志算宽度——不预先按整个时间范围撑开，往下加载时再跟着长。
  const withHours = useMemo(() => {
    let max = 0;
    for (const g of groups) {
      let sum = 0;
      for (const r of g.requests) {
        sum += r.durationMs ?? 0;
        max = Math.max(max, r.durationMs ?? 0);
      }
      max = Math.max(max, sum);
    }
    return max >= 3600_000;
  }, [groups]);

  // token 长条的公共标尺：已加载数据里最大的会话总量。
  // 与「用量明细」同一套 barScale(asinh) 压缩，组头之间才可比。
  const maxTotal = useMemo(
    () =>
      Math.max(
        1,
        ...groups.map((g) => g.requests.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0)),
      ),
    [groups],
  );

  // ---- 列宽：内容决定，固定列不压缩，时间列按「日期固定、分秒先截」让步 ----
  const tableRef = useRef<HTMLTableElement>(null);
  const naturalRef = useRef<number[] | null>(null);
  // 模型列两种模式的自然宽：完整（最多 2 枚 chip）/ 窄窗（1 枚 chip + N）
  const modelNatRef = useRef<{ full: number; compact: number } | null>(null);
  const [colW, setColW] = useState<number[] | null>(null);
  const [tableMinW, setTableMinW] = useState<number | undefined>();
  // 窄窗时模型列只完整显示一枚 chip（第二枚由 CSS 隐藏，+N 改成 n−1）
  const [modelCompact, setModelCompact] = useState(false);
  // 时间列的截断档位：0 完整 / 1 到分 / 2 到时 / 3 仅日期
  const [timeLevel, setTimeLevel] = useState(0);
  // 宽窗余量均分成的列间距（px）：只加到第 2 列起的左内边距上，首列左缘不动
  const [colGap, setColGap] = useState(0);

  const allocate = useCallback(() => {
    const table = tableRef.current;
    const nat = naturalRef.current;
    if (!table || !nat || nat.length < 9) return;
    const container = table.parentElement;
    const W = container?.clientWidth ?? table.getBoundingClientRect().width;
    const timeNat = nat[1];
    // 首 tok 的保底宽度 = 已加载数据里最长的 tokens 数字宽度（nat[5] 正是该数字 + 内边距）
    const ttftW = Math.max(nat[7], nat[5]);
    // 模型列：完整两枚 chip → 窄窗一枚 chip + N
    const modelFull = nat[2];
    const modelMin = modelNatRef.current?.compact ?? modelFull;
    // 除模型外的固定列：耗时、命中率、速度、首 tok、费用
    const fixedRest = nat[3] + nat[4] + nat[6] + ttftW + nat[8];
    const tokensNat = Math.max(nat[5], TOKEN_BAR_MIN + 16);
    const tokensMin = nat[5];
    let model = modelFull;
    let tokens = tokensNat;
    let time = timeNat;
    let title = W - fixedRest - model - tokens - time;

    // 余量不再全给「对话」列：
    //  - 对话正文放得下时按自然宽（不截断），余量全变成间距；
    //  - 放不下时对话最多拿余量的 70%，其余 30% 均分成 8 个列间距；
    //  - 连 112px 下限都保不住时走下面的压缩级联。
    const titleNat = nat[0];
    let gap = 0;
    if (title >= TITLE_MIN) {
      const target = Math.min(titleNat, Math.max(TITLE_MIN, title * 0.7));
      gap = (title - target) / 8;
      title = target;
    }
    setColGap(gap > 0.5 ? gap : 0);
    if (gap > 0.5) {
      setModelCompact(false);
      setTimeLevel(0);
      setTableMinW(undefined);
      setColW([
        title,
        time + gap,
        model + gap,
        nat[3] + gap,
        nat[4] + gap,
        tokens + gap,
        nat[6] + gap,
        ttftW + gap,
        nat[8] + gap,
      ]);
      return;
    }

    // 0) 标题放不下时，模型列先退到「1 枚 chip + N」——保证至少一枚模型完整可见
    if (title < TITLE_MIN && model > modelMin) {
      const give = Math.min(TITLE_MIN - title, model - modelMin);
      model -= give;
      title += give;
    }
    setModelCompact(model < modelFull - 0.5);
    // 1) 还放不下，压 Tokens 的条（不丢数据）
    if (title < TITLE_MIN && tokens > tokensMin) {
      const give = Math.min(TITLE_MIN - title, tokens - tokensMin);
      tokens -= give;
      title += give;
    }
    // 2) 还不够就按「时间分段」让步：完整 → 到分 → 到时 → 仅日期。
    //    选标题保住下限前提下能放下的最高一档，避免半个数字的省略号。
    const levelWidth = (avail: number) =>
      avail >= timeNat - 2 ? timeNat : avail >= 82 ? 82.5 : avail >= 64 ? 64 : TIME_MIN;
    if (title < TITLE_MIN) {
      time = levelWidth(W - fixedRest - model - tokens - TITLE_MIN);
      title = W - fixedRest - model - tokens - time;
    }
    // 3) 到地板：所有列都压到极限，表格给最小宽度，窗口不能再窄
    const floor = fixedRest + modelMin + tokensMin + TIME_MIN + TITLE_MIN;
    if (title < TITLE_MIN) {
      title = TITLE_MIN;
      time = TIME_MIN;
      tokens = tokensMin;
      model = modelMin;
      setModelCompact(true);
    }
    setTableMinW(W < floor ? floor : undefined);
    setTimeLevel(time >= timeNat - 2 ? 0 : time >= 82 ? 1 : time >= 64 ? 2 : 3);
    setColW([title, time, model, nat[3], nat[4], tokens, nat[6], ttftW, nat[8]]);
  }, []);

  // 用一份隐藏的 auto 布局副本量每列的自然宽度：width:max-content 保证不被挤压。
  // 模型列量两次：去掉/加上 model-compact 类，分别得到「两枚 chip」和「一枚 chip + N」的宽度。
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const clone = table.cloneNode(true) as HTMLTableElement;
    clone.querySelector("colgroup")?.remove();
    clone.removeAttribute("style");
    clone.style.position = "absolute";
    clone.style.left = "-9999px";
    clone.style.top = "0";
    clone.style.visibility = "hidden";
    clone.style.tableLayout = "auto";
    clone.style.width = "max-content";
    clone.style.pointerEvents = "none";
    document.body.appendChild(clone);
    const thWidths = () => [...clone.querySelectorAll("thead th")].map((th) => th.getBoundingClientRect().width);
    clone.classList.remove("time-l1", "time-l2", "time-l3");
    clone.classList.remove("model-compact");
    const full = thWidths();
    clone.classList.add("model-compact");
    const compact = thWidths();
    clone.remove();
    naturalRef.current = full;
    modelNatRef.current = { full: full[2], compact: compact[2] };
    allocate();
  }, [groups, expanded, withHours, allocate]);

  // 容器变宽变窄：自然宽度不变，只重算模型/时间/标题的分配
  useEffect(() => {
    const el = tableRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => allocate());
    ro.observe(el);
    return () => ro.disconnect();
  }, [allocate]);

  const emptyState = (text: string, icon = false) => (
    <tr>
      <td colSpan={9} className="px-2 py-14">
        <div className="flex flex-col items-center gap-2 text-[13px] text-muted-foreground">
          {icon && <ScrollText size={18} className="opacity-50" />}
          {text}
        </div>
      </td>
    </tr>
  );

  return (
    <Panel
      title="请求日志"
      sub={total > 0 ? `${fmtNumber(total)} 个会话 · 已加载 ${fmtNumber(groups.length)} 个` : undefined}
    >
      {/* -mx-1 让首列的 8px 单元格内边距从 20px 回到 16px，与面板标题同一条左缘。
          宽度重算有一帧滞后：收窄窗口时旧列宽会短暂溢出，若这里常开 overflow-x-auto
          就会闪一下横向滚动条；只有列宽地板（表格确实放不下）时才允许滚动。 */}
      <div className={cn("-mx-1", tableMinW ? "overflow-x-auto" : "overflow-hidden")}>
        <table
          ref={tableRef}
          className={cn(
            "col-gap w-full table-fixed border-separate border-spacing-0",
            modelCompact && "model-compact",
            timeLevel > 0 && `time-l${timeLevel}`,
          )}
          style={
            {
              ...(tableMinW ? { minWidth: tableMinW } : {}),
              "--col-gap": `${colGap}px`,
            } as CSSProperties
          }
        >
          {colW && (
            <colgroup>
              {colW.map((w, i) => (
                <col key={i} style={{ width: `${w}px` }} />
              ))}
            </colgroup>
          )}
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              <th className={cn(TH, "text-left")}>对话</th>
              <th className={cn(TH, "text-left")}>时间</th>
              <th className={cn(TH, "text-left")}>模型</th>
              <th className={TH_NUM}>耗时</th>
              <th className={cn(TH_NUM, "text-center")}>命中率</th>
              <th className={TH_NUM}>Tokens</th>
              <th className={TH_NUM}>速度</th>
              <th className={TH_NUM}>首 tok</th>
              <th className={TH_NUM}>费用</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const open = expanded.has(g.sessionId);
              const s = groupStats(g.requests);
              const first = g.requests[0];
              return (
                <Fragment key={g.sessionId}>
                  <tr
                    className={cn(
                      "cursor-pointer border-b border-border/50 transition-colors",
                      "hover:bg-accent/40 hover:shadow-[inset_2px_0_0_var(--cds-clay)]",
                      open && "bg-accent/30",
                    )}
                    onClick={() => toggleGroup(g.sessionId)}
                  >
                    <td className={TD}>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="inline-flex w-3 shrink-0 items-center text-muted-foreground">
                          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </span>
                        <span
                          className="min-w-0 truncate text-[12.5px] font-semibold"
                          title={g.title ?? g.sessionId}
                        >
                          {g.title ?? "(无标题会话)"}
                        </span>
                        <SourceBadge source={g.source} className="shrink-0" />
                        <span className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[10px] text-muted-foreground tabular-nums">
                          {fmtNumber(g.requests.length)}
                        </span>
                        {s.errors > 0 && (
                          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-danger tabular-nums">
                            <StatusDot kind="error" />
                            {s.errors}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      {first ? (
                        <TimeCell startedAt={first.startedAt} />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1">
                        {s.models.slice(0, 2).map((m, i) => (
                          <span
                            key={m}
                            className={cn(
                              "shrink-0 whitespace-nowrap rounded bg-accent/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground",
                              i === 1 && "model-chip-2",
                            )}
                            title={m}
                          >
                            {m}
                          </span>
                        ))}
                        {s.models.length > 1 && (
                          <span
                            className={cn(
                              "shrink-0 text-[10px] text-muted-foreground",
                              s.models.length === 2 && "hidden model-plus-when-compact",
                            )}
                          >
                            +{s.models.length - (modelCompact ? 1 : 2)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={cn(TD_NUM, "text-[11.5px] text-muted-foreground")}>
                      <Duration ms={s.totalDuration} withHours={withHours} />
                    </td>
                    <td className={cn(TD, "text-center")}>
                      <HitRatePill read={s.cacheRead} input={s.input} />
                    </td>
                    <td className={TD_NUM}>
                      <div className="flex w-full flex-col items-end gap-1">
                        <span>{fmtTokens(s.input + s.output)}</span>
                        <StackBar
                          segments={[
                            { value: s.cacheRead, color: "var(--cds-clay)" },
                            { value: Math.max(s.input - s.cacheRead, 0), color: "var(--cds-orange-250)" },
                            { value: s.output, color: "var(--cds-gray-400)" },
                          ]}
                          max={maxTotal}
                          className="w-full"
                        />
                      </div>
                    </td>
                    <td className={TD_NUM}>
                      <div className="flex flex-col items-end leading-tight">
                        <span>{fmtSpeed(s.speed)}</span>
                        <span className="text-[10px] text-muted-foreground">解 {fmtSpeed(s.decode)}</span>
                      </div>
                    </td>
                    <td className={TD_NUM}>{fmtSeconds(s.ttft)}</td>
                    <td className={TD_NUM}>{fmtCostSplit(s.costUsd, s.costCny)}</td>
                  </tr>

                  {open &&
                    g.requests.map((r, i) => {
                      const child = isSubagentRow(r);
                      const tokenTotal = r.inputTokens + r.outputTokens;
                      return (
                        <tr
                          key={r.id}
                          className={cn(
                            "border-b border-border/40 transition-colors last:border-0",
                            "hover:bg-accent/35 hover:shadow-[inset_2px_0_0_var(--cds-clay)]",
                            child && "bg-accent/15",
                          )}
                        >
                          <td className={TD}>
                            <div className={cn("flex min-w-0 items-center gap-1.5", child && "pl-3")}>
                              {child && <span className="h-3.5 w-px shrink-0 bg-clay/40" aria-hidden />}
                              <StatusDot kind={statusKind(r.status)} title={statusLabel(r.status)} />
                              <span className="font-mono text-[10px] text-muted-foreground/80 tabular-nums">
                                #{String(i + 1).padStart(2, "0")}
                              </span>
                            </div>
                          </td>
                          <td className="px-2 py-1.5">
                            <TimeCell startedAt={r.startedAt} />
                          </td>
                          <td className="px-2 py-1.5">
                            <span
                              className="inline-block whitespace-nowrap rounded bg-accent/70 px-1.5 py-0.5 font-mono text-[10.5px]"
                              title={r.modelId}
                            >
                              {r.modelId}
                            </span>
                          </td>
                          <td className={TD_NUM}>
                            <div className="flex flex-col items-end gap-1">
                              <span className="text-[11.5px]">
                                <Duration ms={r.durationMs} withHours={withHours} />
                              </span>
                              <Waterfall durationMs={r.durationMs} ttftMs={r.timeToFirstTokenMs} maxMs={s.maxDuration} />
                            </div>
                          </td>
                          <td className={cn(TD, "text-center")}>
                            <HitRatePill read={r.cacheReadTokens} input={r.inputTokens} />
                          </td>
                          {/* 组内请求与组头差 2 个数量级：同一绝对标尺下条长不足 1px，
                              改为只显示数值；跨会话的量级比较由组头的长条承担 */}
                          <td className={TD_NUM}>{fmtTokens(tokenTotal)}</td>
                          <td className={TD_NUM}>
                            <div className="flex flex-col items-end leading-tight">
                              <span>{fmtSpeed(r.tokensPerSec)}</span>
                              <span className="text-[10px] text-muted-foreground">解 {fmtSpeed(r.decodeTokensPerSec)}</span>
                            </div>
                          </td>
                          <td className={TD_NUM}>{fmtSeconds(r.timeToFirstTokenMs)}</td>
                          <td className={TD_NUM}>{fmtCostIn(r.cost, r.currency)}</td>
                        </tr>
                      );
                    })}
                </Fragment>
              );
            })}
            {loading &&
              groups.length === 0 &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  <td colSpan={9} className="px-2 py-2">
                    <div className="h-4 w-full animate-pulse rounded bg-accent/60" />
                  </td>
                </tr>
              ))}
            {!loading && groups.length === 0 && !error && emptyState("该时间范围内没有数据", true)}
            {error && emptyState(`加载失败:${error}`)}
          </tbody>
        </table>
      </div>

      <div ref={sentinelRef} className="h-6" aria-hidden />
      {loading && <div className="py-2 text-center text-[11px] text-muted-foreground">加载中…</div>}
      {!done && !loading && groups.length > 0 && (
        <div className="py-2 text-center text-[11px] text-muted-foreground">向下滚动加载更多</div>
      )}
    </Panel>
  );
}
