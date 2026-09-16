import { Fragment, useState } from "react";
import type { ModelStat, ProjectStat, ProviderStat } from "../../shared/types";
import { fmtCost, fmtHitRate, fmtNumber, fmtSeconds, fmtSpeed, fmtTokens } from "../format";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Panel } from "./ui/panel";
import { StatBadge } from "./ui/stat-badge";
import { cn } from "@/lib/utils";

type Dim = "provider" | "model" | "project";

const DIMS: { value: Dim; label: string }[] = [
  { value: "provider", label: "按供应商" },
  { value: "model", label: "按模型" },
  { value: "project", label: "按项目" },
];

const HEAD_LABEL: Record<Dim, string> = {
  provider: "供应商",
  model: "模型",
  project: "项目",
};

const TH_NUM = "px-2 py-2 text-right text-[11px] font-medium text-muted-foreground whitespace-nowrap";
const TH_LEFT = "px-2 py-2 text-left text-[11px] font-medium text-muted-foreground whitespace-nowrap";
const TD_NUM = "px-2 py-1.5 text-right text-[13px] tabular-nums whitespace-nowrap";
const TD_LEFT = "px-2 py-1.5 text-left text-[13px] whitespace-nowrap";

function HeadRow({ label }: { label: string }) {
  return (
    <tr className="border-b border-border">
      <th className={TH_LEFT}>{label}</th>
      <th className={TH_NUM}>请求</th>
      <th className={TH_NUM}>会话</th>
      <th className={TH_NUM}>命中率</th>
      <th className={TH_NUM}>总 tokens</th>
      <th className={TH_NUM}>缓存读</th>
      <th className={TH_NUM}>输入</th>
      <th className={TH_NUM}>输出</th>
      <th className={TH_NUM}>总速度</th>
      <th className={TH_NUM}>解码速度</th>
      <th className={TH_NUM}>首tok</th>
      <th className={TH_NUM}>费用</th>
      <th className={TH_NUM}>错误</th>
    </tr>
  );
}

function ModelId({ id, priced }: { id: string; priced?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs">{id}</span>
      {priced === false && <StatBadge tone="warn">未配置价格</StatBadge>}
    </span>
  );
}

function EmptyRow({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-2 py-8 text-center text-[13px] text-muted-foreground">
        该时间范围内没有数据
      </td>
    </tr>
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
  const [dim, setDim] = useState<Dim>("provider");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const title = DIMS.find((d) => d.value === dim)?.label ?? "按供应商";

  return (
    <Panel
      title={title}
      actions={
        <div className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
          {DIMS.map((d) => (
            <button
              key={d.value}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                dim === d.value
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setDim(d.value)}
            >
              {d.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0">
          <thead>{<HeadRow label={HEAD_LABEL[dim]} />}</thead>
          <tbody>
            {dim === "provider" && (
              <>
                {stats.map((p) => (
                  <Fragment key={p.providerId}>
                    <tr
                      className={cn(
                        "cursor-pointer border-b border-border/60 transition-colors hover:bg-muted/50",
                        expanded.has(p.providerId) && "bg-muted/40",
                      )}
                      onClick={() => toggle(p.providerId)}
                      title={p.providerId}
                    >
                      <td className={TD_LEFT}>
                        <span className="mr-1 inline-flex w-3 items-center text-muted-foreground">
                          {expanded.has(p.providerId) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </span>
                        <span className="font-medium">{p.name}</span>
                        {p.models.length > 0 && (
                          <span className="ml-1.5 text-[11px] text-muted-foreground">({p.models.length} 模型)</span>
                        )}
                      </td>
                      <td className={TD_NUM}>{fmtNumber(p.requests)}</td>
                      <td className={TD_NUM}>{fmtNumber(p.sessions)}</td>
                      <td className={TD_NUM}>{fmtHitRate(p.cacheReadTokens, p.inputTokens)}</td>
                      <td className={TD_NUM}>{fmtTokens(p.totalTokens)}</td>
                      <td className={TD_NUM}>{fmtTokens(p.cacheReadTokens)}</td>
                      <td className={TD_NUM}>{fmtTokens(p.inputTokens)}</td>
                      <td className={TD_NUM}>{fmtTokens(p.outputTokens)}</td>
                      <td className={TD_NUM}>{fmtSpeed(p.tokensPerSec)}</td>
                      <td className={TD_NUM}>{fmtSpeed(p.decodeTokensPerSec)}</td>
                      <td className={TD_NUM}>{fmtSeconds(p.avgTtftMs)}</td>
                      <td className={TD_NUM}>{fmtCost(p.cost)}</td>
                      <td className={TD_NUM}>
                        {p.errors > 0 ? (
                          <StatBadge tone="err">{fmtNumber(p.errors)}</StatBadge>
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )}
                      </td>
                    </tr>
                    {expanded.has(p.providerId) && p.models.length > 0 && (
                      <tr className="border-b border-border/60 bg-muted/25">
                        <td colSpan={13} className="px-6 py-1">
                          <table className="w-full border-separate border-spacing-0">
                            <thead>{<HeadRow label="模型" />}</thead>
                            <tbody>
                              {p.models.map((m) => (
                                <tr key={m.modelId} className="border-b border-border/40 last:border-0">
                                  <td className={TD_LEFT}>
                                    <ModelId id={m.modelId} />
                                  </td>
                                  <td className={TD_NUM}>{fmtNumber(m.requests)}</td>
                                  <td className={TD_NUM}>{fmtNumber(m.sessions)}</td>
                                  <td className={TD_NUM}>{fmtHitRate(m.cacheReadTokens, m.inputTokens)}</td>
                                  <td className={TD_NUM}>{fmtTokens(m.totalTokens)}</td>
                                  <td className={TD_NUM}>{fmtTokens(m.cacheReadTokens)}</td>
                                  <td className={TD_NUM}>{fmtTokens(m.inputTokens)}</td>
                                  <td className={TD_NUM}>{fmtTokens(m.outputTokens)}</td>
                                  <td className={TD_NUM}>{fmtSpeed(m.tokensPerSec)}</td>
                                  <td className={TD_NUM}>{fmtSpeed(m.decodeTokensPerSec)}</td>
                                  <td className={TD_NUM}>{fmtSeconds(m.avgTtftMs)}</td>
                                  <td className={TD_NUM}>{fmtCost(m.cost)}</td>
                                  <td className={TD_NUM}>
                                    <span className="text-muted-foreground/60">—</span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {stats.length === 0 && <EmptyRow colSpan={13} />}
              </>
            )}

            {dim === "model" &&
              (models.length === 0 ? (
                <EmptyRow colSpan={13} />
              ) : (
                models.map((m) => (
                  <tr key={m.modelId} className="border-b border-border/60 transition-colors hover:bg-muted/50">
                    <td className={TD_LEFT}>
                      <ModelId id={m.modelId} priced={m.priced} />
                    </td>
                    <td className={TD_NUM}>{fmtNumber(m.requests)}</td>
                    <td className={TD_NUM}>{fmtNumber(m.sessions)}</td>
                    <td className={TD_NUM}>{fmtHitRate(m.cacheReadTokens, m.inputTokens)}</td>
                    <td className={TD_NUM}>{fmtTokens(m.inputTokens + m.outputTokens)}</td>
                    <td className={TD_NUM}>{fmtTokens(m.cacheReadTokens)}</td>
                    <td className={TD_NUM}>{fmtTokens(m.inputTokens)}</td>
                    <td className={TD_NUM}>{fmtTokens(m.outputTokens)}</td>
                    <td className={TD_NUM}>{fmtSpeed(m.tokensPerSec)}</td>
                    <td className={TD_NUM}>{fmtSpeed(m.decodeTokensPerSec)}</td>
                    <td className={TD_NUM}>{fmtSeconds(m.avgTtftMs)}</td>
                    <td className={TD_NUM}>{fmtCost(m.cost)}</td>
                    <td className={TD_NUM}>
                      {m.errors > 0 ? (
                        <StatBadge tone="err">{fmtNumber(m.errors)}</StatBadge>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>
                  </tr>
                ))
              ))}

            {dim === "project" &&
              (projects.length === 0 ? (
                <EmptyRow colSpan={13} />
              ) : (
                projects.map((p) => (
                  <tr key={p.directory} className="border-b border-border/60 transition-colors hover:bg-muted/50">
                    <td className={TD_LEFT} title={p.directory}>
                      <span className="font-medium">{p.name}</span>
                    </td>
                    <td className={TD_NUM}>{fmtNumber(p.requests)}</td>
                    <td className={TD_NUM}>{fmtNumber(p.sessions)}</td>
                    <td className={TD_NUM}>{fmtHitRate(p.cacheReadTokens, p.inputTokens)}</td>
                    <td className={TD_NUM}>{fmtTokens(p.totalTokens)}</td>
                    <td className={TD_NUM}>{fmtTokens(p.cacheReadTokens)}</td>
                    <td className={TD_NUM}>{fmtTokens(p.inputTokens)}</td>
                    <td className={TD_NUM}>{fmtTokens(p.outputTokens)}</td>
                    <td className={TD_NUM}>{fmtSpeed(p.tokensPerSec)}</td>
                    <td className={TD_NUM}>{fmtSpeed(p.decodeTokensPerSec)}</td>
                    <td className={TD_NUM}>{fmtSeconds(p.avgTtftMs)}</td>
                    <td className={TD_NUM}>{fmtCost(p.cost)}</td>
                    <td className={TD_NUM}>
                      {p.errors > 0 ? (
                        <StatBadge tone="err">{fmtNumber(p.errors)}</StatBadge>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>
                  </tr>
                ))
              ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
