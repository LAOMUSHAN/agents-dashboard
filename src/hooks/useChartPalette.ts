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

/**
 * 暖色分类色板:CDS 没有定义多序列图表色,这里按陶土/暖灰/沙/鼠尾草派生。
 * 首序列固定陶土橙,错误红只留给错误序列,避免和品牌色混淆。
 */
const DARK: ChartPalette = {
  grid: "rgba(255,255,255,0.08)",
  tick: "#8a8a8a",
  series: [
    "#d97757", "#a3a19a", "#c9a27f", "#8f9d93",
    "#e0a184", "#b4b3a8", "#c58a6e", "#9fb0a6",
    "#d9b795", "#b3a4ae", "#a98a77", "#c3c2b7",
    "#97958d",
  ],
  areaOpacity: 0.28,
  cost: "#e0b48f",
};

const LIGHT: ChartPalette = {
  grid: "rgba(21,21,21,0.08)",
  tick: "#6d6b67",
  series: [
    "#c6613f", "#8c8a80", "#b08968", "#6f7d74",
    "#d98e6f", "#5f5e5a", "#a3714f", "#7f8f86",
    "#c9a27f", "#9c8f9a", "#8b6f5e", "#a5a49a",
    "#7b7974",
  ],
  areaOpacity: 0.24,
  cost: "#8a5a3b",
};

/** 图表统一调色:主题自适应,三张趋势图与后续图表共用同一套色板 */
export function useChartPalette(): ChartPalette {
  const theme = useResolvedTheme();
  return useMemo(() => (theme === "dark" ? DARK : LIGHT), [theme]);
}
