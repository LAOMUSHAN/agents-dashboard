import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";
import type { SourceFilter, SourceStatus } from "../../shared/types";
import brandMark from "@/assets/brand-mark.svg";
import { toggleMaximize } from "@/lib/window";
import { cn } from "@/lib/utils";
import { fmtTokens } from "@/format";
import { DateRangePicker, useRange } from "./DateRangePicker";

/**
 * 侧边栏（统一外壳 + CDS 桌面架构）
 *
 * 全高左列，与右侧内容列共用同一块底色：侧栏不再是「另一块面板」，
 * 结构只由一条两端淡出的发丝线和留白给出，顶行与内容列同为 44px。
 * 自上而下三段：身份区（应用名 + 版本 + 收起）、分组导航、范围与运行状态。
 *
 * 排版取舍：
 * - 导航行 34px，行尾右对齐该页主指标（Token / 模型数 / 请求数 / 平均延迟），
 *   与表格「标识左、量值右」同一套对齐规则；收起时不显示指标。
 * - 选中态是整行淡带 + 贴在侧栏左缘的 2px 陶土条，条随选中项滑动。
 * - 分组标题与「数据源」标题用一条向右淡出的发丝线补足横向结构。
 * - 数据源从顶栏搬进来竖排四行：状态点 + 名称 + 新鲜度（实时 / 索引时间），
 *   脚注只留刷新节奏、时钟与版本，不再重复来源状态。
 */
export type SidebarItem = {
  value: string;
  label: string;
  icon: LucideIcon;
  /** 行尾指标：该页在当前范围下的主数值，已格式化 */
  metric?: string | null;
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

/** 收起状态由侧栏自己持有：点展开/收起只重渲染侧栏，不惊动主内容区的图表与表格。 */
const NAV_COLLAPSE_KEY = "navCollapsed";

function getInitialCollapsed(): boolean {
  return localStorage.getItem(NAV_COLLAPSE_KEY) === "1";
}

export function Sidebar({
  groups,
  active,
  onSelect,
  version,
  status,
  scope,
  onScopeChange,
  range,
  sourceTokens,
}: {
  groups: SidebarGroup[];
  active: string;
  onSelect: (value: string) => void;
  version: string;
  status: SidebarStatus;
  scope: SourceFilter;
  onScopeChange: (value: SourceFilter) => void;
  range: ReturnType<typeof useRange>;
  /** sourceId -> 区间内 input+output token；数据未到齐时为 null */
  sourceTokens: Record<string, number> | null;
}) {
  const navRef = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState<boolean>(getInitialCollapsed);
  const [barTop, setBarTop] = useState<number | null>(null);
  const [barReady, setBarReady] = useState(false);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      localStorage.setItem(NAV_COLLAPSE_KEY, c ? "0" : "1");
      return !c;
    });
  };

  // Tauri 窗口拖拽调窄:<1120px 自动收起侧栏,恢复宽度不自动展开(尊重用户手动选择)
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 1120) {
        setCollapsed((c) => {
          if (!c) localStorage.setItem(NAV_COLLAPSE_KEY, "1");
          return true;
        });
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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

  // 选中条落位：纵坐标只受选中项和收起态（行高/分组标题）影响，与窗口宽度无关。
  // 不用 ResizeObserver 逐帧跟随宽度动画（那会让侧栏每帧重渲染）；只在状态变化时测一次，
  // 并在 200ms 宽度动画结束后补一次，选中条自身的 320ms 弹簧过渡会覆盖中间帧。
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const selected = nav.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
      if (!selected) {
        setBarTop(null);
        return;
      }
      const navRect = nav.getBoundingClientRect();
      const itemRect = selected.getBoundingClientRect();
      const top = itemRect.top - navRect.top + nav.scrollTop + (itemRect.height - 18) / 2;
      setBarTop(top);
    };
    measure();
    const settle = window.setTimeout(measure, 220);
    return () => clearTimeout(settle);
  }, [active, collapsed]);

  // 首帧先把选中条放到位置，再开启过渡，避免启动时从顶部滑下来
  useLayoutEffect(() => {
    if (barTop == null || barReady) return;
    const frame = requestAnimationFrame(() => setBarReady(true));
    return () => cancelAnimationFrame(frame);
  }, [barTop, barReady]);

  const missing = status.sources.filter((s) => !s.available);
  // 每个源各自的取数形态：zcode 直读实时库，DSH/Claude 走增量索引，索引时间就是新鲜度
  const sourceLine =
    status.sources.length === 0
      ? "读取数据源…"
      : status.sources
          .map((s) => {
            if (!s.available) return `${s.label} 不可用`;
            if (s.id === "dsh" || s.id === "claude") {
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

  // 数据源竖排：全部 + 各来源；行尾是区间内的总 Token，来源新鲜度留在脚注 tooltip 里
  const totalTokens = sourceTokens
    ? Object.values(sourceTokens).reduce((sum, n) => sum + n, 0)
    : null;
  const scopeRows: Array<{ id: SourceFilter; label: string; meta: string; warn?: boolean }> = [
    {
      id: "all",
      label: "全部",
      meta: totalTokens == null ? "" : fmtTokens(totalTokens),
    },
    ...status.sources.map((s) => ({
      id: s.id as SourceFilter,
      label: s.label,
      meta: sourceTokens ? fmtTokens(sourceTokens[s.id] ?? 0) : "",
      warn: !s.available,
    })),
  ];

  return (
    <aside
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        "relative flex shrink-0 flex-col bg-background",
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
            onClick={toggleCollapsed}
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
              onClick={toggleCollapsed}
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

      {/* 分组导航：选中条贴在左缘滑动，条目本身只留淡带 */}
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
          className="nav-bar"
          style={{
            transform: `translateY(${barTop ?? 0}px)`,
            opacity: barTop == null ? 0 : 1,
            ...(barReady ? {} : { transition: "none" }),
          }}
        />

        {groups.map((group, gi) => (
          <div key={group.id} className={gi === 0 ? undefined : collapsed ? "mt-1" : "mt-3"}>
            {collapsed ? (
              gi > 0 && <div className="mx-auto mb-1.5 h-px w-5 bg-border/70" aria-hidden />
            ) : (
              <div className="flex items-center gap-2 px-1 pb-1.5 pt-1.5 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground">
                <span>{group.label}</span>
                <span className="nav-rule" aria-hidden />
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
                        ? [
                            item.label,
                            item.metric,
                            item.alert ? item.alertHint : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : undefined
                    }
                    aria-label={collapsed ? item.label : undefined}
                    onClick={() => onSelect(item.value)}
                    className={cn(
                      "group/item relative z-10 flex items-center overflow-hidden rounded-lg text-left text-[12.5px]",
                      "transition-[background-color,color,height] duration-150 active:scale-[0.99]",
                      collapsed
                        ? "h-[var(--nav-item-h)] w-[var(--nav-item-h)] justify-center px-0"
                        : "h-[var(--nav-item-h)] w-full gap-2 px-2",
                      selected
                        ? "bg-[var(--cds-nav-pill)] font-medium text-foreground"
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
                    {!collapsed && item.metric && (
                      <span
                        className={cn(
                          "ml-auto shrink-0 font-mono text-[9.5px] tabular-nums transition-colors",
                          selected ? "text-muted-foreground" : "text-muted-foreground/55",
                        )}
                      >
                        {item.metric}
                      </span>
                    )}
                    {item.alert && !collapsed && (
                      <span
                        title={item.alertHint}
                        aria-label={item.alertHint}
                        className="ml-1 flex size-3.5 shrink-0 items-center justify-center"
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

      {/* 范围与运行状态：数据源竖排 + 时间范围 + 脚注，收起时只留状态点 */}
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
            <div className="flex items-center gap-2 px-1 pb-1 pt-2 text-[10.5px] font-medium tracking-[0.08em] text-muted-foreground">
              <span>数据源</span>
              <span className="nav-rule" aria-hidden />
              <span className="shrink-0 pr-1 font-mono text-[9.5px] font-normal tracking-[0.04em] text-muted-foreground/60">
                TOKEN
              </span>
            </div>
            <div className="space-y-0.5">
              {scopeRows.map((row) => {
                const on = scope === row.id;
                return (
                  <button
                    key={row.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onScopeChange(row.id)}
                    className={cn(
                      "flex h-[26px] w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors",
                      on
                        ? "text-foreground"
                        : "text-muted-foreground hover:bg-[var(--cds-alpha-1)] hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        on
                          ? "bg-clay"
                          : row.warn
                            ? "border border-warn"
                            : "border border-muted-foreground/40",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 truncate">{row.label}</span>
                    {row.meta && (
                      <span
                        className={cn(
                          "ml-auto shrink-0 font-mono text-[9.5px] tabular-nums",
                          on ? "text-muted-foreground" : "text-muted-foreground/60",
                        )}
                      >
                        {row.meta}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mt-1.5">
              <DateRangePicker {...range} variant="field" menuPlacement="right" />
            </div>
            <div className="footer-hairline mt-2.5 h-px" aria-hidden />
            <div
              title={statusTitle}
              className="mt-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10px] text-muted-foreground"
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", dotTone)} aria-hidden />
              <span className="truncate">
                每 {status.refreshSec} 秒
                {status.updatedAt ? ` · ${CLOCK.format(status.updatedAt)}` : ""}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[9.5px] text-muted-foreground/70">
                v{version}
              </span>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
