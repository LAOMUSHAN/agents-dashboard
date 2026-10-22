import { useMemo } from "react";
import type { ProviderTrendPoint } from "../../shared/types";
import { TrendBarChart, type TrendDatum } from "./TrendBarChart";

export function ProviderTrendChart({
  points,
  names,
}: {
  points: ProviderTrendPoint[];
  /** providerId -> 展示名(来自按供应商表格的数据) */
  names: Record<string, string>;
}) {
  const data = useMemo<TrendDatum[]>(
    () => points.map((p) => ({ bucket: p.bucket, values: p.providers })),
    [points],
  );
  return <TrendBarChart title="供应商用量趋势" points={data} nameOf={(id) => names[id] ?? id} />;
}
