import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  title?: string;
};

/**
 * CDS 分段控件：1px 轨道内边距 + 999px 全圆角 + 滑动滑块。
 * 滑块位置按激活按钮实测（offsetLeft/offsetWidth），中文标签长度不等也不会错位；
 * ResizeObserver 跟随容器宽度变化。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number }>({ left: 1, width: 0 });
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const update = () => {
      const btn = track.querySelectorAll<HTMLButtonElement>("button")[index];
      if (btn) setThumb({ left: btn.offsetLeft, width: btn.offsetWidth });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(track);
    return () => ro.disconnect();
  }, [index, options.length]);

  return (
    <div
      ref={trackRef}
      role="tablist"
      className={cn(
        "relative inline-flex h-7 items-stretch rounded-full p-px",
        "bg-[var(--cds-segmented-track)]",
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-px rounded-full bg-[var(--cds-segmented-thumb)]"
        style={{
          left: thumb.left,
          width: thumb.width,
          boxShadow:
            "inset 0 0 0 0.5px var(--cds-border), 0 1px 2px #0000000f, 0 2px 6px -1px #0000000d",
          // CDS 分段控件：滑块位移走 15 阶弹簧，宽度同步跟随，中文标签不等长也不抖
          transition:
            "left 240ms var(--cds-spring-press), width 240ms var(--cds-spring-press)",
        }}
      />
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            title={o.title}
            className={cn(
              "relative z-10 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium transition-colors",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
