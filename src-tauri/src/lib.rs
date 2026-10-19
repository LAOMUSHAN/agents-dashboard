mod db;
mod error;
mod personal;
mod pricing;
mod providers;
mod queries;
mod sources;
mod types;

use error::AppError;
use sources::DataSource;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

/// 进程内共享状态；命令与后台任务都拿 Arc<Inner>，避免跨线程移动 MutexGuard。
pub struct Inner {
    /// 数据源抽象：目前只有 zcode，DSH 在 P6 接入
    source: Box<dyn sources::DataSource>,
    /// 只读连接;打开失败(如库不存在)时为 None,命令返回带路径的错误信息
    db: Mutex<Option<rusqlite::Connection>>,
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

impl Inner {
    fn db_error(&self) -> String {
        format!(
            "无法打开 {} 数据库:{}",
            self.source.kind().label(),
            self.source.db_path().display()
        )
    }

    /// 一次查询返回仪表盘需要的全部数据；同步实现，由命令层放到阻塞线程池执行。
    /// 14 条查询各自独立只读连接并行跑（SQLite WAL 支持多读者），
    /// 墙钟时间从「14 条相加」降到「最慢的一条」。
    fn query_dashboard(&self, range: &types::Range) -> Result<types::DashboardPayload, AppError> {
        let p = &self.pricing_path;
        let names = self.source.provider_names();
        let mut conns = Vec::with_capacity(14);
        for _ in 0..14 {
            conns.push(self.source.open()?);
        }
        // 每条查询独占一个连接：Connection 不是 Sync，必须 move 进各自线程
        let [c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13] =
            <[rusqlite::Connection; 14]>::try_from(conns).expect("连接数固定为 14");

        let (summary, trend, model_trend, provider_trend, models, projects, providers, tools, agents, errors, latency, activity, activity_daily, monthly_trend) =
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
                let activity_daily = s.spawn(move || queries::get_activity_daily(&c12, range));
                let monthly_trend = s.spawn(move || queries::get_monthly_trend(&c13, range, p));

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
                    join_query("activity_daily", activity_daily.join())?,
                    join_query("monthly_trend", monthly_trend.join())?,
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
            activity_daily,
            monthly_trend,
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

/// 统一取连接:返回 (guard, conn),guard 必须与 conn 同生命周期
macro_rules! with_conn {
    ($state:expr, $conn:ident, $guard:ident) => {
        let $guard = $state.db.lock().expect("db mutex poisoned");
        let $conn = $guard.as_ref().ok_or_else(|| $state.db_error())?;
    };
}

/// 一次刷新只走一个命令：14 个查询在同一个阻塞任务里跑完，避免 14 次 IPC 往返。
#[tauri::command]
async fn get_dashboard(
    state: tauri::State<'_, AppState>,
    range: types::Range,
) -> Result<types::DashboardPayload, AppError> {
    let inner = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || inner.query_dashboard(&range))
        .await
        .map_err(|e| AppError::Task(e.to_string()))?
}

#[tauri::command]
fn get_summary(state: tauri::State<AppState>, range: types::Range) -> Result<types::Summary, String> {
    with_conn!(state, conn, _guard);
    queries::get_summary(conn, &range, &state.pricing_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_trend(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::TrendPoint>, String> {
    with_conn!(state, conn, _guard);
    queries::get_trend(conn, &range, &state.pricing_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_trend_by_model(
    state: tauri::State<AppState>,
    range: types::Range,
) -> Result<Vec<types::ModelTrendPoint>, String> {
    with_conn!(state, conn, _guard);
    queries::get_trend_by_model(conn, &range, &state.pricing_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_trend_by_provider(
    state: tauri::State<AppState>,
    range: types::Range,
) -> Result<Vec<types::ProviderTrendPoint>, String> {
    with_conn!(state, conn, _guard);
    queries::get_trend_by_provider(conn, &range, &state.pricing_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_models(
    state: tauri::State<'_, AppState>,
    range: types::Range,
) -> Result<Vec<types::ModelStat>, AppError> {
    let inner = state.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = inner.source.open()?;
        queries::get_model_stats(&conn, &range, &inner.pricing_path).map_err(AppError::from)
    })
    .await
    .map_err(|e| AppError::Task(e.to_string()))?
}

#[tauri::command]
fn get_agents(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::AgentStat>, String> {
    with_conn!(state, conn, _guard);
    queries::get_agent_stats(conn, &range).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_activity_daily(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::DailyActivityPoint>, String> {
    with_conn!(state, conn, _guard);
    queries::get_activity_daily(conn, &range).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_monthly_trend(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::MonthPoint>, String> {
    with_conn!(state, conn, _guard);
    queries::get_monthly_trend(conn, &range, &state.pricing_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_projects(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::ProjectStat>, String> {
    with_conn!(state, conn, _guard);
    queries::get_project_stats(conn, &range, &state.pricing_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_providers(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::ProviderStat>, String> {
    with_conn!(state, conn, _guard);
    let names = state.source.provider_names();
    queries::get_provider_stats(conn, &range, &state.pricing_path, &names).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_requests(
    state: tauri::State<'_, AppState>,
    range: types::Range,
    page: i64,
    page_size: i64,
) -> Result<types::RequestLogResponse, AppError> {
    let inner = state.inner.clone();
    let page = page.max(1);
    // 分页单位是根会话:每页返回 N 个会话分组
    let page_size = page_size.clamp(5, 50);
    tauri::async_runtime::spawn_blocking(move || {
        let conn = inner.source.open()?;
        queries::get_request_log(&conn, &range, page, page_size, &inner.pricing_path)
            .map_err(AppError::from)
    })
    .await
    .map_err(|e| AppError::Task(e.to_string()))?
}

#[tauri::command]
fn get_tools(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::ToolStat>, String> {
    with_conn!(state, conn, _guard);
    queries::get_tool_stats(conn, &range).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_errors(state: tauri::State<AppState>, range: types::Range) -> Result<types::ErrorStats, String> {
    with_conn!(state, conn, _guard);
    queries::get_error_stats(conn, &range).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_latency(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::LatencyStat>, String> {
    with_conn!(state, conn, _guard);
    queries::get_latency_stats(conn, &range).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_activity(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::HeatCell>, String> {
    with_conn!(state, conn, _guard);
    queries::get_activity_heatmap(conn, &range).map_err(|e| e.to_string())
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
        let conn = inner.source.open()?;
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
    db_path: String,
    source: &'static str,
    supports_provider_editing: bool,
}

#[tauri::command]
fn get_meta(state: tauri::State<AppState>) -> Meta {
    Meta {
        db_path: state.source.db_path().display().to_string(),
        source: state.source.kind().label(),
        supports_provider_editing: state.source.supports_provider_editing(),
    }
}

// ---------- zcode 供应商配置管理(读写 ~/.zcode/v2/provider_config.json) ----------
// 每个写命令都返回写后的完整配置,前端直接用响应刷新列表,不必再发一次查询

#[tauri::command]
fn get_provider_config() -> Result<types::ZProviderConfig, String> {
    personal::load_default()
}

#[tauri::command]
fn set_provider_enabled(id: String, enabled: bool) -> Result<types::ZProviderConfig, String> {
    personal::update_default(|doc| personal::set_enabled(doc, &id, enabled))
}

#[tauri::command]
fn set_provider_base_url(id: String, url: Option<String>) -> Result<types::ZProviderConfig, String> {
    personal::update_default(|doc| personal::set_base_url(doc, &id, url))
}

#[tauri::command]
fn set_provider_api_key(id: String, key: Option<String>) -> Result<types::ZProviderConfig, String> {
    personal::update_default(|doc| personal::set_api_key(doc, &id, key))
}

#[tauri::command]
fn add_provider_model(
    id: String,
    model: String,
    context_limit: Option<i64>,
    output_limit: Option<i64>,
    input_image: bool,
    input_video: bool,
) -> Result<types::ZProviderConfig, String> {
    personal::update_default(|doc| {
        personal::add_model(doc, &id, &model, context_limit, output_limit, input_image, input_video)
    })
}

#[tauri::command]
fn remove_provider_model(id: String, model: String) -> Result<types::ZProviderConfig, String> {
    personal::update_default(|doc| personal::remove_model(doc, &id, &model))
}

#[tauri::command]
fn set_provider_model_limits(
    id: String,
    model: String,
    context_limit: Option<i64>,
    output_limit: Option<i64>,
) -> Result<types::ZProviderConfig, String> {
    personal::update_default(|doc| {
        personal::set_model_limits(doc, &id, &model, context_limit, output_limit)
    })
}

#[tauri::command]
fn set_provider_model_input_modalities(
    id: String,
    model: String,
    image: bool,
    video: bool,
) -> Result<types::ZProviderConfig, String> {
    personal::update_default(|doc| {
        personal::set_model_input_modalities(doc, &id, &model, image, video)
    })
}

/// 从供应商接口拉取可用模型(OpenAI 兼容);网络请求在命令线程上同步执行,10s 超时
#[tauri::command]
fn fetch_provider_models(id: String) -> Result<Vec<String>, String> {
    personal::fetch_remote_models(&id)
}

#[tauri::command]
fn add_provider_models(id: String, models: Vec<String>) -> Result<types::ZProviderConfig, String> {
    personal::update_default(|doc| personal::add_models(doc, &id, &models).map(|_| ()))
}

/// add_provider 的响应:newId 是新生成的供应商 key,前端用它定位并展开新行
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AddProviderResponse {
    config: types::ZProviderConfig,
    new_id: String,
}

#[tauri::command]
fn add_provider(
    name: String,
    kind: String,
    base_url: Option<String>,
    api_key: Option<String>,
) -> Result<AddProviderResponse, String> {
    let mut new_id = String::new();
    let config = personal::update_default(|doc| {
        new_id = personal::add_provider(doc, &name, &kind, base_url, api_key)?;
        Ok(())
    })?;
    Ok(AddProviderResponse { config, new_id })
}

#[tauri::command]
fn remove_provider(id: String) -> Result<types::ZProviderConfig, String> {
    personal::update_default(|doc| personal::remove_provider(doc, &id))
}

/// 唤醒并聚焦主窗口。
/// show() 在 Windows 上只是 ShowWindow(SW_SHOW),对最小化的窗口不生效(会保持最小化状态,
/// 停在最小化时的小尺寸位置),必须先 unminimize
fn open_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
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
                let _ = window.hide();
            }
            _ => {}
        })
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            let pricing_path = config_dir.join("pricing.json");
            pricing::ensure_migrated(&pricing_path);

            let source = Box::new(sources::ZcodeSource::new());
            let conn = source.open().ok();
            app.manage(AppState {
                inner: Arc::new(Inner {
                    source,
                    db: Mutex::new(conn),
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
            get_activity_daily,
            get_monthly_trend,
            get_projects,
            get_providers,
            get_requests,
            get_tools,
            get_errors,
            get_latency,
            get_activity,
            get_pricing,
            save_pricing,
            estimate_cost,
            get_provider_config,
            set_provider_enabled,
            set_provider_base_url,
            set_provider_api_key,
            add_provider_model,
            remove_provider_model,
            set_provider_model_limits,
            set_provider_model_input_modalities,
            fetch_provider_models,
            add_provider_models,
            add_provider,
            remove_provider,
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


