import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";
import type { SourceStatus } from "../../shared/types";
import brandMark from "@/assets/brand-mark.svg";
import { toggleMaximize } from "@/lib/window";
import { cn } from "@/lib/utils";

/**
 * 侧边栏（统一外壳 + CDS 桌面架构）
 *
 * 全高左列，与右侧内容列共用同一块底色：侧栏不再是「另一块面板」，
 * 结构只由一条两端淡出的发丝线和留白给出，顶行与内容列同为 44px。
 * 自上而下三段：身份区（应用名 + 版本 + 收起）、分组导航、运行状态。
 *
 * 三条取舍：
 * - 选中态是块在条目间滑动的共享滑块（transform + 15 阶弹簧），不靠边框；
 * - 导航条目无边框，靠行高节奏、Hover 微差与滑块区分（CDS 单边框法则）；
 * - 2.0 高密工作台：30px 行高、16px 图标、12.5px 标签，分组标签走 10.5px caption。
 * - 「健康与性能」行尾只留一个低干扰状态点；错误数量在页面内看，导航不挂计数。
 */
export type SidebarItem = {
  value: string;
  label: string;
  icon: LucideIcon;
  /** 行尾注意点：只表达「有信号」，具体数字留在页面内 */
  alert?: boolean;
  /** 悬停注意点时的说明 */
  alertHint?: string;
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
  // 共享滑块：只记纵坐标，宽度/高度交给 CSS 变量跟随侧栏宽度
  const [pillTop, setPillTop] = useState<number | null>(null);
  const [pillReady, setPillReady] = useState(false);

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

  // 滑块落位：读选中条目的矩形，换算成 nav 内容坐标（含滚动量）
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const selected = nav.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
      if (!selected) {
        setPillTop(null);
        return;
      }
      const navRect = nav.getBoundingClientRect();
      const itemRect = selected.getBoundingClientRect();
      setPillTop(itemRect.top - navRect.top + nav.scrollTop);
    };
    measure();
    // 侧栏宽度动画、窗口缩放都会改变条目矩形；ResizeObserver 逐帧跟随
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [active, collapsed]);

  // 首帧先把滑块放到位置，再开启过渡，避免启动时从顶部滑下来
  useLayoutEffect(() => {
    if (pillTop == null || pillReady) return;
    const frame = requestAnimationFrame(() => setPillReady(true));
    return () => cancelAnimationFrame(frame);
  }, [pillTop, pillReady]);

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
        "relative flex shrink-0 flex-col overflow-hidden bg-background",
        "transition-[width] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]",
        collapsed ? "w-14" : "w-[200px]",
      )}
    >
      {/* 发丝分隔线：从顶栏下沿开始，到窗口底部淡出；顶行因此完全连通 */}
      <span
        aria-hidden
        className="sidebar-divider pointer-events-none absolute bottom-0 right-0 top-11 w-px"
      />

      {/* 身份区：与右侧内容列顶栏同为 44px；整行是窗口拖拽带 */}
      <div
        data-tauri-drag-region
        onDoubleClick={toggleMaximize}
        className={cn(
          "relative z-10 flex h-11 shrink-0 items-center",
          collapsed ? "justify-center" : "gap-1.5 pl-4 pr-2",
        )}
      >
        {collapsed ? (
          <button
            type="button"
            onClick={onToggleCollapsed}
            onDoubleClick={(event) => event.stopPropagation()}
            title="展开侧栏"
            aria-label="展开侧栏"
            className="group/toggle relative flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--cds-alpha-1)]"
          >
            <img
              src={brandMark}
              alt=""
              aria-hidden
              draggable={false}
              className="size-[18px] transition-opacity duration-150 group-hover/toggle:opacity-0"
            />
            <PanelLeftOpen
              size={15}
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
              className="size-[18px] shrink-0"
            />
            {/* 单行词标：与右侧页标题同基线，窗口顶端只有一条水平视线 */}
            <span
              data-tauri-drag-region
              className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-[-0.01em] text-foreground"
            >
              Agents Dashboard
            </span>
            <button
              type="button"
              onClick={onToggleCollapsed}
              onDoubleClick={(event) => event.stopPropagation()}
              title="收起侧栏"
              aria-label="收起侧栏"
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-[var(--cds-alpha-1)] hover:text-foreground"
            >
              <PanelLeftClose size={15} strokeWidth={1.75} />
            </button>
          </>
        )}
      </div>

      {/* 分组导航：滑块在条目底下滑动，条目本身保持透明 */}
      <nav
        ref={navRef}
        data-collapsed={collapsed ? "true" : "false"}
        role="tablist"
        aria-orientation="vertical"
        aria-label="主导航"
        onKeyDown={onKeyDown}
        className="app-nav app-scroll cds-scroll-fade relative min-h-0 flex-1 overflow-y-auto pb-3 pt-1.5"
      >
        <span
          aria-hidden
          className="nav-glider"
          style={{
            transform: `translateY(${pillTop ?? 0}px)`,
            opacity: pillTop == null ? 0 : 1,
            ...(pillReady ? {} : { transition: "none" }),
          }}
        />

        {groups.map((group, gi) => (
          <div key={group.id} className={gi === 0 ? undefined : collapsed ? "mt-1" : "mt-3"}>
            {collapsed ? (
              gi > 0 && <div className="mx-auto mb-1.5 h-px w-5 bg-border/70" aria-hidden />
            ) : (
              <div className="px-2 pb-1 pt-1 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground">
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
                    title={
                      collapsed
                        ? item.alert && item.alertHint
                          ? `${item.label} · ${item.alertHint}`
                          : item.label
                        : undefined
                    }
                    aria-label={collapsed ? item.label : undefined}
                    onClick={() => onSelect(item.value)}
                    className={cn(
                      "group/item relative z-10 flex items-center overflow-hidden rounded-lg text-left text-[12.5px]",
                      "transition-[background-color,color,height,transform] duration-150 active:scale-[0.985]",
                      collapsed
                        ? "h-[var(--nav-item-h)] w-[var(--nav-item-h)] gap-2 px-2"
                        : "h-[var(--nav-item-h)] w-full gap-2 px-2",
                      selected
                        ? "font-medium text-foreground"
                        : "text-muted-foreground hover:bg-[var(--cds-nav-pill-hover)] hover:text-foreground",
                    )}
                  >
                    <item.icon
                      size={16}
                      strokeWidth={1.75}
                      className={cn(
                        "shrink-0 transition-[color,transform] duration-200",
                        selected
                          ? "scale-[1.04] text-clay"
                          : "text-muted-foreground/80 group-hover/item:text-foreground",
                      )}
                    />
                    <span className="nav-label min-w-0 flex-1 truncate">{item.label}</span>
                    {item.alert && !collapsed && (
                      <span
                        title={item.alertHint}
                        aria-label={item.alertHint}
                        className="ml-1 flex size-4 shrink-0 items-center justify-center"
                      >
                        <span className="size-1.5 rounded-full bg-danger/80" aria-hidden />
                      </span>
                    )}
                    {item.alert && collapsed && (
                      <span
                        className="absolute right-1 top-1 size-1.5 rounded-full bg-danger ring-2 ring-background"
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

      {/* 运行状态：压缩成两行，不再用卡片包住；整块悬停可看完整状态 */}
      <div className={cn("shrink-0", collapsed ? "flex justify-center px-3 pb-3" : "px-2 pb-2")}>
        {collapsed ? (
          <div
            title={statusTitle}
            className="flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--cds-alpha-1)]"
            aria-hidden
          >
            <span className={cn("size-2 rounded-full", dotTone)} />
          </div>
        ) : (
          <>
            <div className="footer-hairline mb-1 h-px" aria-hidden />
            <div
              title={statusTitle}
              className="rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--cds-alpha-1)]"
            >
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
                  "mt-0.5 truncate text-[10.5px]",
                  missing.length > 0 ? "text-warn" : "text-muted-foreground",
                )}
              >
                {sourceLine}
              </div>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
