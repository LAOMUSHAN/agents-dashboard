import { Fragment, useEffect, useRef, useState } from "react";
import type { RequestGroup, RequestRow } from "../../shared/types";
import { api, type Range } from "../api";
import {
  fmtCostIn,
  fmtCostSplit,
  fmtDuration,
  fmtNumber,
  fmtSeconds,
  fmtSpeed,
  fmtTimestamp,
  fmtTokens,
  isCnyCurrency,
  moneyRate,
} from "../format";
import { ChevronDown, ChevronRight, ScrollText } from "lucide-react";
import { Panel } from "./ui/panel";
import { StatusDot, type StatusKind } from "./ui/status-dot";
import { HitRatePill, StackBar, Waterfall } from "./ui/data-viz";
import { cn } from "@/lib/utils";

/** 每页根会话数；滚动到底自动追加下一页 */
const PAGE_SIZE = 10;

const isSubagentRow = (r: RequestRow) => r.taskType === "subagent_child";

const statusKind = (s: string): StatusKind =>
  s === "error" ? "error" : s === "cancelled" ? "cancelled" : s === "running" ? "running" : "completed";

const statusLabel = (s: string) =>
  s === "error" ? "失败" : s === "cancelled" ? "取消" : s === "running" ? "进行中" : "完成";

const TH = "px-2 py-2 text-[10.5px] font-medium tracking-[0.06em] text-muted-foreground whitespace-nowrap";
const TH_NUM = cn(TH, "text-right");
const TD = "px-2 py-1.5 text-[12px] whitespace-nowrap";
const TD_NUM = cn(TD, "text-right tabular-nums");

function groupStats(requests: RequestRow[]) {
  const input = requests.reduce((s, r) => s + r.inputTokens, 0);
  const output = requests.reduce((s, r) => s + r.outputTokens, 0);
  const cacheRead = requests.reduce((s, r) => s + r.cacheReadTokens, 0);
  const costUsd = requests.reduce((s, r) => (isCnyCurrency(r.currency) ? s : s + r.cost), 0);
  const costCny = requests.reduce((s, r) => (isCnyCurrency(r.currency) ? s + r.cost * moneyRate() : s), 0);
  const errors = requests.reduce((s, r) => s + (r.status === "error" ? 1 : 0), 0);
  const maxDuration = Math.max(...requests.map((r) => r.durationMs ?? 0), 1);
  const totalDuration = requests.reduce((s, r) => s + (r.durationMs ?? 0), 0);
  const maxTotal = Math.max(...requests.map((r) => r.inputTokens + r.outputTokens), 1);

  const models = [...new Set(requests.map((r) => r.modelId))];
  return { input, output, cacheRead, costUsd, costCny, errors, maxDuration, totalDuration, maxTotal , models };
}

export function RequestLog({ range }: { range: Range }) {
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
      .requests(range, p, PAGE_SIZE)
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
  }, [range]);

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
      <div className="rounded-lg">
        <table className="w-full table-fixed border-separate border-spacing-0">
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              <th className={cn(TH, "w-[22%] text-left")}>对话</th>
              <th className={cn(TH, "w-[11%] text-left")}>时间</th>
              <th className={cn(TH, "w-[13%] text-left")}>模型</th>
              <th className={cn(TH, "w-[13%] text-left")}>耗时</th>
              <th className={cn(TH, "w-[8%] text-center")}>命中率</th>
              <th className={cn(TH_NUM, "w-[15%]")}>Tokens</th>
              <th className={cn(TH_NUM, "w-[8%]")}>速度</th>
              <th className={cn(TH_NUM, "w-[5%]")}>首tok</th>
              <th className={cn(TH_NUM, "w-[5%]")}>费用</th>
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
                    <td className={cn(TD, "max-w-0")}>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="inline-flex w-3 shrink-0 items-center text-muted-foreground">
                          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </span>
                        <span className="min-w-0 truncate text-[12.5px] font-semibold" title={g.title ?? g.sessionId}>
                          {g.title ?? "(无标题会话)"}
                        </span>
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
                    <td className="max-w-0 px-2 py-2 font-mono text-[10.5px] text-muted-foreground">
                      <span className="block truncate">{first ? fmtTimestamp(first.startedAt) : "-"}</span>
                    </td>
                    <td className="max-w-0 px-2 py-2">
                      <div className="flex items-center gap-1 overflow-hidden">
                        {s.models.slice(0, 2).map((m) => (
                          <span
                            key={m}
                            className="truncate rounded bg-accent/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                            title={m}
                          >
                            {m}
                          </span>
                        ))}
                        {s.models.length > 2 && (
                          <span className="shrink-0 text-[10px] text-muted-foreground">+{s.models.length - 2}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-[11px] tabular-nums text-muted-foreground">
                      {fmtDuration(s.totalDuration)}
                    </td>
                    <td className="px-2 py-2 text-center">
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
                          max={s.maxTotal}
                         
                          className="w-full"
                        />
                      </div>
                    </td>
                    <td className={TD_NUM}>
                      <span className="text-muted-foreground/50">—</span>
                    </td>
                    <td className={TD_NUM}>
                      <span className="text-muted-foreground/50">—</span>
                    </td>
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
                          <td className={cn(TD, "max-w-0")}>
                            <div className={cn("flex min-w-0 items-center gap-1.5", child && "pl-3")}>
                              {child && <span className="h-3.5 w-px shrink-0 bg-clay/40" aria-hidden />}
                              <StatusDot kind={statusKind(r.status)} title={statusLabel(r.status)} />
                              <span className="font-mono text-[10px] text-muted-foreground/80 tabular-nums">
                                #{String(i + 1).padStart(2, "0")}
                              </span>
                            </div>
                          </td>
                          <td className="max-w-0 px-2 py-1.5 font-mono text-[10.5px] text-muted-foreground">
                            <span className="block truncate">{fmtTimestamp(r.startedAt)}</span>
                          </td>
                          <td className="max-w-0 px-2 py-1.5">
                            <span
                              className="block truncate rounded bg-accent/70 px-1.5 py-0.5 font-mono text-[10.5px]"
                              title={r.modelId}
                            >
                              {r.modelId}
                            </span>
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex flex-col gap-1">
                              <span className="text-[11.5px] tabular-nums">{fmtDuration(r.durationMs)}</span>
                              <Waterfall
                                durationMs={r.durationMs}
                                ttftMs={r.timeToFirstTokenMs}
                                maxMs={s.maxDuration}
                               
                              />
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <HitRatePill read={r.cacheReadTokens} input={r.inputTokens} />
                          </td>
                          <td className={TD_NUM}>
                            <div className="flex w-full flex-col items-end gap-1">
                              <span>{fmtTokens(tokenTotal)}</span>
                              <StackBar
                                segments={[
                                  { value: r.cacheReadTokens, color: "var(--cds-clay)" },
                                  { value: Math.max(r.inputTokens - r.cacheReadTokens, 0), color: "var(--cds-orange-250)" },
                                  { value: r.outputTokens, color: "var(--cds-gray-400)" },
                                ]}
                                max={s.maxTotal}
                               
                                className="w-full"
                              />
                            </div>
                          </td>
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




