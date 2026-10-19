import { Fragment, useMemo, useState } from "react";
import type { ModelStat, ProjectStat, ProviderStat } from "../../shared/types";
import { fmtCostIn, fmtCostSplit, fmtNumber, fmtSeconds, fmtSpeed, fmtTokens } from "../format";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Panel } from "./ui/panel";
import { Segmented } from "./ui/segmented";
import { StatBadge } from "./ui/stat-badge";
import { HitRatePill, MiniBar, StackBar } from "./ui/data-viz";
import { cn } from "@/lib/utils";

type Dim = "provider" | "model" | "project";

const DIMS: { value: Dim; label: string }[] = [
  { value: "model", label: "按模型" },
  { value: "provider", label: "按供应商" },
  { value: "project", label: "按项目" },
];

const HEAD_LABEL: Record<Dim, string> = {
  provider: "供应商",
  model: "模型",
  project: "项目",
};

type Row = {
  key: string;
  label: string;
  title?: string;
  requests: number;
  sessions: number;
  cacheRead: number;
  input: number;
  output: number;
  total: number;
  speed: number | null;
  decode: number | null;
  ttft: number | null;
  cost: string;
  errors: number;
  priced?: boolean;
  children?: Row[];
};

const TH = "px-2 py-2 text-[10.5px] font-medium tracking-[0.06em] text-muted-foreground whitespace-nowrap";
const TH_NUM = cn(TH, "text-right");
const TD = "px-2 py-2 text-[12px] tabular-nums whitespace-nowrap";
const TD_NUM = cn(TD, "text-right");

const TOKEN_SEGMENTS = (r: Row) => [
  { value: r.cacheRead, color: "var(--cds-clay)" },
  { value: Math.max(r.input - r.cacheRead, 0), color: "var(--cds-orange-250)" },
  { value: r.output, color: "var(--cds-gray-400)" },
];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="text-[10px] tracking-[0.06em] text-muted-foreground">{label}</span>
      <span className="truncate text-[15px] font-semibold tabular-nums">{value}</span>
    </div>
  );
}

export function ProviderTable({
  stats,
  models,
  projects,
}: {
  stats: ProviderStat[];
  models: ModelStat[];
  projects: ProjectStat[];
}) {
  const [dim, setDim] = useState<Dim>("model");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const rows: Row[] = useMemo(() => {
    if (dim === "provider") {
      return stats.map((p) => ({
        key: p.providerId,
        label: p.name,
        title: p.providerId,
        requests: p.requests,
        sessions: p.sessions,
        cacheRead: p.cacheReadTokens,
        input: p.inputTokens,
        output: p.outputTokens,
        total: p.totalTokens,
        speed: p.tokensPerSec,
        decode: p.decodeTokensPerSec,
        ttft: p.avgTtftMs,
        cost: fmtCostSplit(p.costUsd, p.costCny),
        errors: p.errors,
        children: p.models.map((m) => ({
          key: `${p.providerId}/${m.modelId}`,
          label: m.modelId,
          requests: m.requests,
          sessions: m.sessions,
          cacheRead: m.cacheReadTokens,
          input: m.inputTokens,
          output: m.outputTokens,
          total: m.inputTokens + m.outputTokens,
          speed: m.tokensPerSec,
          decode: m.decodeTokensPerSec,
          ttft: m.avgTtftMs,
          cost: fmtCostIn(m.cost, m.currency),
          errors: 0,
        })),
      }));
    }
    if (dim === "model") {
      return models.map((m) => ({
        key: m.modelId,
        label: m.modelId,
        requests: m.requests,
        sessions: m.sessions,
        cacheRead: m.cacheReadTokens,
        input: m.inputTokens,
        output: m.outputTokens,
        total: m.inputTokens + m.outputTokens,
        speed: m.tokensPerSec,
        decode: m.decodeTokensPerSec,
        ttft: m.avgTtftMs,
        cost: fmtCostIn(m.cost, m.currency),
        errors: m.errors,
        priced: m.priced,
      }));
    }
    return projects.map((p) => ({
      key: p.directory,
      label: p.name,
      title: p.directory,
      requests: p.requests,
      sessions: p.sessions,
      cacheRead: p.cacheReadTokens,
      input: p.inputTokens,
      output: p.outputTokens,
      total: p.totalTokens,
      speed: p.tokensPerSec,
      decode: p.decodeTokensPerSec,
      ttft: p.avgTtftMs,
      cost: fmtCostSplit(p.costUsd, p.costCny),
      errors: p.errors,
    }));
  }, [dim, stats, models, projects]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (a, r) => ({
          requests: a.requests + r.requests,
          sessions: a.sessions + r.sessions,
          total: a.total + r.total,
          errors: a.errors + r.errors,
        }),
        { requests: 0, sessions: 0, total: 0, errors: 0 },
      ),
    [rows],
  );
  const maxRequests = Math.max(...rows.map((r) => r.requests), 1);
  const maxTotal = Math.max(...rows.map((r) => r.total), 1);


  const title = DIMS.find((d) => d.value === dim)?.label ?? "按供应商";

  return (
    <Panel title={title} actions={<Segmented value={dim} options={DIMS} onChange={setDim} />}>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 px-2 pb-3">
        <Stat label="请求" value={fmtNumber(totals.requests)} />
        <Stat label="会话" value={fmtNumber(totals.sessions)} />
        <Stat label="tokens" value={fmtTokens(totals.total)} />
        <Stat label="错误" value={fmtNumber(totals.errors)} />
        <span className="ml-auto hidden text-[11px] text-muted-foreground lg:inline">
          点击行展开模型明细 · 条形为组内占比
        </span>
      </div>

      <div className="rounded-lg">
        <table className="w-full table-fixed border-separate border-spacing-0">
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              <th className={cn(TH, "w-[26%] text-left")}>{HEAD_LABEL[dim]}</th>
              <th className={cn(TH_NUM, "w-[10%]")}>请求</th>
              <th className={cn(TH_NUM, "w-[7%]")}>会话</th>
              <th className={cn(TH, "w-[10%] text-center")}>命中率</th>
              <th className={cn(TH_NUM, "w-[15%]")}>Tokens</th>
              <th className={cn(TH_NUM, "w-[9%]")}>速度</th>
              <th className={cn(TH_NUM, "w-[7%]")}>首 tok</th>
              <th className={cn(TH_NUM, "w-[9%]")}>费用</th>
              <th className={cn(TH_NUM, "w-[7%]")}>错误</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const open = expanded.has(r.key);
              const expandable = Boolean(r.children?.length);
              return (
                <Fragment key={r.key}>
                  <tr
                    className={cn(
                      "group border-b border-border/50 transition-colors last:border-0",
                      expandable && "cursor-pointer",
                      "hover:bg-accent/40 hover:shadow-[inset_2px_0_0_var(--cds-clay)]",
                      open && "bg-accent/30",
                    )}
                    onClick={expandable ? () => toggle(r.key) : undefined}
                    title={r.title}
                  >
                    <td className={cn(TD, "max-w-0 text-left")}>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="inline-flex w-3 shrink-0 items-center text-muted-foreground">
                          {expandable ? (
                            open ? (
                              <ChevronDown size={12} />
                            ) : (
                              <ChevronRight size={12} />
                            )
                          ) : (
                            <span className="size-1 rounded-full bg-border" />
                          )}
                        </span>
                        <span className={cn("truncate font-medium", dim !== "project" && "font-mono text-[11.5px]")}>
                          {r.label}
                        </span>
                        {r.children && r.children.length > 0 && (
                          <span className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[10px] text-muted-foreground tabular-nums">
                            {r.children.length}
                          </span>
                        )}
                        {r.priced === false && <StatBadge tone="warn">未配置价格</StatBadge>}
                      </div>
                    </td>
                    <td className={TD_NUM}>
                      <div className="flex w-full flex-col items-end gap-1">
                        <span>{fmtNumber(r.requests)}</span>
                        <MiniBar value={r.requests} max={maxRequests} className="w-full" />
                      </div>
                    </td>
                    <td className={TD_NUM}>{fmtNumber(r.sessions)}</td>
                    <td className={cn(TD, "text-center")}>
                      <HitRatePill read={r.cacheRead} input={r.input} />
                    </td>
                    <td className={TD_NUM}>
                      <div className="flex w-full flex-col items-end gap-1">
                        <span>{fmtTokens(r.total)}</span>
                        <StackBar segments={TOKEN_SEGMENTS(r)} max={maxTotal} className="w-full" />
                      </div>
                    </td>
                    <td className={TD_NUM}>
                      <div className="flex flex-col items-end leading-tight">
                        <span>{fmtSpeed(r.speed)}</span>
                        <span className="text-[10px] text-muted-foreground">解 {fmtSpeed(r.decode)}</span>
                      </div>
                    </td>
                    <td className={TD_NUM}>{fmtSeconds(r.ttft)}</td>
                    <td className={TD_NUM}>{r.cost}</td>
                    <td className={TD_NUM}>
                      {r.errors > 0 ? (
                        <StatBadge tone="err">{fmtNumber(r.errors)}</StatBadge>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                  </tr>

                  {open &&
                    r.children?.map((c) => (
                      <tr
                        key={c.key}
                        className="border-b border-border/40 bg-accent/15 transition-colors last:border-0 hover:bg-accent/35"
                      >
                        <td className={cn(TD, "max-w-0 text-left")}>
                          <div className="flex min-w-0 items-center gap-1.5 pl-6">
                            <span className="h-3 w-px shrink-0 bg-clay/40" aria-hidden />
                            <span className="truncate font-mono text-[11px] text-muted-foreground">{c.label}</span>
                            {c.priced === false && <StatBadge tone="warn">未配置价格</StatBadge>}
                          </div>
                        </td>
                        <td className={TD_NUM}>
                          <div className="flex w-full flex-col items-end gap-1">
                            <span>{fmtNumber(c.requests)}</span>
                            <MiniBar value={c.requests} max={maxRequests} className="w-full" />
                          </div>
                        </td>
                        <td className={TD_NUM}>{fmtNumber(c.sessions)}</td>
                        <td className={cn(TD, "text-center")}>
                          <HitRatePill read={c.cacheRead} input={c.input} />
                        </td>
                        <td className={TD_NUM}>
                          <div className="flex w-full flex-col items-end gap-1">
                            <span>{fmtTokens(c.total)}</span>
                            <StackBar segments={TOKEN_SEGMENTS(c)} max={maxTotal} className="w-full" />
                          </div>
                        </td>
                        <td className={TD_NUM}>
                          <div className="flex flex-col items-end leading-tight">
                            <span>{fmtSpeed(c.speed)}</span>
                            <span className="text-[10px] text-muted-foreground">解 {fmtSpeed(c.decode)}</span>
                          </div>
                        </td>
                        <td className={TD_NUM}>{fmtSeconds(c.ttft)}</td>
                        <td className={TD_NUM}>{c.cost}</td>
                        <td className={TD_NUM}>
                          {c.errors > 0 ? (
                            <StatBadge tone="err">{fmtNumber(c.errors)}</StatBadge>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}

            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-2 py-12 text-center text-[13px] text-muted-foreground">
                  该时间范围内没有数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}









