import { useRef, type KeyboardEvent } from "react";
import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";
import type { SourceStatus } from "../../shared/types";
import brandMark from "@/assets/brand-mark.svg";
import { toggleMaximize } from "@/lib/window";
import { cn } from "@/lib/utils";

/**
 * 侧边栏（CDS 桌面架构）
 *
 * 全高左列，与右侧内容列的 TitleBar 组成同一套窗口外壳：
 * 顶行同为 48px，竖分隔线从窗口顶端贯到底，应用身份只在这里出现一次。
 * 自上而下三段：身份区（应用名 + 版本 + 收起）、分组导航、运行状态卡。
 * 取舍依据 open-claude-ui 的两条硬约束：
 * - 导航条目无边框，靠行高节奏、Hover 微差与抬升的选中态区分（08 章单边框法则）；
 * - 2.0 高密工作台：32px 行高、16px 图标、13px 标签，分组标签走 11px caption 阶梯。
 */
export type SidebarItem = {
  value: string;
  label: string;
  icon: LucideIcon;
  /** 需要引起注意的计数（错误数等），0 不显示 */
  badge?: number;
  /** 悬停计数徽标时的说明，例如「个错误请求」 */
  badgeHint?: string;
};

export type SidebarGroup = {
  id: string;
  label: string;
  items: SidebarItem[];
};

export type SidebarStatus = {
  /** 当前数据源范围：全部 / zcode / DSH */
  scopeLabel: string;
  sources: SourceStatus[];
  refreshSec: number;
  /** 最近一次成功取数时间（epoch ms） */
  updatedAt?: number;
  busy?: boolean;
};

const CLOCK = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const CLOCK_SHORT = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 非今天的索引时间要带日期，否则「索引 10:00」会让人误以为是刚才 */
const DATE_SHORT = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function isToday(ms: number): boolean {
  const a = new Date(ms);
  const b = new Date();
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function Sidebar({
  groups,
  active,
  onSelect,
  collapsed,
  onToggleCollapsed,
  version,
  status,
}: {
  groups: SidebarGroup[];
  active: string;
  onSelect: (value: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  version: string;
  status: SidebarStatus;
}) {
  const navRef = useRef<HTMLElement>(null);

  // 垂直 tablist 的 roving focus：方向键在条目间移动，Home/End 跳到首尾
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const nodes = Array.from(
      navRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    if (nodes.length === 0) return;
    event.preventDefault();
    const current = nodes.indexOf(document.activeElement as HTMLButtonElement);
    const last = nodes.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowDown"
            ? current >= last
              ? 0
              : current + 1
            : current <= 0
              ? last
              : current - 1;
    nodes[next]?.focus();
  };

  const missing = status.sources.filter((s) => !s.available);
  // 每个源各自的取数形态：zcode 直读实时库，DSH 走增量索引，索引时间就是新鲜度
  const sourceLine =
    status.sources.length === 0
      ? "读取数据源…"
      : status.sources
          .map((s) => {
            if (!s.available) return `${s.label} 不可用`;
            if (s.id === "dsh") {
              if (!s.indexedAt) return `${s.label} 就绪`;
              const stamp = isToday(s.indexedAt)
                ? CLOCK_SHORT.format(s.indexedAt)
                : DATE_SHORT.format(s.indexedAt);
              return `${s.label} 索引 ${stamp}`;
            }
            return `${s.label} 实时`;
          })
          .join(" · ");
  const dotTone = status.busy
    ? "bg-clay animate-pulse"
    : missing.length > 0
      ? "bg-warn"
      : status.sources.length === 0
        ? "bg-muted-foreground/50"
        : "bg-success";
  const clockLine = [
    `每 ${status.refreshSec} 秒刷新`,
    status.updatedAt ? CLOCK.format(status.updatedAt) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const statusTitle = `${status.scopeLabel}\n${sourceLine}\nv${version} · ${clockLine}`;

  return (
    <aside
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar",
        "transition-[width] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
        collapsed ? "w-16" : "w-[232px]",
      )}
    >
      {/* 身份区：与右侧内容列顶栏同为 48px，共用一条竖分隔线；整行是窗口拖拽带 */}
      <div
        data-tauri-drag-region
        onDoubleClick={toggleMaximize}
        className={cn(
          "flex h-12 shrink-0 items-center",
          collapsed ? "justify-center px-0" : "gap-1.5 pl-5 pr-2",
        )}
      >
        {collapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            onDoubleClick={(event) => event.stopPropagation()}
            aria-label="展开侧栏"
            className="group/toggle relative flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-accent"
          >
            <img
              src={brandMark}
              alt=""
              aria-hidden
              draggable={false}
              className="size-5 transition-opacity duration-150 group-hover/toggle:opacity-0"
            />
            <PanelLeftOpen
              size={16}
              strokeWidth={1.75}
              className="absolute text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/toggle:opacity-100"
            />
          </button>
        ) : (
          <>
            <img
              src={brandMark}
              alt=""
              aria-hidden
              draggable={false}
              data-tauri-drag-region
              className="size-5 shrink-0"
            />
            {/* 单行词标：与右侧页标题同基线，窗口顶端只有一条水平视线 */}
            <span
              data-tauri-drag-region
              className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground"
            >
              Agents Dashboard
            </span>
            <button
              type="button"
              onClick={onToggleCollapsed}
              onDoubleClick={(event) => event.stopPropagation()}
              title="收起侧栏"
              aria-label="收起侧栏"
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
            >
              <PanelLeftClose size={16} strokeWidth={1.75} />
            </button>
          </>
        )}
      </div>

      {/* 分组导航 */}
      <nav
        ref={navRef}
        role="tablist"
        aria-orientation="vertical"
        aria-label="主导航"
        onKeyDown={onKeyDown}
        className={cn(
          "app-nav cds-scroll-fade min-h-0 flex-1 overflow-y-auto pb-3",
          collapsed ? "px-2.5 pt-1" : "px-2.5 pt-2",
        )}
      >
        {groups.map((group, gi) => (
          <div key={group.id} className={gi === 0 ? undefined : collapsed ? "mt-1" : "mt-4"}>
            {collapsed ? (
              gi > 0 && <div className="mx-auto mb-2 h-px w-5 bg-sidebar-border" aria-hidden />
            ) : (
              <div className="px-2.5 pb-1.5 text-[11px] font-medium tracking-[0.08em] text-muted-foreground">
                {group.label}
              </div>
            )}
            <div className={cn("space-y-0.5", collapsed && "flex flex-col items-center")}>
              {group.items.map((item) => {
                const selected = active === item.value;
                return (
                  <button
                    key={item.value}
                    role="tab"
                    type="button"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    title={collapsed ? item.label : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    onClick={() => onSelect(item.value)}
                    className={cn(
                      "group/item relative flex items-center rounded-lg text-left text-[13px] transition-[background-color,color,box-shadow] duration-150",
                      collapsed ? "size-8 justify-center" : "h-8 w-full gap-2.5 px-2.5",
                      selected
                        ? "nav-settle bg-surface-2 font-medium text-foreground shadow-sm ring-1 ring-black/[0.04] dark:bg-[var(--cds-gray-800)] dark:ring-white/[0.08]"
                        : "text-muted-foreground hover:bg-[var(--cds-alpha-1)] hover:text-foreground",
                    )}
                  >
                    <item.icon
                      size={16}
                      strokeWidth={1.75}
                      className={cn(
                        "shrink-0 transition-colors",
                        selected ? "text-clay" : "text-muted-foreground/85",
                      )}
                    />
                    {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                    {!collapsed && !!item.badge && item.badge > 0 && (
                      <span
                        title={item.badgeHint ? `${item.badge} ${item.badgeHint}` : undefined}
                        aria-label={
                          item.badgeHint ? `${item.badge} ${item.badgeHint}` : undefined
                        }
                        className="ml-1 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-danger/12 px-1 text-[10px] font-semibold tabular-nums text-danger"
                      >
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    )}
                    {collapsed && !!item.badge && item.badge > 0 && (
                      <span
                        className="absolute right-1 top-1 size-1.5 rounded-full bg-danger ring-2 ring-sidebar"
                        aria-hidden
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* 运行状态：数据源可用性 + 刷新节奏 + 最近取数时间 */}
      <div className={cn("shrink-0", collapsed ? "flex justify-center px-2 pb-3" : "px-2.5 pb-3")}>
        {collapsed ? (
          <div
            title={statusTitle}
            className="flex size-8 items-center justify-center rounded-lg"
            aria-hidden
          >
            <span className={cn("size-2 rounded-full", dotTone)} />
          </div>
        ) : (
          // 展开态三行信息已经全部可见，不再挂 title，避免重复弹卡
          <div className="rounded-lg bg-[var(--cds-alpha-1)] px-2.5 py-2">
            <div className="flex items-center gap-1.5">
              <span className={cn("size-1.5 shrink-0 rounded-full", dotTone)} aria-hidden />
              <span className="truncate text-[11px] font-medium text-foreground">
                {status.scopeLabel}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[9.5px] text-muted-foreground/70">
                v{version}
              </span>
            </div>
            <div
              className={cn(
                "mt-1 truncate text-[10.5px]",
                missing.length > 0 ? "text-warn" : "text-muted-foreground",
              )}
            >
              {sourceLine}
            </div>
            <div className="mt-0.5 truncate font-mono text-[10.5px] tabular-nums text-muted-foreground/80">
              {clockLine}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
