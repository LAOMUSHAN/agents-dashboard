import type { SourceFilter, SourceStatus } from "../../shared/types";
import { Segmented } from "./ui/segmented";

const OPTIONS: { value: SourceFilter; label: string; title: string }[] = [
  { value: "all", label: "全部", title: "聚合 zcode 与 DSH" },
  { value: "zcode", label: "zcode", title: "只看 zcode 用量库" },
  { value: "dsh", label: "DSH", title: "只看 DSH 会话日志" },
];

/** 顶部数据源范围：全部 / zcode / DSH。设置页不展示（配置按来源分别管理）。 */
export function SourceScope({
  value,
  onChange,
  sources,
  className,
}: {
  value: SourceFilter;
  onChange: (value: SourceFilter) => void;
  sources: SourceStatus[];
  className?: string;
}) {
  const unavailable = sources.filter((s) => !s.available);
  const hint =
    unavailable.length > 0
      ? unavailable.map((s) => `${s.label} 不可用`).join("；")
      : "数据源范围";
  return (
    <div className={className} title={hint}>
      <Segmented value={value} options={OPTIONS} onChange={onChange} />
    </div>
  );
}
