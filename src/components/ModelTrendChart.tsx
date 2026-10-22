import { useMemo } from "react";
import type { ModelTrendPoint } from "../../shared/types";
import { TrendBarChart, type TrendDatum } from "./TrendBarChart";

export function ModelTrendChart({ points }: { points: ModelTrendPoint[] }) {
  const data = useMemo<TrendDatum[]>(
    () => points.map((p) => ({ bucket: p.bucket, values: p.models })),
    [points],
  );
  return <TrendBarChart title="模型用量趋势" points={data} nameOf={(name) => name} />;
}
