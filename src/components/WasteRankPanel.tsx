import { useMemo, useState } from "react";
import type { ModelStat, ProjectStat, ProviderStat } from "../../shared/types";
import { cn } from "@/lib/utils";
import { fmtPercent, fmtTokens } from "../format";
import { Panel } from "./ui/panel";
import { Segmented } from "./ui/segmented";

type Dim = "project" | "model" | "provider";

const DIMS: { value: Dim; label: string }[] = [
  { value: "project", label: "项目" },
  { value: "model", label: "模型" },
  { value: "provider", label: "供应商" },
];

type WasteRow = {
  name: string;
  /** 浪费指数 = 100 × (1 − 缓存命中率) × 输出占比 */
  index: number;
  hitRate: number | null;
  outputShare: number;
  inputTokens: number;
  outputTokens: number;
};

function toRow(
  name: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): WasteRow | null {
  // 无输入的行没有命中率可言(输出占比也无从谈起),直接排除
  if (inputTokens <= 0 && outputTokens <= 0) return null;
  const hitRate = inputTokens > 0 ? cacheReadTokens / inputTokens : null;
  const outputShare = inputTokens + outputTokens > 0 ? outputTokens / (inputTokens + outputTokens) : 0;
  const miss = hitRate == null ? 0.5 : 1 - hitRate; // 无缓存数据按中性 50% 计
  return {
    name,
    index: 100 * miss * outputShare,
    hitRate,
    outputShare,
    inputTokens,
    outputTokens,
  };
}

/** AITracker 的浪费指数:低缓存命中 + 高输出占比 → 每个输出 token 付出的代价高 */
function suggest(r: WasteRow): { text: string; tone: "warn" | "info" } {
  if (r.hitRate != null && r.hitRate < 0.5) {
    return { text: "命中率偏低:稳定提示词前缀、合并重复系统段可显著提升命中", tone: "warn" };
  }
  if (r.outputShare > 0.6) {
    return { text: "输出占比高:生成型任务为主,关注解码速度与单次输出预算", tone: "info" };
  }
  return { text: "结构均衡,无需特别处理", tone: "info" };
}

export function WasteRankPanel({
  projects,
  models,
  providers,
}: {
  projects: ProjectStat[];
  models: ModelStat[];
  providers: ProviderStat[];
}) {
  const [dim, setDim] = useState<Dim>("project");

  const rows = useMemo<WasteRow[]>(() => {
    // 聚合范围下同一模型/供应商会按来源出现多行；浪费指数是模型/上游维度的判断，
    // 这里按名称合并后再排名，避免同名两行把 TOP 10 挤满
    const sumBy = <T,>(
      items: T[],
      key: (x: T) => string,
      val: (x: T) => { input: number; output: number; cache: number },
    ) => {
      const map = new Map<string, { input: number; output: number; cache: number }>();
      for (const it of items) {
        const k = key(it);
        const v = val(it);
        const cur = map.get(k) ?? { input: 0, output: 0, cache: 0 };
        cur.input += v.input;
        cur.output += v.output;
        cur.cache += v.cache;
        map.set(k, cur);
      }
      return [...map.entries()].map(([k, v]) => toRow(k, v.input, v.output, v.cache));
    };
    const list =
      dim === "project"
        ? projects.map((p) => toRow(p.name || p.directory, p.inputTokens, p.outputTokens, p.cacheReadTokens))
        : dim === "model"
          ? sumBy(models, (m) => m.modelId, (m) => ({
              input: m.inputTokens,
              output: m.outputTokens,
              cache: m.cacheReadTokens,
            }))
          : sumBy(providers, (p) => p.name, (p) => ({
              input: p.inputTokens,
              output: p.outputTokens,
              cache: p.cacheReadTokens,
            }));
    return list
      .filter((r): r is WasteRow => r != null)
      .sort((a, b) => b.index - a.index)
      .slice(0, 10);
  }, [dim, projects, models, providers]);

  const max = rows[0]?.index ?? 0;

  return (
    <Panel
      title="浪费指数排行"
      sub="低缓存命中 × 高输出占比 · TOP 10"
      actions={<Segmented value={dim} options={DIMS} onChange={setDim} />}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr className="border-b border-border">
              <th className="px-2 py-2 text-left text-[11px] font-medium text-muted-foreground">名称</th>
              <th className="w-36 px-2 py-2 text-right text-[11px] font-medium text-muted-foreground">指数</th>
              <th className="px-2 py-2 text-right text-[11px] font-medium text-muted-foreground">命中率</th>
              <th className="px-2 py-2 text-right text-[11px] font-medium text-muted-foreground">输出占比</th>
              <th className="px-2 py-2 text-right text-[11px] font-medium text-muted-foreground">输入</th>
              <th className="px-2 py-2 text-right text-[11px] font-medium text-muted-foreground">输出</th>
              <th className="px-2 py-2 text-left text-[11px] font-medium text-muted-foreground">建议</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50">
                <td className="max-w-52 truncate px-2 py-1.5 font-mono text-xs" title={r.name}>
                  {r.name}
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div
                        className={cn(
                          "h-full rounded-full",
                          r.index >= 40 ? "bg-danger" : r.index >= 20 ? "bg-warn" : "bg-success",
                        )}
                        style={{ width: `${max ? (r.index / max) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="w-10 text-right text-[13px] tabular-nums">{r.index.toFixed(1)}</span>
                  </div>
                </td>
                <td className="px-2 py-1.5 text-right text-[13px] tabular-nums text-muted-foreground">
                  {r.hitRate == null ? "-" : fmtPercent(r.hitRate * 100, 100)}
                </td>
                <td className="px-2 py-1.5 text-right text-[13px] tabular-nums text-muted-foreground">
                  {fmtPercent(r.outputShare * 100, 100)}
                </td>
                <td className="px-2 py-1.5 text-right text-[13px] tabular-nums">{fmtTokens(r.inputTokens)}</td>
                <td className="px-2 py-1.5 text-right text-[13px] tabular-nums">{fmtTokens(r.outputTokens)}</td>
                <td className="px-2 py-1.5 text-xs text-muted-foreground">
                  <span
                    className={
                      suggest(r).tone === "warn"
                        ? "text-warn"
                        : "text-muted-foreground"
                    }
                  >
                    {suggest(r).text}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-8 text-center text-[13px] text-muted-foreground">
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

