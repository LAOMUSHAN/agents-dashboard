mod db;
mod pricing;
mod providers;
mod queries;
mod types;
mod zconfig;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

pub struct AppState {
    /// 只读连接;打开失败(如库不存在)时为 None,命令返回带路径的错误信息
    db: Mutex<Option<rusqlite::Connection>>,
    db_path: PathBuf,
    pricing_path: PathBuf,
}

impl AppState {
    fn db_error(&self) -> String {
        format!("无法打开 zcode 数据库:{}", self.db_path.display())
    }
}

/// 统一取连接:返回 (guard, conn),guard 必须与 conn 同生命周期
macro_rules! with_conn {
    ($state:expr, $conn:ident, $guard:ident) => {
        let $guard = $state.db.lock().expect("db mutex poisoned");
        let $conn = $guard.as_ref().ok_or_else(|| $state.db_error())?;
    };
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
fn get_models(state: tauri::State<AppState>, range: types::Range) -> Result<Vec<types::ModelStat>, String> {
    with_conn!(state, conn, _guard);
    queries::get_model_stats(conn, &range, &state.pricing_path).map_err(|e| e.to_string())
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
    queries::get_provider_stats(conn, &range, &state.pricing_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_requests(
    state: tauri::State<AppState>,
    range: types::Range,
    page: i64,
    page_size: i64,
) -> Result<types::RequestLogResponse, String> {
    with_conn!(state, conn, _guard);
    let page = page.max(1);
    // 分页单位是根会话:每页返回 N 个会话分组
    let page_size = page_size.clamp(5, 50);
    queries::get_request_log(conn, &range, page, page_size, &state.pricing_path).map_err(|e| e.to_string())
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
    Ok(pricing::load(&state.pricing_path))
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
fn estimate_cost(
    state: tauri::State<AppState>,
    range: types::Range,
    model_id: String,
    entry: types::PriceEntry,
) -> Result<f64, String> {
    with_conn!(state, conn, _guard);
    let mut cfg = pricing::load(&state.pricing_path);
    cfg.models.insert(model_id.clone(), entry);
    queries::cost_in_range(conn, &range, &cfg, &model_id).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    db_path: String,
}

#[tauri::command]
fn get_meta(state: tauri::State<AppState>) -> Meta {
    Meta { db_path: state.db_path.display().to_string() }
}

// ---------- zcode 供应商配置管理(读写 ~/.zcode/v2/config.json) ----------
// 每个写命令都返回写后的完整配置,前端直接用响应刷新列表,不必再发一次查询

#[tauri::command]
fn get_provider_config() -> Result<types::ZProviderConfig, String> {
    zconfig::load_default()
}

#[tauri::command]
fn set_provider_enabled(id: String, enabled: bool) -> Result<types::ZProviderConfig, String> {
    zconfig::update_default(|doc| zconfig::set_enabled(doc, &id, enabled))
}

#[tauri::command]
fn set_provider_base_url(id: String, url: Option<String>) -> Result<types::ZProviderConfig, String> {
    zconfig::update_default(|doc| zconfig::set_base_url(doc, &id, url))
}

#[tauri::command]
fn set_provider_api_key(id: String, key: Option<String>) -> Result<types::ZProviderConfig, String> {
    zconfig::update_default(|doc| zconfig::set_api_key(doc, &id, key))
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
    zconfig::update_default(|doc| {
        zconfig::add_model(doc, &id, &model, context_limit, output_limit, input_image, input_video)
    })
}

#[tauri::command]
fn remove_provider_model(id: String, model: String) -> Result<types::ZProviderConfig, String> {
    zconfig::update_default(|doc| zconfig::remove_model(doc, &id, &model))
}

#[tauri::command]
fn set_provider_model_limits(
    id: String,
    model: String,
    context_limit: Option<i64>,
    output_limit: Option<i64>,
) -> Result<types::ZProviderConfig, String> {
    zconfig::update_default(|doc| {
        zconfig::set_model_limits(doc, &id, &model, context_limit, output_limit)
    })
}

#[tauri::command]
fn set_provider_model_input_modalities(
    id: String,
    model: String,
    image: bool,
    video: bool,
) -> Result<types::ZProviderConfig, String> {
    zconfig::update_default(|doc| {
        zconfig::set_model_input_modalities(doc, &id, &model, image, video)
    })
}

/// 从供应商接口拉取可用模型(OpenAI 兼容);网络请求在命令线程上同步执行,10s 超时
#[tauri::command]
fn fetch_provider_models(id: String) -> Result<Vec<String>, String> {
    zconfig::fetch_remote_models(&id)
}

#[tauri::command]
fn add_provider_models(id: String, models: Vec<String>) -> Result<types::ZProviderConfig, String> {
    zconfig::update_default(|doc| zconfig::add_models(doc, &id, &models).map(|_| ()))
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
    let config = zconfig::update_default(|doc| {
        new_id = zconfig::add_provider(doc, &name, &kind, base_url, api_key)?;
        Ok(())
    })?;
    Ok(AddProviderResponse { config, new_id })
}

#[tauri::command]
fn remove_provider(id: String) -> Result<types::ZProviderConfig, String> {
    zconfig::update_default(|doc| zconfig::remove_provider(doc, &id))
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

            let db_path = db::db_path();
            let conn = db::open_db().ok();
            app.manage(AppState {
                db: Mutex::new(conn),
                db_path,
                pricing_path,
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
