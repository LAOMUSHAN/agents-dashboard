import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentStat,
  DailyActivityPoint,
  ErrorStats,
  HeatCell,
  LatencyStat,
  ModelStat,
  ModelTrendPoint,
  MonthPoint,
  ProjectStat,
  ProviderStat,
  ProviderTrendPoint,
  Summary,
  ToolStat,
  TrendPoint,
} from "../shared/types";
import { api } from "./api";
import { fmtNumber, setUsdCnyRate } from "./format";
import { cn } from "@/lib/utils";
import { ActivityHeatmap } from "./components/ActivityHeatmap";
import { AgentStatsPanel } from "./components/AgentStatsPanel";
import { ContextComposition } from "./components/ContextComposition";
import { DateRangePicker, useRange } from "./components/DateRangePicker";
import { Dropdown, type DropdownOption } from "./components/Dropdown";
import { ErrorPanel } from "./components/ErrorPanel";
import { InsightCard } from "./components/InsightCard";
import { LatencyPanel } from "./components/LatencyPanel";
import { ModelTrendChart } from "./components/ModelTrendChart";
import { PricingPanel } from "./components/PricingPanel";
import { ProviderPanel } from "./components/ProviderPanel";
import { ProviderTable } from "./components/ProviderTable";
import { ProviderTrendChart } from "./components/ProviderTrendChart";
import { RequestLog } from "./components/RequestLog";
import { SummaryCards } from "./components/SummaryCards";
import { TitleBar } from "./components/TitleBar";
import { ToolStatsPanel } from "./components/ToolStatsPanel";
import { TrendChart } from "./components/TrendChart";
import { WasteRankPanel } from "./components/WasteRankPanel";
import { YearCalendar } from "./components/YearCalendar";
import { getThemeMode, setThemeMode, type ThemeMode } from "./theme";
import {
  ChartNoAxesColumn,
  ChevronDown,
  ClipboardList,
  Contrast,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  ScrollText,
  Settings,
  Stethoscope,
  Sun,
  type LucideIcon,
} from "lucide-react";

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: LucideIcon }[] = [
  { value: "auto", label: "自动", icon: Contrast },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
];

const REFRESH_OPTIONS = [5, 30, 60, 120];
const REFRESH_KEY = "refreshSec";
const REFRESH_DROPDOWN_OPTIONS: DropdownOption<number>[] = REFRESH_OPTIONS.map((s) => ({
  value: s,
  label: `${s} 秒`,
}));

function getRefreshSec(): number {
  const v = Number(localStorage.getItem(REFRESH_KEY));
  return REFRESH_OPTIONS.includes(v) ? v : 5;
}

// 内容分区:面板较多,按主题拆成标签页避免整页无限滚动
const TABS = [
  { value: "overview", label: "总览", icon: ChartNoAxesColumn },
  { value: "breakdown", label: "用量明细", icon: ClipboardList },
  { value: "health", label: "健康与性能", icon: Stethoscope },
  { value: "log", label: "请求日志", icon: ScrollText },
  { value: "settings", label: "供应商与模型", icon: Settings },
] as const;
type Tab = (typeof TABS)[number]["value"];
const TAB_KEY = "activeTab";

function getInitialTab(): Tab {
  const v = localStorage.getItem(TAB_KEY);
  return TABS.some((t) => t.value === v) ? (v as Tab) : "overview";
}

// 侧栏收起状态持久化;视口过窄时强制收起(AITracker 的 <1120px 规则)
const NAV_COLLAPSE_KEY = "navCollapsed";

function getInitialNavCollapsed(): boolean {
  return localStorage.getItem(NAV_COLLAPSE_KEY) === "1";
}

export default function App() {
  const rangeState = useRange();
  const { range } = rangeState;
  const [summary, setSummary] = useState<Summary | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [modelTrend, setModelTrend] = useState<ModelTrendPoint[]>([]);
  const [providerTrend, setProviderTrend] = useState<ProviderTrendPoint[]>([]);
  const [models, setModels] = useState<ModelStat[]>([]);
  const [projects, setProjects] = useState<ProjectStat[]>([]);
  const [providers, setProviders] = useState<ProviderStat[]>([]);
  // 趋势图图例用展示名,映射关系直接取自供应商表格的数据
  const providerNames = useMemo(
    () => Object.fromEntries(providers.map((p) => [p.providerId, p.name])),
    [providers],
  );
  const [tools, setTools] = useState<ToolStat[]>([]);
  const [agents, setAgents] = useState<AgentStat[]>([]);
  const [errors, setErrors] = useState<ErrorStats | null>(null);
  const [latency, setLatency] = useState<LatencyStat[]>([]);
  const [activity, setActivity] = useState<HeatCell[]>([]);
  const [activityDaily, setActivityDaily] = useState<DailyActivityPoint[]>([]);
  const [monthlyTrend, setMonthlyTrend] = useState<MonthPoint[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshSec, setRefreshSecState] = useState<number>(getRefreshSec);
  const [themeMode, setThemeModeState] = useState<ThemeMode>(getThemeMode);
  const [tab, setTab] = useState<Tab>(getInitialTab);
  const [navCollapsed, setNavCollapsed] = useState<boolean>(getInitialNavCollapsed);
  // 总览默认只展示结论层,其余分析面板按需展开
  const [showMore, setShowMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const themeOpt = THEME_OPTIONS.find((o) => o.value === themeMode);

  const switchTab = (t: Tab) => {
    setTab(t);
    localStorage.setItem(TAB_KEY, t);
    window.scrollTo({ top: 0 });
  };

  const toggleNav = () => {
    setNavCollapsed((c) => {
      localStorage.setItem(NAV_COLLAPSE_KEY, c ? "0" : "1");
      return !c;
    });
  };

  // Tauri 窗口拖拽调宽:<1120px 自动收起侧栏,恢复宽度不自动展开(尊重用户手动选择)
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 1120) {
        setNavCollapsed((c) => {
          if (!c) localStorage.setItem(NAV_COLLAPSE_KEY, "1");
          return true;
        });
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const setRefreshSec = (sec: number) => {
    localStorage.setItem(REFRESH_KEY, String(sec));
    setRefreshSecState(sec);
  };

  // 汇率:金额统一以美元存储,各费用单元格再按该行价格表的币种换算(改完单价后由 reloadKey 重新拉取)
  useEffect(() => {
    api
      .pricing()
      .then((cfg) => setUsdCnyRate(cfg.usdCnyRate))
      .catch(() => undefined);
  }, [reloadKey]);

  // 定时刷新:到点触发一次重新加载
  useEffect(() => {
    if (!refreshSec) return;
    const id = window.setInterval(() => setReloadKey((k) => k + 1), refreshSec * 1000);
    return () => window.clearInterval(id);
  }, [refreshSec]);

  const setTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    setThemeModeState(mode);
  };

  // 切范围时保留旧数据，避免 30 天查询期间整页空白；
  // 刷新 tick 撞上进行中的查询直接跳过，避免请求在阻塞线程池里排队。
  const lastRangeRef = useRef(range);
  const busyRef = useRef(false);
  const reqSeq = useRef(0);
  useEffect(() => {
    const rangeChanged = lastRangeRef.current !== range;
    lastRangeRef.current = range;
    if (!rangeChanged && busyRef.current) return;

    let alive = true;
    const seq = ++reqSeq.current;
    const timer = window.setTimeout(
      () => {
        busyRef.current = true;
        setLoading(true);
        api
          .dashboard(range)
          .then((d) => {
            if (!alive || seq !== reqSeq.current) return;
            setSummary(d.summary);
            setTrend(d.trend);
            setModelTrend(d.modelTrend);
            setProviderTrend(d.providerTrend);
            setModels(d.models);
            setProjects(d.projects);
            setProviders(d.providers);
            setTools(d.tools);
            setAgents(d.agents);
            setErrors(d.errors);
            setLatency(d.latency);
            setActivity(d.activity);
            setActivityDaily(d.activityDaily);
            setMonthlyTrend(d.monthlyTrend);
          })
          .catch((e) => {
            if (alive && seq === reqSeq.current) console.error("加载仪表盘数据失败", e);
          })
          .finally(() => {
            if (seq !== reqSeq.current) return;
            busyRef.current = false;
            if (alive) setLoading(false);
          });
      },
      rangeChanged ? 120 : 0,
    );

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [range, reloadKey]);

  const navItem = (t: (typeof TABS)[number]) => {
    const active = tab === t.value;
    return (
      <button
        key={t.value}
        role="tab"
        aria-selected={active}
        title={navCollapsed ? t.label : undefined}
        className={cn(
          "group relative flex w-full items-center rounded-lg text-[13px] font-medium transition-colors duration-150",
          navCollapsed ? "h-9 justify-center px-0" : "gap-2.5 px-3 py-2",
          active
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        )}
        onClick={() => switchTab(t.value)}
      >
        {active && (
          <span
            className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-clay"
            aria-hidden
          />
        )}
        <t.icon size={16} className={cn("shrink-0", active && "text-clay")} />
        {!navCollapsed && <span className="truncate">{t.label}</span>}
        {!navCollapsed && t.value === "health" && errors && errors.error > 0 && (
          <span className="ml-auto inline-flex items-center rounded-full bg-danger/12 px-1.5 py-px text-[10px] font-semibold tabular-nums text-danger">
            {fmtNumber(errors.error)}
          </span>
        )}
      </button>
    );
  };

  const currentTab = TABS.find((t) => t.value === tab) ?? TABS[0];
  const TAB_HINTS: Record<Tab, string> = {
    overview: "区间用量、费用与健康度",
    breakdown: "按供应商 / 模型 / 项目拆解",
    health: "错误、延迟与工具调用",
    log: "按会话分组的请求明细",
    settings: "供应商与模型单价",
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar title={currentTab.label} hint={TAB_HINTS[tab]} busy={loading}>
        <DateRangePicker {...rangeState} />
        <Dropdown
          value={refreshSec}
          options={REFRESH_DROPDOWN_OPTIONS}
          onChange={setRefreshSec}
          icon={RefreshCw}
          title="定时刷新"
        />
        <Dropdown
          value={themeMode}
          options={THEME_OPTIONS}
          onChange={setTheme}
          icon={themeOpt?.icon}
          title="主题(自动跟随系统)"
        />
      </TitleBar>

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200",
            navCollapsed ? "w-16" : "w-[208px]",
          )}
        >
          <div
            className={cn(
              "flex h-10 items-center border-b border-sidebar-border",
              navCollapsed ? "justify-center px-2" : "justify-between px-4",
            )}
          >
            {!navCollapsed && (
              <span className="text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                导航
              </span>
            )}
            {!navCollapsed && (
              <span className="font-mono text-[9px] text-muted-foreground/70">v{__APP_VERSION__}</span>
            )}
          </div>
          <nav className="app-nav cds-scroll-fade flex-1 space-y-1 overflow-y-auto px-3 py-3" role="tablist">
            {TABS.map(navItem)}
          </nav>
          <div className="border-t border-sidebar-border p-3">
            <button
              className="flex h-8 w-full items-center justify-center gap-2 rounded-lg text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={toggleNav}
              title={navCollapsed ? "展开侧栏" : "收起"}
            >
              {navCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              {!navCollapsed && <span>收起</span>}
            </button>
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[1440px] flex-col gap-4 px-5 pb-16 pt-5">
            {tab === "overview" && (
              <>
                <InsightCard summary={summary} models={models} providers={providers} />
                <SummaryCards summary={summary} trend={trend} />
                <TrendChart points={trend} monthly={monthlyTrend} />
                <button
                  className="mx-auto inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => setShowMore((v) => !v)}
                >
                  {showMore ? "收起更多分析" : "展开更多分析"}
                  <ChevronDown size={13} className={cn("transition-transform", showMore && "rotate-180")} />
                </button>
                {showMore && (
                  <div className="cds-pop flex flex-col gap-4">
                    <ModelTrendChart points={modelTrend} />
                    <ProviderTrendChart points={providerTrend} names={providerNames} />
                    <ContextComposition summary={summary} tools={tools} />
                    <ActivityHeatmap cells={activity} />
                    <YearCalendar points={activityDaily} />
                    <AgentStatsPanel stats={agents} />
                    <WasteRankPanel projects={projects} models={models} providers={providers} />
                  </div>
                )}
              </>
            )}

            {tab === "breakdown" && <ProviderTable stats={providers} models={models} projects={projects} />}

            {tab === "health" && (
              <>
                <div className="grid-2">
                  <ErrorPanel stats={errors} />
                  <LatencyPanel stats={latency} />
                </div>
                <ToolStatsPanel stats={tools} />
              </>
            )}

            {tab === "log" && <RequestLog range={range} />}

            {tab === "settings" && (
              <>
                <ProviderPanel />
                <PricingPanel range={range} models={models} onSaved={() => setReloadKey((k) => k + 1)} />
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}


