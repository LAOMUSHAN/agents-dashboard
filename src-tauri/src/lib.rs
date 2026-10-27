mod db;
mod dsh;
mod error;
mod pricing;
mod providers;
mod queries;
mod sources;
mod types;
mod unified;

use error::AppError;
use serde::Serialize;
use sources::{SourceFilter, SourceStatus};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

/// 进程内共享状态；命令与后台任务都拿 Arc<Inner>，避免跨线程移动 MutexGuard。
pub struct Inner {
    /// zcode 只读库路径；不存在时统一查询层用空表顶上
    zcode_path: PathBuf,
    /// DSH 索引库（可重建的缓存）；只在运行期由查询触发更新
    index_path: PathBuf,
    /// DSH 索引器；Mutex 保证同一时刻只有一个刷新在跑
    dsh: Mutex<dsh::DshIndexer>,
    /// 主窗口是否可见；隐藏到托盘时即使前端还有漏网的刷新，也不做索引扫描/写入
    visible: AtomicBool,
    pricing_path: PathBuf,
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Inner>,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.inner
    }
}

impl AppState {
    /// 单源查询连接（旧的逐项命令用；主面板走 get_dashboard）。
    /// 每次调用前补一次 DSH 增量；索引器内部有 10 秒节流，不会反复扫盘。
    fn conn(&self) -> Result<rusqlite::Connection, String> {
        self.ensure_dsh(false);
        self.query_conn(SourceFilter::All).map_err(|e| e.to_string())
    }
}

impl Inner {
    /// 运行期唯一入口：查询前补一次 DSH 增量。没有后台线程；App 退出后不再被调用。
    fn ensure_dsh(&self, full: bool) -> dsh::IndexStats {
        let mut indexer = self.dsh.lock().expect("dsh index mutex poisoned");
        // 隐藏到托盘时不扫盘、不写索引；只返回上一次索引的统计
        if !self.visible.load(Ordering::Relaxed) {
            return indexer
                .stats()
                .unwrap_or_else(|e| dsh::IndexStats::error(e.to_string()));
        }
        match indexer.ensure_fresh(full) {
            Ok(stats) => stats,
            Err(e) => dsh::IndexStats::error(e.to_string()),
        }
    }

    fn query_conn(&self, filter: SourceFilter) -> Result<rusqlite::Connection, AppError> {
        unified::open_query(&self.index_path, &self.zcode_path, filter)
    }

    fn source_statuses(&self, dsh_stats: &dsh::IndexStats) -> Vec<SourceStatus> {
        vec![
            SourceStatus {
                id: sources::SourceId::Zcode.as_str(),
                label: sources::SourceId::Zcode.label(),
                available: self.zcode_path.exists(),
                indexed_at: 0,
                error: None,
            },
            SourceStatus {
                id: sources::SourceId::Dsh.as_str(),
                label: sources::SourceId::Dsh.label(),
                available: dsh_stats.available,
                indexed_at: dsh_stats.indexed_at,
                error: dsh_stats.last_error.clone(),
            },
        ]
    }

    /// 供应商展示名：两个源的 provider id 都加 source 前缀，
    /// 避免同一个中转在聚合视图里被误合并。
    fn provider_names(&self) -> HashMap<String, String> {
        let mut names = HashMap::new();
        for (id, name) in providers::load_provider_names() {
            names.insert(format!("zc:{id}"), name);
        }
        for (id, name) in providers::load_dsh_provider_names() {
            names.insert(format!("dsh:{id}"), name);
        }
        names
    }

    /// 一次查询返回仪表盘需要的全部数据；同步实现，由命令层放到阻塞线程池执行。
    /// 14 条查询各自独立只读连接并行跑；连接由统一查询层创建（视图已按 source 过滤）。
    /// `rate_window_sec` 是实时速度的采样窗口（秒），缺省时该字段为 None。
    fn query_dashboard(
        &self,
        range: &types::Range,
        filter: SourceFilter,
        rate_window_sec: Option<i64>,
    ) -> Result<types::DashboardPayload, AppError> {
        let dsh_stats = self.ensure_dsh(false);
        let p = &self.pricing_path;
        let names = self.provider_names();
        let rate_window = rate_window_sec.map(|s| s.clamp(1, 86_400));
        // 窗口终点与面板查询同一时刻，避免速度指标比面板早/晚一个刷新周期
        let rate_now = queries::now_ms();
        let mut conns = Vec::with_capacity(14);
        for _ in 0..14 {
            conns.push(self.query_conn(filter)?);
        }
        // 每条查询独占一个连接：Connection 不是 Sync，必须 move 进各自线程
        let [c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13] =
            <[rusqlite::Connection; 14]>::try_from(conns).expect("连接数固定为 14");

        let (summary, trend, model_trend, provider_trend, models, projects, providers, tools, agents, errors, latency, activity, monthly_trend, token_rate) =
            std::thread::scope(|s| -> Result<_, AppError> {
                let summary = s.spawn(move || queries::get_summary(&c0, range, p));
                let trend = s.spawn(move || queries::get_trend(&c1, range, p));
                let model_trend = s.spawn(move || queries::get_trend_by_model(&c2, range, p));
                let provider_trend = s.spawn(move || queries::get_trend_by_provider(&c3, range, p));
                let models = s.spawn(move || queries::get_model_stats(&c4, range, p));
                let projects = s.spawn(move || queries::get_project_stats(&c5, range, p));
                let providers = s.spawn(move || queries::get_provider_stats(&c6, range, p, &names));
                let tools = s.spawn(move || queries::get_tool_stats(&c7, range));
                let agents = s.spawn(move || queries::get_agent_stats(&c8, range));
                let errors = s.spawn(move || queries::get_error_stats(&c9, range));
                let latency = s.spawn(move || queries::get_latency_stats(&c10, range));
                let activity = s.spawn(move || queries::get_activity_heatmap(&c11, range));
                let monthly_trend = s.spawn(move || queries::get_monthly_trend(&c12, range, p));
                let token_rate = s.spawn(move || match rate_window {
                    Some(w) => queries::get_token_rate(&c13, w, rate_now).map(Some),
                    None => Ok(None),
                });

                Ok((
                    join_query("summary", summary.join())?,
                    join_query("trend", trend.join())?,
                    join_query("model_trend", model_trend.join())?,
                    join_query("provider_trend", provider_trend.join())?,
                    join_query("models", models.join())?,
                    join_query("projects", projects.join())?,
                    join_query("providers", providers.join())?,
                    join_query("tools", tools.join())?,
                    join_query("agents", agents.join())?,
                    join_query("errors", errors.join())?,
                    join_query("latency", latency.join())?,
                    join_query("activity", activity.join())?,
                    join_query("monthly_trend", monthly_trend.join())?,
                    join_query("token_rate", token_rate.join())?,
                ))
            })?;

        Ok(types::DashboardPayload {
            summary,
            trend,
            model_trend,
            provider_trend,
            models,
            projects,
            providers,
            tools,
            agents,
            errors,
            latency,
            activity,
            monthly_trend,
            token_rate,
            sources: self.source_statuses(&dsh_stats),
            capabilities: if filter.includes(sources::SourceId::Dsh) {
                // DSH 日志没有 reasoning tokens / cache write 常为 0 / tool cancelled 不可辨
                vec![
                    "reasoningTokens".to_string(),
                    "cacheCreateTokens".to_string(),
                    "toolCancelled".to_string(),
                    "decodeSpeed".to_string(),
                ]
            } else {
                Vec::new()
            },
        })
    }
}

/// 等待并行查询线程：线程 panic 与查询错误都收敛成 AppError。
fn join_query<T>(
    name: &str,
    r: std::thread::Result<rusqlite::Result<T>>,
) -> Result<T, AppError> {
    r.map_err(|_| AppError::Task(format!("{name} 查询线程异常退出")))
        .and_then(|v| v.map_err(AppError::from))
}

/// 一次刷新只走一个命令：14 个查询在同一个阻塞任务里跑完，避免 14 次 IPC 往返。
/// `rateWindowSec` 是顶栏实时速度的采样窗口，等于界面上的刷新间隔。
#[tauri::command]
async fn get_dashboard(
    state: tauri::State<'_, AppState>,
    range: types::Range,
    source: Option<SourceFilter>,
    rate_window_sec: Option<i64>,
) -> Result<types::DashboardPayload, AppError> {
    let inner = state.inner.clone();
    let filter = source.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        inner.query_dashboard(&range, filter, rate_window_sec)
    })
    .await
    .map_err(|e| AppError::Task(e.to_string()))?
}

#[tauri::command]
fn get_summary(state: tauri::State<AppState>, range: types::Range) -> Result<types::Summary, String> {
    let conn = state.conn()?;
    queries::get_summary(&conn, &range, &state.pricing_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_trend(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::TrendPoint>, String> {
    let conn = state.conn()?;
    queries::get_trend(&conn, &range, &state.pricing_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_trend_by_model(
    state: tauri::State<AppState>,
    range: types::Range,
) -> Result<Vec<types::ModelTrendPoint>, String> {
    let conn = state.conn()?;
    queries::get_trend_by_model(&conn, &range, &state.pricing_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_trend_by_provider(
    state: tauri::State<AppState>,
    range: types::Range,
) -> Result<Vec<types::ProviderTrendPoint>, String> {
    let conn = state.conn()?;
    queries::get_trend_by_provider(&conn, &range, &state.pricing_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_models(
    state: tauri::State<'_, AppState>,
    range: types::Range,
) -> Result<Vec<types::ModelStat>, AppError> {
    let inner = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        inner.ensure_dsh(false);
        let conn = inner.query_conn(SourceFilter::All)?;
        queries::get_model_stats(&conn, &range, &inner.pricing_path).map_err(AppError::from)
    })
    .await
    .map_err(|e| AppError::Task(e.to_string()))?
}

#[tauri::command]
fn get_agents(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::AgentStat>, String> {
    let conn = state.conn()?;
    queries::get_agent_stats(&conn, &range).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_monthly_trend(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::MonthPoint>, String> {
    let conn = state.conn()?;
    queries::get_monthly_trend(&conn, &range, &state.pricing_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_projects(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::ProjectStat>, String> {
    let conn = state.conn()?;
    queries::get_project_stats(&conn, &range, &state.pricing_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_providers(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::ProviderStat>, String> {
    let conn = state.conn()?;
    let names = state.provider_names();
    queries::get_provider_stats(&conn, &range, &state.pricing_path, &names).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_requests(
    state: tauri::State<'_, AppState>,
    range: types::Range,
    page: i64,
    page_size: i64,
    source: Option<SourceFilter>,
) -> Result<types::RequestLogResponse, AppError> {
    let inner = state.inner.clone();
    let filter = source.unwrap_or_default();
    let page = page.max(1);
    // 分页单位是根会话:每页返回 N 个会话分组
    let page_size = page_size.clamp(5, 50);
    tauri::async_runtime::spawn_blocking(move || {
        inner.ensure_dsh(false);
        let conn = inner.query_conn(filter)?;
        queries::get_request_log(&conn, &range, page, page_size, &inner.pricing_path)
            .map_err(AppError::from)
    })
    .await
    .map_err(|e| AppError::Task(e.to_string()))?
}

/// 界面偏好的落盘位置：与 pricing.json 同目录。
/// WebView 的 localStorage 会随数据目录清理或 dev/release 源切换而丢失，偏好走文件更稳。
fn ui_prefs_path(state: &AppState) -> std::path::PathBuf {
    state.pricing_path.with_file_name("ui-prefs.json")
}

#[tauri::command]
fn get_ui_prefs(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let path = ui_prefs_path(&state);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({}))),
        Err(_) => Ok(serde_json::json!({})),
    }
}

#[tauri::command]
fn save_ui_prefs(state: tauri::State<'_, AppState>, prefs: serde_json::Value) -> Result<(), String> {
    let path = ui_prefs_path(&state);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&prefs).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_tools(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::ToolStat>, String> {
    let conn = state.conn()?;
    queries::get_tool_stats(&conn, &range).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_errors(state: tauri::State<AppState>, range: types::Range) -> Result<types::ErrorStats, String> {
    let conn = state.conn()?;
    queries::get_error_stats(&conn, &range).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_latency(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::LatencyStat>, String> {
    let conn = state.conn()?;
    queries::get_latency_stats(&conn, &range).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_activity(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::HeatCell>, String> {
    let conn = state.conn()?;
    queries::get_activity_heatmap(&conn, &range).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_pricing(state: tauri::State<AppState>) -> Result<types::PricingConfig, String> {
    Ok((*pricing::load(&state.pricing_path)).clone())
}

#[tauri::command]
fn save_pricing(state: tauri::State<AppState>, config: types::PricingConfig) -> Result<types::PricingConfig, String> {
    let clean: types::PricingConfig = types::PricingConfig {
        display_currency: if config.display_currency.eq_ignore_ascii_case("cny") {
            "cny".to_string()
        } else {
            "usd".to_string()
        },
        usd_cny_rate: if config.usd_cny_rate > 0.0 && config.usd_cny_rate.is_finite() {
            config.usd_cny_rate
        } else {
            7.1
        },
        models: config
            .models
            .into_iter()
            .map(|(id, e)| {
                (
                    id,
                    types::PriceEntry {
                        input: pricing::clean(e.input),
                        output: pricing::clean(e.output),
                        cache_read: pricing::clean(e.cache_read),
                        cache_write: pricing::clean(e.cache_write),
                        currency: e.currency.filter(|c| !c.trim().is_empty()),
                        // 峰谷:倍率 <= 1 与缺省等价(不做峰谷区分),归一为 None;
                        // 时段窗口只裁范围不过滤,免得编辑中的半成品窗口被保存回写删掉
                        peak: e.peak.and_then(|p| {
                            if p.multiplier > 1.0 && p.multiplier.is_finite() {
                                Some(types::PeakPricing {
                                    multiplier: p.multiplier,
                                    kind: if pricing::is_off_peak_kind(&p.kind) {
                                        "offPeak".to_string()
                                    } else {
                                        "peak".to_string()
                                    },
                                    windows: p
                                        .windows
                                        .into_iter()
                                        .map(|w| types::PeakWindow {
                                            start_min: w.start_min.clamp(0, 1440),
                                            end_min: w.end_min.clamp(0, 1440),
                                        })
                                        .collect(),
                                })
                            } else {
                                None
                            }
                        }),
                        long_context: e.long_context.filter(|l| l.threshold_tokens > 0 && l.multiplier > 0.0),
                    },
                )
            })
            .collect(),
    };
    pricing::save(&state.pricing_path, &clean).map_err(|e| format!("保存失败:{e}"))?;
    Ok(clean)
}

/// 价格估算:用当前编辑中的价格(未保存也可)估算某模型在给定时间范围内的金额(美元)。
/// 范围与界面时间选择一致;口径与正式计费完全相同(逐请求 + 峰谷 + 长上下文 + 币种折算)
#[tauri::command]
async fn estimate_cost(
    state: tauri::State<'_, AppState>,
    range: types::Range,
    model_id: String,
    entry: types::PriceEntry,
) -> Result<f64, AppError> {
    let inner = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        inner.ensure_dsh(false);
        let conn = inner.query_conn(SourceFilter::All)?;
        let mut cfg = (*pricing::load(&inner.pricing_path)).clone();
        cfg.models.insert(model_id.clone(), entry);
        queries::cost_in_range(&conn, &range, &cfg, &model_id).map_err(AppError::from)
    })
    .await
    .map_err(|e| AppError::Task(e.to_string()))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    zcode_path: String,
    dsh_root: String,
    index_path: String,
    sources: Vec<SourceStatus>,
}

#[tauri::command]
fn get_meta(state: tauri::State<AppState>) -> Meta {
    let stats = state.ensure_dsh(false);
    let (dsh_root, index_path) = state
        .dsh
        .lock()
        .map(|i| {
            (
                i.root().display().to_string(),
                i.db_path().display().to_string(),
            )
        })
        .unwrap_or_default();
    Meta {
        zcode_path: state.zcode_path.display().to_string(),
        dsh_root,
        index_path,
        sources: state.source_statuses(&stats),
    }
}

/// 唤醒并聚焦主窗口。
/// show() 在 Windows 上只是 ShowWindow(SW_SHOW),对最小化的窗口不生效(会保持最小化状态,
/// 停在最小化时的小尺寸位置),必须先 unminimize
fn open_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        app.state::<AppState>().visible.store(true, Ordering::Relaxed);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        // 前端据此恢复刷新计时器并立即补一次查询（隐藏期间不做索引/刷新）
        let _ = app.emit("window-shown", ());
    }
}

/// WebView2 浏览器进程是否还活着(本进程的直接子进程 msedgewebview2.exe)。
///
/// RivaTuner/RTSS 这类 OSD 钩子会把 RTSSHooks64.dll 注入 WebView2 浏览器进程,
/// 偶发访问冲突把整个浏览器进程打崩(本机 2026-10-21 的 0xC0000005 崩溃转储确认
/// faulting module 就是 RTSSHooks64.dll)。WebView2 不会自愈,窗口就停在白屏,
/// 看门狗靠这个探活后重建窗口。
#[cfg(windows)]
fn webview2_browser_alive() -> bool {
    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
        fn Process32FirstW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }
    const TH32CS_SNAPPROCESS: u32 = 0x2;
    let me = std::process::id();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == -1 {
            // 拿不到快照时按活着处理,避免误重建
            return true;
        }
        let mut entry: ProcessEntry32W = std::mem::zeroed();
        entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
        let mut alive = false;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32_parent_process_id == me {
                    let name = String::from_utf16_lossy(&entry.sz_exe_file);
                    if name.trim_end_matches('\0').eq_ignore_ascii_case("msedgewebview2.exe") {
                        alive = true;
                        break;
                    }
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        alive
    }
}

#[cfg(not(windows))]
fn webview2_browser_alive() -> bool {
    true
}

/// 主窗口是否「窗口还在但不回消息」。
///
/// AppHangXProcB1 场景下 WebView2 进程并没有退出,只是挂起——按进程存活判定会误认为
/// 一切正常,而 Windows 已经弹出「程序未响应」的系统模态框。`IsHungAppWindow` 直接
/// 问窗口管理器,是系统自己判定挂起用的同一套依据。
#[cfg(windows)]
fn main_window_hung(hwnd: isize) -> bool {
    extern "system" {
        fn IsHungAppWindow(hwnd: isize) -> i32;
    }
    unsafe { IsHungAppWindow(hwnd) != 0 }
}

#[cfg(not(windows))]
fn main_window_hung(_hwnd: isize) -> bool {
    false
}

/// WebView2 浏览器进程崩溃或挂起后,进程内的 WebView2 环境已经死了,原地重建窗口
/// 拿不到新的浏览器进程(实测只得到一个白窗口),只能重启整个进程。
/// 重启前记一笔到配置目录,5 分钟内最多自动重启 3 次,避免崩溃循环里反复闪窗。
///
/// `reason` 区分 `crash`(浏览器进程消失)与 `hung`(进程还在但主窗口不回消息),
/// 写进 `watchdog-events.jsonl` 供事后判断;`watchdog-restarts.json` 只存时间戳,
/// 保持与旧版本兼容。
fn relaunch_after_crash(app: &tauri::AppHandle, reason: &str) {
    let dir = app.path().app_config_dir().ok();
    if let Some(dir) = &dir {
        let line = format!("{{\"at\":{},\"reason\":\"{reason}\"}}\n", now_secs());
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("watchdog-events.jsonl"))
        {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
    }
    let marker = dir.map(|d| d.join("watchdog-restarts.json"));
    if let Some(path) = &marker {
        let now = now_secs();
        let mut recent: Vec<u64> = std::fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        recent.retain(|t| now.saturating_sub(*t) < 300);
        if recent.len() >= 3 {
            // 连续崩溃时不再重启,留给用户手动处理(或去排除 RTSS 注入)
            return;
        }
        recent.push(now);
        let _ = std::fs::write(path, serde_json::to_string(&recent).unwrap_or_default());
    }
    if let Ok(exe) = std::env::current_exe() {
        // 新实例自己会等 1.2s(main.rs 的 --relaunch-wait),避开单实例锁的释放窗口
        let _ = std::process::Command::new(&exe).arg("--relaunch-wait").spawn();
    }
    std::process::exit(0);
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 白屏看门狗:每 2s 探一次 WebView2 浏览器进程。
///
/// 两条恢复路径:
/// - **crash**:进程消失超过 2s 且主窗口可见 → 重启(启动给 12s 宽限);
/// - **hung**:进程还在但主窗口连续 3 次(约 6s)`IsHungAppWindow` 为真 → 重启。
///   后者对应 RTSS 注入导致的 AppHangXProcB1,系统已经弹出「程序未响应」对话框,
///   而旧版看门狗按进程存活判定会一直认为正常。
///
/// 启动后 15s 内不做挂起判定,避开 WebView2 初始化期间的正常无响应;
/// 两次自动重启间隔至少 120s,5 分钟内最多 3 次。
fn spawn_webview_watchdog(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        let mut seen = false;
        let mut missing_since: Option<std::time::Instant> = None;
        let mut hung_streak = 0u32;
        let mut last_recover: Option<std::time::Instant> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));

            if !webview2_browser_alive() {
                if !seen && start.elapsed() < std::time::Duration::from_secs(12) {
                    continue;
                }
                let visible = app
                    .get_webview_window("main")
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(true);
                if !visible {
                    continue;
                }
                let since = *missing_since.get_or_insert_with(std::time::Instant::now);
                if since.elapsed() < std::time::Duration::from_secs(2) {
                    continue;
                }
                if last_recover.map_or(true, |t| t.elapsed() > std::time::Duration::from_secs(120)) {
                    last_recover = Some(std::time::Instant::now());
                    missing_since = None;
                    relaunch_after_crash(&app, "crash");
                }
                continue;
            }

            seen = true;
            missing_since = None;

            // 进程还在:再看主窗口是否已经挂起
            if start.elapsed() < std::time::Duration::from_secs(15) {
                continue;
            }
            let hung = app
                .get_webview_window("main")
                .and_then(|w| w.hwnd().ok())
                .map(|h| main_window_hung(h.0 as isize))
                .unwrap_or(false);
            if !hung {
                hung_streak = 0;
                continue;
            }
            hung_streak += 1;
            if hung_streak < 3 {
                continue;
            }
            let visible = app
                .get_webview_window("main")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(true);
            if !visible {
                continue;
            }
            if last_recover.map_or(true, |t| t.elapsed() > std::time::Duration::from_secs(120)) {
                last_recover = Some(std::time::Instant::now());
                hung_streak = 0;
                relaunch_after_crash(&app, "hung");
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(
            // 单实例:第二个进程由插件直接结束,并把已有窗口唤回前台。
            // 不加这层会有多进程并存——各自持一份内存配置,谁保存就把自己的那份写回文件,
            // 于是"已删除的设置"会被旧实例按旧内存复活
            tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                open_main(app);
            }),
        )
        .on_window_event(|window, event| match event {
            // 主窗口点关闭 = 隐藏至系统托盘后台运行;退出走托盘菜单
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                // 先停索引再隐藏：即使前端刷新计时器有漏网，也不会扫盘/写库
                window
                    .app_handle()
                    .state::<AppState>()
                    .visible
                    .store(false, Ordering::Relaxed);
                let _ = window.hide();
                // 隐藏到托盘：前端暂停刷新与 DSH 索引，唤回时再补
                let _ = window.app_handle().emit("window-hidden", ());
            }
            _ => {}
        })
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            let pricing_path = config_dir.join("pricing.json");
            pricing::ensure_migrated(&pricing_path);

            // 不在这里建索引：App 启动阶段不做 DSH 扫描；第一次查询时才补增量。
            let zcode_path = sources::zcode_db_path();
            let index_path = sources::dsh_index_path(&config_dir);
            let dsh = dsh::DshIndexer::new(sources::dsh_sessions_root(), index_path.clone());
            app.manage(AppState {
                inner: Arc::new(Inner {
                    zcode_path,
                    index_path,
                    dsh: Mutex::new(dsh),
                    visible: AtomicBool::new(true),
                    pricing_path,
                }),
            });

            // 菜单栏托盘:主窗口关闭隐藏后的呼回入口与显式退出
            let show_main = MenuItem::with_id(app, "show_main", "打开主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Agents Dashboard", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_main, &quit])?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().expect("missing default icon").clone())
                .tooltip("Agents Dashboard")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show_main" => open_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键点托盘图标直接呼出/聚焦主窗口;菜单走右键
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        open_main(tray.app_handle());
                    }
                })
                .build(app)?;
            // WebView2 浏览器进程被 OSD 钩子打崩时窗口会停在白屏,看门狗负责重建
            spawn_webview_watchdog(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_dashboard,
            get_summary,
            get_trend,
            get_trend_by_model,
            get_trend_by_provider,
            get_models,
            get_agents,
            get_monthly_trend,
            get_projects,
            get_providers,
            get_requests,
            get_ui_prefs,
            save_ui_prefs,
            get_tools,
            get_errors,
            get_latency,
            get_activity,
            get_pricing,
            save_pricing,
            estimate_cost,
            get_meta
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| match event {
            // macOS 点 Dock 图标:唤起并聚焦主窗口
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                open_main(_app);
            }
            _ => {}
        });
}


