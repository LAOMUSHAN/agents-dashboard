import {
  CalendarRange,
  ChartNoAxesColumn,
  Cpu,
  Gauge,
  GitBranch,
  Lightbulb,
  Network,
  PieChart,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

export type OverviewModuleId =
  | "insight"
  | "summary"
  | "trend"
  | "modelTrend"
  | "providerTrend"
  | "context"
  | "activity"
  | "agents"
  | "waste";

export interface OverviewModuleDef {
  id: OverviewModuleId;
  label: string;
  icon: LucideIcon;
}

/** 总览模块的稳定顺序与展示名；设置面板和总览渲染共用这一份 */
export const OVERVIEW_MODULES: OverviewModuleDef[] = [
  { id: "insight", label: "洞察摘要", icon: Lightbulb },
  { id: "summary", label: "核心指标", icon: Gauge },
  { id: "trend", label: "用量趋势", icon: ChartNoAxesColumn },
  { id: "modelTrend", label: "模型用量趋势", icon: Cpu },
  { id: "providerTrend", label: "供应商用量趋势", icon: Network },
  { id: "context", label: "上下文构成", icon: PieChart },
  { id: "activity", label: "活跃时段", icon: CalendarRange },
  { id: "agents", label: "代理工作流", icon: GitBranch },
  { id: "waste", label: "浪费指数", icon: TriangleAlert },
];

export const OVERVIEW_MODULE_MAP = Object.fromEntries(
  OVERVIEW_MODULES.map((m) => [m.id, m]),
) as Record<OverviewModuleId, OverviewModuleDef>;

export interface OverviewLayout {
  visible: OverviewModuleId[];
  hidden: OverviewModuleId[];
}

/** 默认仍是原总览的结论层，其余分析面板放在隐藏区，由用户拖上去 */
export function defaultOverviewLayout(): OverviewLayout {
  return {
    visible: ["insight", "summary", "trend"],
    hidden: ["modelTrend", "providerTrend", "context", "activity", "agents", "waste"],
  };
}

const KNOWN_IDS = new Set<string>(OVERVIEW_MODULES.map((m) => m.id));

function isKnown(v: unknown): v is OverviewModuleId {
  return typeof v === "string" && KNOWN_IDS.has(v);
}

/**
 * 兼容旧配置/新增模块：
 * - 未知 id 丢弃；重复 id 只保留第一次
 * - 缺失的模块补到隐藏区末尾，保证每个模块都能在设置里找到
 * - 完全无效的配置回到默认布局
 */
export function normalizeOverviewLayout(raw: unknown): OverviewLayout {
  if (!raw || typeof raw !== "object") return defaultOverviewLayout();
  const obj = raw as { visible?: unknown; hidden?: unknown };
  const visibleRaw = Array.isArray(obj.visible) ? obj.visible : [];
  const hiddenRaw = Array.isArray(obj.hidden) ? obj.hidden : [];
  if (visibleRaw.length === 0 && hiddenRaw.length === 0) return defaultOverviewLayout();

  const seen = new Set<OverviewModuleId>();
  const visible: OverviewModuleId[] = [];
  const hidden: OverviewModuleId[] = [];
  for (const v of visibleRaw) {
    if (!isKnown(v) || seen.has(v)) continue;
    seen.add(v);
    visible.push(v);
  }
  for (const v of hiddenRaw) {
    if (!isKnown(v) || seen.has(v)) continue;
    seen.add(v);
    hidden.push(v);
  }
  if (seen.size === 0) return defaultOverviewLayout();
  for (const m of OVERVIEW_MODULES) {
    if (!seen.has(m.id)) hidden.push(m.id);
  }
  return { visible, hidden };
}
