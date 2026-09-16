import { Fragment, useMemo } from "react";
import type { HeatCell } from "../../shared/types";
import { Panel } from "./ui/panel";

// GitHub 风格五档色阶(蓝系):0 档为无数据;深浅主题共用,靠透明度叠加背景
const HM = [
  "rgba(124,148,196,0.13)",
  "rgba(96,150,248,0.30)",
  "rgba(96,150,248,0.55)",
  "rgba(96,150,248,0.78)",
  "rgba(96,150,248,1)",
];

const DOW_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function ActivityHeatmap({ cells }: { cells: HeatCell[] }) {
  const byKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cells) m.set(`${c.dow}-${c.hour}`, c.calls);
    return m;
  }, [cells]);
  const max = cells.reduce((mx, c) => Math.max(mx, c.calls), 0);
  // GitHub 风格五档色阶:0 档为无数据,其余按占最大值的比例分档
  const level = (calls: number) =>
    calls === 0 || max === 0 ? 0 : Math.min(4, Math.ceil((calls / max) * 4));

  return (
    <Panel title="活跃时段" sub="按本地时间 · 模型调用次数">
      {cells.length === 0 ? (
        <div className="px-2 py-8 text-center text-[13px] text-muted-foreground">该时间范围内没有数据</div>
      ) : (
        <>
          <div className="heatmap">
            <div className="heatmap-corner" />
            {HOURS.map((h) => (
              <div key={h} className="heatmap-col-label">
                {h % 4 === 0 ? h : ""}
              </div>
            ))}
            {[0, 1, 2, 3, 4, 5, 6].map((dow) => (
              <Fragment key={dow}>
                <div className="heatmap-row-label">{DOW_LABELS[dow]}</div>
                {HOURS.map((hour) => {
                  const calls = byKey.get(`${dow}-${hour}`) ?? 0;
                  return (
                    <div
                      key={`${dow}-${hour}`}
                      className="heatmap-cell"
                      style={{ background: HM[level(calls)] }}
                      title={`周${DOW_LABELS[dow]} ${String(hour).padStart(2, "0")}:00 · ${calls} 次`}
                    />
                  );
                })}
              </Fragment>
            ))}
          </div>
          <div className="heatmap-scale">
            <span>少</span>
            {[0, 1, 2, 3, 4].map((l) => (
              <i key={l} className="inline-block size-2.5 rounded-sm" style={{ background: HM[l] }} />
            ))}
            <span>多</span>
          </div>
        </>
      )}
    </Panel>
  );
}
