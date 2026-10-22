import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AgentStat,
  ErrorStats,
  HeatCell,
  LatencyStat,
  ModelStat,
  ModelTrendPoint,
  MonthPoint,
  ProjectStat,
  ProviderStat,
  ProviderTrendPoint,
  SourceFilter,
  SourceStatus,
  Summary,
  ToolStat,
  TrendPoint,
} from "../shared/types";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
import { OverviewModulesPanel } from "./components/OverviewModulesPanel";
import { PricingPanel } from "./components/PricingPanel";
import { ProviderTable } from "./components/ProviderTable";
import { ProviderTrendChart } from "./components/ProviderTrendChart";
import { RequestLog } from "./components/RequestLog";
import { SourceScope } from "./components/SourceScope";
import { SummaryCards } from "./components/SummaryCards";
import { TitleBar } from "./components/TitleBar";
import { ToolStatsPanel } from "./components/ToolStatsPanel";
import { TrendChart } from "./components/TrendChart";
import { WasteRankPanel } from "./components/WasteRankPanel";
import { getThemeMode, setThemeMode, type ThemeMode } from "./theme";
import {
  defaultOverviewLayout,
  normalizeOverviewLayout,
  type OverviewLayout,
} from "./overviewModules";
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

// 数据源范围：全部 / zcode / DSH；落盘 ui-prefs.json，localStorage 只作即时缓存
const SOURCE_KEY = "sourceScope";

function getInitialSource(): SourceFilter {
  const v = localStorage.getItem(SOURCE_KEY);
  return v === "zcode" || v === "dsh" ? v : "all";
}

// 内容分区:面板较多,按主题拆成标签页避免整页无限滚动
const TABS = [
  { value: "overview", label: "总览", icon: ChartNoAxesColumn },
  { value: "breakdown", label: "用量明细", icon: ClipboardList },
  { value: "health", label: "健康与性能", icon: Stethoscope },
  { value: "log", label: "请求日志", icon: ScrollText },
  { value: "settings", label: "设置", icon: Settings },
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
  // 趋势图图例用展示名；同名供应商（同一中转被两个源使用）追加来源后缀
  const providerNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of providers) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    return Object.fromEntries(
      providers.map((p) => [
        p.providerId,
        (counts.get(p.name) ?? 0) > 1
          ? `${p.name} · ${p.source === "dsh" ? "DSH" : "zcode"}`
          : p.name,
      ]),
    );
  }, [providers]);
  // 来源构成（请求/tokens）：模型行已按 (source, model) 拆分，直接汇总即可
  const sourceTotals = useMemo(() => {
    const map = new Map<string, { requests: number; tokens: number }>();
    for (const m of models) {
      const cur = map.get(m.source) ?? { requests: 0, tokens: 0 };
      cur.requests += m.requests;
      cur.tokens += m.inputTokens + m.outputTokens;
      map.set(m.source, cur);
    }
    return [...map.entries()].map(([id, v]) => ({ id, ...v }));
  }, [models]);
  const [tools, setTools] = useState<ToolStat[]>([]);
  const [agents, setAgents] = useState<AgentStat[]>([]);
  const [errors, setErrors] = useState<ErrorStats | null>(null);
  const [latency, setLatency] = useState<LatencyStat[]>([]);
  const [activity, setActivity] = useState<HeatCell[]>([]);
  const [monthlyTrend, setMonthlyTrend] = useState<MonthPoint[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshSec, setRefreshSecState] = useState<number>(getRefreshSec);
  const [source, setSource] = useState<SourceFilter>(getInitialSource);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  // 隐藏到托盘时暂停刷新与索引；唤回时补一次
  const [visible, setVisible] = useState(true);
  const [themeMode, setThemeModeState] = useState<ThemeMode>(getThemeMode);
  const [tab, setTab] = useState<Tab>(getInitialTab);
  const [navCollapsed, setNavCollapsed] = useState<boolean>(getInitialNavCollapsed);
  // 总览模块的顺序与显隐；旧版的「展开更多分析」折叠按钮由设置页取代
  const [overviewLayout, setOverviewLayout] = useState<OverviewLayout>(() => defaultOverviewLayout());
  const [loading, setLoading] = useState(false);
  // 后端查询失败时把原因留在界面上：以前只 console.error，整页会停在空数据，
  // 看起来像「应用没数据」而不是「查询出错」
  const [loadError, setLoadError] = useState<string | null>(null);
  // ui-prefs.json 是整文件写入：保存前先合并已有字段，避免两个设置互相覆盖
  const prefsRef = useRef<Record<string, unknown>>({});
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

  const savePrefs = (patch: Record<string, unknown>) => {
    prefsRef.current = { ...prefsRef.current, ...patch };
    api.saveUiPrefs(prefsRef.current).catch(() => undefined);
  };

  const setRefreshSec = (sec: number) => {
    localStorage.setItem(REFRESH_KEY, String(sec));
    setRefreshSecState(sec);
    savePrefs({ refreshSec: sec });
  };

  const setSourceScope = (v: SourceFilter) => {
    setSource(v);
    localStorage.setItem(SOURCE_KEY, v);
    savePrefs({ sourceScope: v });
  };

  const updateOverviewLayout = (next: OverviewLayout) => {
    setOverviewLayout(next);
    savePrefs({ overviewModules: next });
  };

  // 刷新间隔以配置文件为准（localStorage 只作即时缓存），
  // 修掉 WebView 存储被清理或 dev/release 换源后重启回到 5 秒的问题
  useEffect(() => {
    api
      .getUiPrefs()
      .then((prefs) => {
        prefsRef.current = prefs;
        const v = Number(prefs.refreshSec);
        if (REFRESH_OPTIONS.includes(v)) {
          localStorage.setItem(REFRESH_KEY, String(v));
          setRefreshSecState(v);
        }
        const s = prefs.sourceScope;
        if (s === "all" || s === "zcode" || s === "dsh") {
          localStorage.setItem(SOURCE_KEY, s);
          setSource(s);
        }
        setOverviewLayout(normalizeOverviewLayout(prefs.overviewModules));
      })
      .catch(() => undefined);
  }, []);

  // 托盘隐藏/唤回：隐藏时停掉 5 秒刷新与 DSH 索引，唤回立即补一次。
  // App 退出后进程结束，不会留下任何后台活动。
  useEffect(() => {
    let unHide: UnlistenFn | undefined;
    let unShow: UnlistenFn | undefined;
    listen("window-hidden", () => setVisible(false))
      .then((u) => (unHide = u))
      .catch(() => undefined);
    listen("window-shown", () => {
      setVisible(true);
      setReloadKey((k) => k + 1);
    })
      .then((u) => (unShow = u))
      .catch(() => undefined);
    return () => {
      unHide?.();
      unShow?.();
    };
  }, []);

  // 汇率:金额统一以美元存储,各费用单元格再按该行价格表的币种换算(改完单价后由 reloadKey 重新拉取)
  useEffect(() => {
    api
      .pricing()
      .then((cfg) => setUsdCnyRate(cfg.usdCnyRate))
      .catch(() => undefined);
  }, [reloadKey]);

  // 定时刷新:到点触发一次重新加载；隐藏到托盘时停表（唤回由 window-shown 补一次）
  useEffect(() => {
    if (!refreshSec || !visible) return;
    const id = window.setInterval(() => setReloadKey((k) => k + 1), refreshSec * 1000);
    return () => window.clearInterval(id);
  }, [refreshSec, visible]);

  const setTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    setThemeModeState(mode);
  };

  // 切范围/切数据源时保留旧数据，避免 30 天查询期间整页空白；
  // 刷新 tick 撞上进行中的查询直接跳过，避免请求在阻塞线程池里排队。
  const lastRangeRef = useRef(range);
  const lastSourceRef = useRef(source);
  const busyRef = useRef(false);
  const reqSeq = useRef(0);
  useEffect(() => {
    const rangeChanged = lastRangeRef.current !== range;
    const sourceChanged = lastSourceRef.current !== source;
    lastRangeRef.current = range;
    lastSourceRef.current = source;
    if (!rangeChanged && !sourceChanged && busyRef.current) return;

    let alive = true;
    const seq = ++reqSeq.current;
    const timer = window.setTimeout(
      () => {
        busyRef.current = true;
        setLoading(true);
        api
          .dashboard(range, source)
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
            setMonthlyTrend(d.monthlyTrend);
            setSources(d.sources);
            setCapabilities(d.capabilities);
            setLoadError(null);
          })
          .catch((e) => {
            if (alive && seq === reqSeq.current) {
              console.error("加载仪表盘数据失败", e);
              setLoadError(String(e));
            }
          })
          .finally(() => {
            if (seq !== reqSeq.current) return;
            busyRef.current = false;
            if (alive) setLoading(false);
          });
      },
      rangeChanged || sourceChanged ? 120 : 0,
    );

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [range, reloadKey, source]);

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
    settings: "总览模块与计费规则",
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar title={currentTab.label} hint={TAB_HINTS[tab]} busy={loading}>
        {tab !== "settings" && (
          <SourceScope value={source} onChange={setSourceScope} sources={sources} />
        )}
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
            {loadError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-panel border border-danger/25 bg-danger/8 px-4 py-3 text-[12px] leading-relaxed text-danger"
              >
                <span className="font-semibold">数据加载失败</span>
                <span className="min-w-0 break-words text-danger/90">{loadError}</span>
              </div>
            )}
            {sources
              .filter((s) => !s.available)
              .map((s) => (
                <div
                  key={s.id}
                  role="status"
                  className="flex items-start gap-2 rounded-panel border border-warn/25 bg-warn/8 px-4 py-3 text-[12px] leading-relaxed text-warn"
                >
                  <span className="font-semibold">{s.label} 不可用</span>
                  <span className="min-w-0 break-words text-warn/90">
                    {s.error ?? "该数据源当前没有可用数据；全部范围只显示另一个源。"}
                  </span>
                </div>
              ))}
            {tab === "overview" && (
              <>
                {overviewLayout.visible.map((id) => {
                  let node: ReactNode = null;
                  switch (id) {
                    case "insight":
                      node = (
                        <InsightCard
                          summary={summary}
                          models={models}
                          providers={providers}
                          sourceTotals={sourceTotals}
                        />
                      );
                      break;
                    case "summary":
                      node = <SummaryCards summary={summary} trend={trend} capabilities={capabilities} source={source} />;
                      break;
                    case "trend":
                      node = <TrendChart points={trend} monthly={monthlyTrend} />;
                      break;
                    case "modelTrend":
                      node = <ModelTrendChart points={modelTrend} />;
                      break;
                    case "providerTrend":
                      node = <ProviderTrendChart points={providerTrend} names={providerNames} />;
                      break;
                    case "context":
                      node = <ContextComposition summary={summary} tools={tools} />;
                      break;
                    case "activity":
                      node = (
                        <ActivityHeatmap
                          cells={activity}
                          preset={rangeState.preset}
                          range={range}
                          customFrom={rangeState.customFrom}
                          customTo={rangeState.customTo}
                        />
                      );
                      break;
                    case "agents":
                      node = <AgentStatsPanel stats={agents} />;
                      break;
                    case "waste":
                      node = <WasteRankPanel projects={projects} models={models} providers={providers} />;
                      break;
                  }
                  return (
                    <div key={id} className="contents">
                      {node}
                    </div>
                  );
                })}
                {overviewLayout.visible.length === 0 && (
                  <div className="rounded-panel border border-dashed border-border bg-card/40 px-6 py-10 text-center">
                    <p className="text-[13px] font-medium text-foreground">总览模块已全部隐藏</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      在「设置 → 总览模块」里把需要的模块拖回展示区。
                    </p>
                    <button
                      type="button"
                      onClick={() => switchTab("settings")}
                      className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-full border border-border/70 bg-accent/40 px-3 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
                    >
                      <Settings size={12} />
                      去设置
                    </button>
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
                <ToolStatsPanel
                  stats={tools}
                  partialCancelled={capabilities.includes("toolCancelled")}
                />
              </>
            )}

            {tab === "log" && <RequestLog range={range} source={source} />}

            {tab === "settings" && (
              <>
                <OverviewModulesPanel layout={overviewLayout} onChange={updateOverviewLayout} />
                <PricingPanel range={range} models={models} onSaved={() => setReloadKey((k) => k + 1)} />
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}


