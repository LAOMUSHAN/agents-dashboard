import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { Summary, ToolStat } from "../../shared/types";
import { fmtNumber, fmtPercent, fmtTokens } from "../format";
import { HintCard } from "./ui/hint";
import { Panel } from "./ui/panel";

/** 工具调用按前缀归类;未匹配的归"其他" */
function classifyTool(toolName: string): string {
  if (toolName.startsWith("mcp__")) return "MCP";
  const n = toolName.toLowerCase();
  if (n === "bash" || n === "shell" || n.startsWith("terminal")) return "Shell";
  if (["read", "edit", "write", "glob", "grep", "notebookedit", "multiedit"].includes(n)) return "文件";
  if (n === "skill" || n === "skills" || n.startsWith("skill__")) return "Skill";
  if (n === "webfetch" || n === "websearch" || n.startsWith("web_")) return "Web";
  if (["agent", "task", "taskoutput", "sendmessage", "todocheck"].includes(n)) return "代理协作";
  if (n === "todowrite" || n === "todoread") return "任务清单";
  return "其他";
}

const CAT_COLORS = ["#60a5fa", "#4ade80", "#fb923c", "#c084fc", "#f472b6", "#facc15", "#2dd4bf", "#94a3b8"];

type Slice = { name: string; value: number };

/** 环形图悬浮卡:名称 + 数值 + 占比 */
function PieTip({
  active,
  payload,
  unit,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; payload?: { name: string; value: number } }[];
  unit: string;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload ?? { name: "", value: 0 };
  return (
    <HintCard className="min-w-[140px] text-xs">
      <div className="font-semibold">{p.name}</div>
      <div className="mt-0.5 tabular-nums text-muted-foreground">
        {unit === "tokens" ? fmtTokens(p.value) : fmtNumber(p.value)} {unit}
      </div>
    </HintCard>
  );
}

export function ContextComposition({ summary, tools }: { summary: Summary | null; tools: ToolStat[] }) {
  const tokenSlices = useMemo<Slice[]>(() => {
    if (!summary) return [];
    const s: Slice[] = [
      { name: "输入", value: summary.inputTokens },
      { name: "输出", value: summary.outputTokens },
      { name: "缓存读", value: summary.cacheReadTokens },
      { name: "缓存写", value: summary.cacheCreateTokens },
    ];
    return s.filter((x) => x.value > 0);
  }, [summary]);

  const toolSlices = useMemo<Slice[]>(() => {
    const byCat = new Map<string, number>();
    for (const t of tools) {
      const cat = classifyTool(t.toolName);
      byCat.set(cat, (byCat.get(cat) ?? 0) + t.calls);
    }
    return [...byCat.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [tools]);

  const tokenTotal = tokenSlices.reduce((s, x) => s + x.value, 0);
  const toolTotal = toolSlices.reduce((s, x) => s + x.value, 0);
  const hasAny = tokenTotal > 0 || toolTotal > 0;
  if (!hasAny) return null;

  const renderPie = (slices: Slice[], total: number, unit: string) => (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
      <div className="h-44 w-44">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="58%"
              outerRadius="88%"
              strokeWidth={0}
              paddingAngle={slices.length > 1 ? 1.5 : 0}
              isAnimationActive={false}
            >
              {slices.map((_, i) => (
                <Cell key={i} fill={CAT_COLORS[i % (CAT_COLORS.length - 1)]} />
              ))}
            </Pie>
            <Tooltip content={<PieTip unit={unit} />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 px-2">
        {slices.map((s, i) => (
          <span key={s.name} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: CAT_COLORS[i % (CAT_COLORS.length - 1)] }} />
            {s.name}
            <span className="tabular-nums">
              {unit === "tokens" ? fmtTokens(s.value) : fmtNumber(s.value)}
            </span>
            <span className="tabular-nums opacity-70">{fmtPercent(s.value, total)}</span>
          </span>
        ))}
      </div>
    </div>
  );

  return (
    <Panel title="上下文构成" sub="token 构成 · 工具调用分类">
      <div className="flex flex-col gap-4 px-2 py-1 md:flex-row md:items-start">
        {tokenTotal > 0 && renderPie(tokenSlices, tokenTotal, "tokens")}
        {toolTotal > 0 && renderPie(toolSlices, toolTotal, "次")}
      </div>
    </Panel>
  );
}
