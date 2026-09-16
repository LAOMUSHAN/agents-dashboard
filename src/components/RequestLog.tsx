import { Fragment, useEffect, useRef, useState } from "react";
import type { RequestGroup, RequestLogResponse, RequestRow } from "../../shared/types";
import { api, type Range } from "../api";
import { fmtCost, fmtDuration, fmtHitRate, fmtNumber, fmtSeconds, fmtTimestamp, fmtSpeed, fmtTokens } from "../format";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Panel } from "./ui/panel";
import { StatBadge } from "./ui/stat-badge";
import { cn } from "@/lib/utils";

/** 每页根会话数(分页单位是主会话分组,不是请求行) */
const PAGE_SIZE = 10;

const isSubagentRow = (r: RequestRow) => r.taskType === "subagent_child";

function groupStats(requests: RequestRow[]) {
  const input = requests.reduce((s, r) => s + r.inputTokens, 0);
  const output = requests.reduce((s, r) => s + r.outputTokens, 0);
  const cost = requests.reduce((s, r) => s + r.cost, 0);
  const cacheRead = requests.reduce((s, r) => s + r.cacheReadTokens, 0);
  const cacheCreate = requests.reduce((s, r) => s + r.cacheCreateTokens, 0);
  const duration = requests.reduce((s, r) => s + (r.durationMs ?? 0), 0);
  // 解码口径(deepseek harness):只有 TTFT 可用且 decode = duration − TTFT > 0 的行参与;
  // 另设流式门禁 decode ≥ output(隐含速度 ≤ 1000 tok/s),排除整包缓冲的非流式响应
  const decodeOk = (r: RequestRow) =>
    r.durationMs != null && r.timeToFirstTokenMs != null &&
    r.durationMs > r.timeToFirstTokenMs &&
    r.durationMs - r.timeToFirstTokenMs >= r.outputTokens;
  const decodeDuration = requests.reduce(
    (s, r) => s + (decodeOk(r) ? r.durationMs! - r.timeToFirstTokenMs! : 0),
    0,
  );
  const decodeOutput = requests.reduce((s, r) => s + (decodeOk(r) ? r.outputTokens : 0), 0);
  // 平均首 token 延迟:仅统计有 TTFT 的行
  const ttftRows = requests.filter((r) => r.timeToFirstTokenMs != null);
  const avgTtft =
    ttftRows.length > 0
      ? Math.round(ttftRows.reduce((s, r) => s + (r.timeToFirstTokenMs ?? 0), 0) / ttftRows.length)
      : null;
  const errors = requests.reduce((s, r) => s + (r.status === "error" ? 1 : 0), 0);
  const running = requests.some((r) => r.status === "running");
  const cancelled = requests.some((r) => r.status === "cancelled");
  const models = [...new Set(requests.map((r) => r.modelId))];
  return { input, output, cost, cacheRead, cacheCreate, duration, decodeDuration, decodeOutput, avgTtft, errors, running, cancelled, models };
}

const TH_NUM = "px-2 py-2 text-right text-[11px] font-medium text-muted-foreground whitespace-nowrap";
const TD_NUM = "px-2 py-1.5 text-right text-[13px] tabular-nums whitespace-nowrap";

/** 折叠态分组头:与展开行 13 列对齐,各列显示组级汇总 */
function GroupHead({ group, open }: { group: RequestGroup; open: boolean }) {
  const s = groupStats(group.requests);
  return (
    <>
      <td className="max-w-0 px-2 py-2">
        <div className="flex min-w-0 items-center">
          <span className="mr-1.5 inline-flex w-3 shrink-0 items-center text-muted-foreground">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
          <span className="truncate font-medium" title={group.title ?? group.sessionId}>
            {group.title ?? "(无标题会话)"}
          </span>
          <span className="ml-1.5 shrink-0 text-[11px] font-normal text-muted-foreground">
            {fmtNumber(group.requests.length)} 条
          </span>
        </div>
      </td>
      <td className="px-2 py-2 font-mono text-xs text-muted-foreground">
        {group.requests[0] ? fmtTimestamp(group.requests[0].startedAt) : "-"}
      </td>
      <td className="max-w-0 px-2 py-2">
        <span className="block truncate text-[13px] text-muted-foreground" title={s.models.join(", ")}>
          {s.models.join(", ")}
        </span>
      </td>
      <td className={TD_NUM}>{fmtDuration(s.duration)}</td>
      <td className={TD_NUM}>{fmtHitRate(s.cacheRead, s.input)}</td>
      <td className={TD_NUM}>{fmtTokens(s.input + s.output + s.cacheCreate)}</td>
      <td className={TD_NUM}>{fmtTokens(s.cacheRead)}</td>
      <td className={TD_NUM}>{fmtTokens(s.input)}</td>
      <td className={TD_NUM}>{fmtTokens(s.output)}</td>
      <td className={TD_NUM}>{fmtSpeed(s.duration > 0 ? s.output / (s.duration / 1000) : null)}</td>
      <td className={TD_NUM}>{fmtSpeed(s.decodeDuration > 0 ? s.decodeOutput / (s.decodeDuration / 1000) : null)}</td>
      <td className={TD_NUM}>{fmtSeconds(s.avgTtft)}</td>
      <td className={TD_NUM}>{fmtCost(s.cost)}</td>
    </>
  );
}

export function RequestLog({ range, reloadKey }: { range: Range; reloadKey: number }) {
  const [data, setData] = useState<RequestLogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  /** 默认全部收起,只展示会话分组头;点开的会话记在这里 */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    setPage(1);
    setExpanded(new Set());
  }, [range]);

  // 切换范围/翻页时才清空旧数据;定时刷新触发的 reload 保留旧数据,拿到新数据后原位替换,避免闪烁
  const prevQueryRef = useRef<{ range: Range; page: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const prev = prevQueryRef.current;
    prevQueryRef.current = { range, page };
    if (!prev || prev.range !== range || prev.page !== page) {
      setData(null);
      setError(null);
    }
    api.requests(range, page, PAGE_SIZE).then(
      (d) => {
        if (alive) setData(d);
      },
      (e) => {
        if (alive) setError(String(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [range, page, reloadKey]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  const toggleGroup = (sessionId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });

  const emptyState = (text: string) => (
    <tr>
      <td colSpan={13} className="px-2 py-10 text-center text-[13px] text-muted-foreground">
        {text}
      </td>
    </tr>
  );

  return (
    <Panel title="请求日志" sub={data ? `${fmtNumber(data.total)} 个会话` : undefined}>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-separate border-spacing-0 whitespace-nowrap">
          <thead>
            <tr className="border-b border-border">
              <th className="w-[13%] px-2 py-2 text-left text-[11px] font-medium text-muted-foreground">对话名称</th>
              <th className="w-[10.5%] px-2 py-2 text-left text-[11px] font-medium text-muted-foreground">时间</th>
              <th className="w-[13%] px-2 py-2 text-left text-[11px] font-medium text-muted-foreground">模型</th>
              <th className={cn(TH_NUM, "w-[5.5%]")}>耗时</th>
              <th className={cn(TH_NUM, "w-[5.5%]")}>命中率</th>
              <th className={cn(TH_NUM, "w-[5.5%]")}>总 token</th>
              <th className={cn(TH_NUM, "w-[5%]")}>缓存读</th>
              <th className={cn(TH_NUM, "w-[5%]")}>输入</th>
              <th className={cn(TH_NUM, "w-[5%]")}>输出</th>
              <th className={cn(TH_NUM, "w-[5%]")}>总速度</th>
              <th className={cn(TH_NUM, "w-[5%]")}>解码速度</th>
              <th className={cn(TH_NUM, "w-[5%]")}>首tok</th>
              <th className={cn(TH_NUM, "w-[5%]")}>费用</th>
            </tr>
          </thead>
          <tbody>
            {(data?.groups ?? []).map((g) => {
              const open = expanded.has(g.sessionId);
              return (
                <Fragment key={g.sessionId}>
                  <tr
                    className={cn(
                      "cursor-pointer border-b border-border/60 bg-muted/30 transition-colors hover:bg-muted/50",
                      open && "bg-muted/50",
                    )}
                    onClick={() => toggleGroup(g.sessionId)}
                  >
                    <GroupHead group={g} open={open} />
                  </tr>
                  {open &&
                    g.requests.map((r) => {
                      const child = isSubagentRow(r);
                      return (
                        <tr key={r.id} className={cn("border-b border-border/40 transition-colors last:border-0 hover:bg-muted/40", child && "bg-muted/15")}>
                          <td className="max-w-0 px-2 py-1.5">
                            <span className="block truncate text-[13px]" title={r.title ?? ""}>
                              {r.title ?? "-"}
                            </span>
                          </td>
                          <td className={cn("px-2 py-1.5 font-mono text-xs", child ? "pl-5 text-muted-foreground" : "text-muted-foreground")}>
                            <span className="block truncate">
                              {child && <span className="mr-1">↳</span>}
                              {fmtTimestamp(r.startedAt)}
                            </span>
                          </td>
                          <td className="max-w-0 px-2 py-1.5">
                            <span className="block truncate font-mono text-xs" title={r.modelId}>
                              {r.modelId}
                            </span>
                          </td>
                          <td className={TD_NUM}>{fmtDuration(r.durationMs)}</td>
                          <td className={TD_NUM}>{fmtHitRate(r.cacheReadTokens, r.inputTokens)}</td>
                          <td className={TD_NUM}>{fmtTokens(r.inputTokens + r.outputTokens)}</td>
                          <td className={TD_NUM}>{fmtTokens(r.cacheReadTokens)}</td>
                          <td className={TD_NUM}>{fmtTokens(r.inputTokens)}</td>
                          <td className={TD_NUM}>{fmtTokens(r.outputTokens)}</td>
                          <td className={TD_NUM}>{fmtSpeed(r.tokensPerSec)}</td>
                          <td className={TD_NUM}>{fmtSpeed(r.decodeTokensPerSec)}</td>
                          <td className={TD_NUM}>{fmtSeconds(r.timeToFirstTokenMs)}</td>
                          <td className={TD_NUM}>{fmtCost(r.cost)}</td>
                        </tr>
                      );
                    })}
                </Fragment>
              );
            })}
            {!data && !error && emptyState("加载中…")}
            {error && emptyState(`加载失败:${error}`)}
            {data && data.groups.length === 0 && emptyState("该时间范围内没有数据")}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 py-3 text-[13px] text-muted-foreground">
          <button
            className="rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </button>
          <span className="tabular-nums">
            {page} / {totalPages}
          </span>
          <button
            className="rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </Panel>
  );
}
