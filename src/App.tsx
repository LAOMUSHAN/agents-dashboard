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
import { ToolStatsPanel } from "./components/ToolStatsPanel";
import { TrendChart } from "./components/TrendChart";
import { WasteRankPanel } from "./components/WasteRankPanel";
import { YearCalendar } from "./components/YearCalendar";
import { getThemeMode, setThemeMode, type ThemeMode } from "./theme";
import {
  ChartNoAxesColumn,
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

  // 只有切换时间范围时才清空旧数据;定时刷新等触发的 reload 静默替换,避免闪烁
  const lastRangeRef = useRef(range);
  useEffect(() => {
    let alive = true;
    if (lastRangeRef.current !== range) {
      lastRangeRef.current = range;
      setSummary(null);
      setTrend([]);
      setModelTrend([]);
      setProviderTrend([]);
      setModels([]);
      setProjects([]);
      setProviders([]);
      setTools([]);
      setAgents([]);
      setErrors(null);
      setLatency([]);
      setActivity([]);
      setActivityDaily([]);
      setMonthlyTrend([]);
    }
    Promise.all([
      api.summary(range),
      api.trend(range),
      api.modelTrend(range),
      api.providerTrend(range),
      api.models(range),
      api.projects(range),
      api.providers(range),
      api.tools(range),
      api.agents(range),
      api.errors(range),
      api.latency(range),
      api.activity(range),
      api.activityDaily(range),
      api.monthlyTrend(range),
    ]).then(([s, t, mt, pt, m, p, pv, tl, ag, e, lat, act, ad, mo]) => {
      if (!alive) return;
      setSummary(s);
      setTrend(t);
      setModelTrend(mt);
      setProviderTrend(pt);
      setModels(m);
      setProjects(p);
      setProviders(pv);
      setTools(tl);
      setAgents(ag);
      setErrors(e);
      setLatency(lat);
      setActivity(act);
      setActivityDaily(ad);
      setMonthlyTrend(mo);
    });
    return () => {
      alive = false;
    };
  }, [range, reloadKey]);

  const navItem = (t: (typeof TABS)[number]) => (
    <button
      key={t.value}
      role="tab"
      aria-selected={tab === t.value}
      title={navCollapsed ? t.label : undefined}
      className={
        "group relative flex w-full items-center rounded-lg text-[13px] font-medium transition-colors " +
        (navCollapsed ? "h-9 justify-center px-0 " : "gap-2.5 px-3 py-2 ") +
        (tab === t.value
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground")
      }
      onClick={() => switchTab(t.value)}
    >
      {tab === t.value && (
        <span className="absolute left-0 h-4 w-0.5 -translate-x-2.5 rounded-full bg-primary" aria-hidden />
      )}
      <t.icon size={16} className="shrink-0" />
      {!navCollapsed && <span className="truncate">{t.label}</span>}
      {!navCollapsed && t.value === "health" && errors && errors.error > 0 && (
        <span className="ml-auto inline-flex items-center rounded-full bg-rose-500/15 px-1.5 py-px text-[10px] font-semibold text-rose-600 dark:text-rose-400">
          {fmtNumber(errors.error)}
        </span>
      )}
    </button>
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside
        className={
          "fixed inset-y-0 left-0 z-20 flex flex-col border-r border-border bg-card/60 backdrop-blur transition-[width] duration-200 " +
          (navCollapsed ? "w-16" : "w-[180px]")
        }
      >
        <div className={"flex h-[68px] items-center border-b border-border " + (navCollapsed ? "justify-center px-2" : "px-4")}>
          {navCollapsed ? (
            <span className="text-base font-bold tracking-tight text-primary" title="Agents Dashboard">
              Z
            </span>
          ) : (
            <div className="min-w-0">
              <h1 className="flex items-baseline gap-1.5 text-sm font-semibold tracking-tight">
                Agents Dashboard
                <span className="rounded border border-border bg-muted/40 px-1 font-mono text-[9px] font-medium text-muted-foreground" title="应用版本">
                  v{__APP_VERSION__}
                </span>
              </h1>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">本地数据实时统计</div>
            </div>
          )}
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3" role="tablist">
          {TABS.map(navItem)}
        </nav>
        <div className="border-t border-border p-3">
          {!navCollapsed && (
            <div className="flex flex-col gap-2">
              <DateRangePicker {...rangeState} />
              <Dropdown
                dropUp
                value={refreshSec}
                options={REFRESH_DROPDOWN_OPTIONS}
                onChange={setRefreshSec}
                icon={RefreshCw}
                title="定时刷新"
              />
              <Dropdown
                dropUp
                value={themeMode}
                options={THEME_OPTIONS}
                onChange={setTheme}
                icon={themeOpt?.icon}
                title="主题(自动跟随系统)"
              />
            </div>
          )}
          <button
            className={cn(
              "flex h-8 w-full items-center justify-center gap-2 rounded-lg text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              !navCollapsed && "mt-2",
            )}
            onClick={toggleNav}
            title={navCollapsed ? "展开侧栏" : "收起"}
          >
            {navCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            {!navCollapsed && <span>收起</span>}
          </button>
        </div>
      </aside>

      <div className={"transition-[padding] duration-200 " + (navCollapsed ? "pl-16" : "pl-[180px]")}>
        <main className="mx-auto flex max-w-[1440px] flex-col gap-4 px-5 pb-16 pt-4">
        {tab === "overview" && (
          <>
            <InsightCard summary={summary} models={models} providers={providers} />
            <SummaryCards summary={summary} />
            <TrendChart points={trend} monthly={monthlyTrend} />
            <ModelTrendChart points={modelTrend} />
            <ProviderTrendChart points={providerTrend} names={providerNames} />
            <ContextComposition summary={summary} tools={tools} />
            <ActivityHeatmap cells={activity} />
            <YearCalendar points={activityDaily} />
            <AgentStatsPanel stats={agents} />
            <WasteRankPanel projects={projects} models={models} providers={providers} />
          </>
        )}

        {tab === "breakdown" && (
          <ProviderTable stats={providers} models={models} projects={projects} />
        )}

        {tab === "health" && (
          <>
            <div className="grid-2">
              <ErrorPanel stats={errors} />
              <LatencyPanel stats={latency} />
            </div>
            <ToolStatsPanel stats={tools} />
          </>
        )}

        {tab === "log" && <RequestLog range={range} reloadKey={reloadKey} />}

        {tab === "settings" && (
          <>
            <ProviderPanel />
            <PricingPanel range={range} onSaved={() => setReloadKey((k) => k + 1)} />
          </>
        )}
        </main>
      </div>
    </div>
  );
}
