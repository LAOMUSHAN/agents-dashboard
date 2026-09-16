import { useMemo } from "react";
import { useResolvedTheme } from "../theme";

export interface ChartPalette {
  /** 网格线 */
  grid: string;
  /** 坐标轴刻度文字 */
  tick: string;
  /** 分类系列色(TOP 实体轮转),dark/light 双套 */
  series: string[];
  /** 面积图填充透明度 */
  areaOpacity: number;
  /** 费用线色 */
  cost: string;
}

const DARK: ChartPalette = {
  grid: "rgba(148,163,184,0.14)",
  tick: "#8b93a7",
  series: [
    "#7cb1fb", "#5fd6a2", "#fba85f", "#c59bfc",
    "#f78bbd", "#e3d05a", "#4fd8d4", "#b2e06b",
    "#fb7185", "#67c9ee", "#a5a3fb", "#8fd0fd", "#8a93a6",
  ],
  areaOpacity: 0.4,
  cost: "#fb7185",
};

const LIGHT: ChartPalette = {
  grid: "rgba(100,116,139,0.16)",
  tick: "#5b6478",
  series: [
    "#2563eb", "#0f9d6e", "#d97706", "#8b5cf6",
    "#db2777", "#a16207", "#0d9488", "#65a30d",
    "#dc2626", "#0284c7", "#6366f1", "#7c3aed", "#64748b",
  ],
  areaOpacity: 0.32,
  cost: "#dc2626",
};

/** 图表统一调色:主题自适应,三张趋势图与后续图表共用同一套色板 */
export function useChartPalette(): ChartPalette {
  const theme = useResolvedTheme();
  return useMemo(() => (theme === "dark" ? DARK : LIGHT), [theme]);
}
