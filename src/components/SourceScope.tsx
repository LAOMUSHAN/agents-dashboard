import type { SourceFilter, SourceStatus } from "../../shared/types";
import { Segmented } from "./ui/segmented";
import { Hint, HintText } from "./ui/hint";

const OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "zcode", label: "zcode" },
  { value: "dsh", label: "DSH" },
  { value: "claude", label: "Claude" },
];

/** 顶部数据源范围：全部 / zcode / DSH / Claude Code。设置页不展示（配置按来源分别管理）。 */
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
      : "聚合 zcode、DSH 与 Claude Code；也可以只看单一来源。";
  return (
    <Hint className="w-[320px]" content={<HintText title="数据源范围">{hint}</HintText>}>
      <div className={className}>
        <Segmented value={value} options={OPTIONS} onChange={onChange} />
      </div>
    </Hint>
  );
}
