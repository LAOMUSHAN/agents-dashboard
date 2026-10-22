import { useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { Eye, EyeOff, GripVertical, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  OVERVIEW_MODULE_MAP,
  defaultOverviewLayout,
  type OverviewLayout,
  type OverviewModuleId,
} from "../overviewModules";
import { Panel } from "./ui/panel";

type Section = "visible" | "hidden";

interface DropTarget {
  section: Section;
  index: number;
}

function SectionHeader({ section, count }: { section: Section; count: number }) {
  const visible = section === "visible";
  const Icon = visible ? Eye : EyeOff;
  return (
    <div className="flex items-center gap-1.5 px-2 pb-1 text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
      <Icon size={11} strokeWidth={1.8} />
      <span>{visible ? "展示" : "隐藏"}</span>
      <span className="tabular-nums text-muted-foreground/65">{count}</span>
      <span className="ml-auto text-[9.5px] font-normal tracking-normal text-muted-foreground/60">
        {visible ? "拖动排序" : "拖回上方展示"}
      </span>
    </div>
  );
}

function Divider() {
  return (
    <div className="relative my-2 flex items-center gap-2 px-1" aria-hidden>
      <span className="h-px flex-1 bg-border/80" />
      <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[9px] text-muted-foreground">
        <GripVertical size={9} className="rotate-90" />
        拖到下方隐藏
      </span>
      <span className="h-px flex-1 bg-border/80" />
    </div>
  );
}

function ModuleRow({
  id,
  index,
  items,
  section,
  dragging,
  drop,
  settling,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  id: OverviewModuleId;
  index: number;
  items: OverviewModuleId[];
  section: Section;
  dragging: boolean;
  drop: DropTarget | null;
  settling: boolean;
  onDragStart: (e: ReactDragEvent<HTMLLIElement>, id: OverviewModuleId) => void;
  onDragEnd: () => void;
  onDragOver: (e: ReactDragEvent<HTMLLIElement>, section: Section, index: number) => void;
  onDrop: (e: ReactDragEvent<HTMLLIElement>) => void;
}) {
  const def = OVERVIEW_MODULE_MAP[id];
  const Icon = def.icon;
  const isLast = index === items.length - 1;
  const line =
    drop?.section === section && drop.index === index
      ? "before"
      : drop?.section === section && drop.index === index + 1 && isLast
        ? "after"
        : null;

  return (
    <li
      draggable
      tabIndex={0}
      aria-label={`${def.label}，拖动调整顺序`}
      title="拖动调整顺序"
      className={cn(
        "group relative flex cursor-grab select-none items-center gap-2.5 rounded-lg border px-2.5 py-2 outline-none transition-[background-color,border-color,box-shadow,opacity,transform] duration-150 focus-visible:ring-2 focus-visible:ring-clay/40 active:cursor-grabbing",
        section === "visible"
          ? "border-border/55 bg-background/65"
          : "border-transparent bg-background/30",
        "hover:border-border hover:bg-accent/30",
        dragging && "opacity-35",
        settling && "module-settle",
      )}
      onDragStart={(e) => onDragStart(e, id)}
      onDragEnd={onDragEnd}
      onDragOver={(e) => onDragOver(e, section, index)}
      onDrop={onDrop}
    >
      {line && (
        <span
          className={cn(
            "pointer-events-none absolute left-0 right-0 z-10 h-[2px] rounded-full bg-clay cds-pop",
            line === "before" ? "-top-[4px]" : "-bottom-[4px]",
          )}
        >
          <span className="absolute -left-1 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-clay" />
        </span>
      )}
      <GripVertical
        size={13}
        className="shrink-0 text-muted-foreground/35 transition-colors group-hover:text-muted-foreground/70"
      />
      <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border/40 bg-accent/40 text-muted-foreground">
        <Icon size={13} strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{def.label}</span>
    </li>
  );
}

function EmptyDrop({
  section,
  active,
  onDragOver,
  onDrop,
}: {
  section: Section;
  active: boolean;
  onDragOver: (e: ReactDragEvent<HTMLLIElement>) => void;
  onDrop: (e: ReactDragEvent<HTMLLIElement>) => void;
}) {
  return (
    <li
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        "flex h-9 items-center justify-center rounded-lg border border-dashed text-[10px] transition-colors",
        active
          ? "border-clay/55 bg-clay/5 text-foreground"
          : "border-border/60 bg-background/25 text-muted-foreground",
      )}
    >
      {section === "visible" ? "从下方拖上来展示" : "拖到这里隐藏"}
    </li>
  );
}

/**
 * 总览模块排序/显隐设置。
 * 上区为展示模块，下区为隐藏模块；跨横线拖动即切换显隐。
 * 用原生 drag 事件，不引第三方依赖；落点线与落位回弹使用 CDS 动效令牌。
 */
export function OverviewModulesPanel({
  layout,
  onChange,
}: {
  layout: OverviewLayout;
  onChange: (layout: OverviewLayout) => void;
}) {
  const [dragId, setDragId] = useState<OverviewModuleId | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [settling, setSettling] = useState<OverviewModuleId | null>(null);
  const settleTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (settleTimer.current) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  const flashSettle = (id: OverviewModuleId) => {
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    setSettling(id);
    settleTimer.current = window.setTimeout(() => setSettling(null), 380);
  };

  const move = (id: OverviewModuleId, toSection: Section, toIndex: number) => {
    const fromSection: Section = layout.visible.includes(id) ? "visible" : "hidden";
    const source = fromSection === "visible" ? layout.visible : layout.hidden;
    const fromIndex = source.indexOf(id);
    if (fromIndex < 0) return;

    // 同一区内的落点索引包含被拖走的自己，先减一
    let targetIndex = toIndex;
    if (fromSection === toSection && fromIndex < toIndex) targetIndex -= 1;

    const nextSource = source.filter((x) => x !== id);
    const target = toSection === "visible" ? layout.visible : layout.hidden;
    const nextTarget = target.filter((x) => x !== id);
    nextTarget.splice(Math.max(0, Math.min(targetIndex, nextTarget.length)), 0, id);

    const next: OverviewLayout =
      fromSection === toSection
        ? toSection === "visible"
          ? { visible: nextTarget, hidden: layout.hidden }
          : { visible: layout.visible, hidden: nextTarget }
        : toSection === "visible"
          ? { visible: nextTarget, hidden: nextSource }
          : { visible: nextSource, hidden: nextTarget };

    onChange(next);
    setDragId(null);
    setDrop(null);
    flashSettle(id);
  };

  const startDrag = (e: ReactDragEvent<HTMLLIElement>, id: OverviewModuleId) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    setDragId(id);
    setDrop(null);
    setSettling(null);
  };

  const endDrag = () => {
    setDragId(null);
    setDrop(null);
  };

  const overRow = (e: ReactDragEvent<HTMLLIElement>, section: Section, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    setDrop({ section, index: index + (after ? 1 : 0) });
  };

  const dropRow = (e: ReactDragEvent<HTMLLIElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragId || !drop) return;
    move(dragId, drop.section, drop.index);
  };

  const overEmpty = (e: ReactDragEvent<HTMLLIElement>, section: Section) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDrop({ section, index: section === "visible" ? layout.visible.length : layout.hidden.length });
  };

  const reset = () => {
    setDragId(null);
    setDrop(null);
    setSettling(null);
    onChange(defaultOverviewLayout());
  };

  return (
    <Panel
      title="总览模块"
      sub="拖动排序；拖到横线下方即隐藏"
      actions={
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="恢复默认的模块顺序与显示范围"
        >
          <RotateCcw size={11} />
          恢复默认
        </button>
      }
    >
      <div className="space-y-1 px-1">
        <SectionHeader section="visible" count={layout.visible.length} />
        <ul className="space-y-1.5" aria-label="展示的模块">
          {layout.visible.map((id, i) => (
            <ModuleRow
              key={id}
              id={id}
              index={i}
              items={layout.visible}
              section="visible"
              dragging={dragId === id}
              drop={drop}
              settling={settling === id}
              onDragStart={startDrag}
              onDragEnd={endDrag}
              onDragOver={overRow}
              onDrop={dropRow}
            />
          ))}
          {layout.visible.length === 0 && (
            <EmptyDrop
              section="visible"
              active={drop?.section === "visible" && drop.index === 0}
              onDragOver={(e) => overEmpty(e, "visible")}
              onDrop={dropRow}
            />
          )}
        </ul>

        <Divider />

        <SectionHeader section="hidden" count={layout.hidden.length} />
        <ul className="space-y-1.5" aria-label="隐藏的模块">
          {layout.hidden.map((id, i) => (
            <ModuleRow
              key={id}
              id={id}
              index={i}
              items={layout.hidden}
              section="hidden"
              dragging={dragId === id}
              drop={drop}
              settling={settling === id}
              onDragStart={startDrag}
              onDragEnd={endDrag}
              onDragOver={overRow}
              onDrop={dropRow}
            />
          ))}
          {layout.hidden.length === 0 && (
            <EmptyDrop
              section="hidden"
              active={drop?.section === "hidden" && drop.index === 0}
              onDragOver={(e) => overEmpty(e, "hidden")}
              onDrop={dropRow}
            />
          )}
        </ul>
      </div>
    </Panel>
  );
}
