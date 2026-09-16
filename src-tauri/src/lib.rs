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

/// 展开主窗口;胶囊与主窗口互斥,展开时收起胶囊。
/// show() 在 Windows 上只是 ShowWindow(SW_SHOW),对最小化的窗口不生效(会保持最小化状态,
/// 停在最小化时的小尺寸位置),必须先 unminimize
fn open_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    if let Some(m) = app.get_webview_window("mini") {
        let _ = m.hide();
        save_mini_position(app);
    }
}

/// 收起到胶囊;主窗口可见则一并隐藏
fn open_mini(app: &tauri::AppHandle) {
    if let Some(m) = app.get_webview_window("mini") {
        let _ = m.show();
        let _ = m.set_focus();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// 位置落盘。macOS 上 cmd+Q 走系统 terminate,tao 不发退出事件,
/// 插件自身只在 RunEvent::Exit 写盘(实际永远等不到),必须在移动/收起时主动保存
fn save_mini_position(app: &tauri::AppHandle) {
    use tauri_plugin_window_state::AppHandleExt;
    let _ = app.save_window_state(tauri_plugin_window_state::StateFlags::POSITION);
}

/// WKWebView 实例级去底:配置对象上的 drawsBackground(wry 创建时已设)不足,
/// 圆角外仍残留方形白底;须再对实例设 drawsBackground=false 和
/// underPageBackgroundColor=clear(后者默认系统白,drawsBackground 关掉后它就是露出的底色)
#[cfg(target_os = "macos")]
fn force_webview_transparent(window: &tauri::WebviewWindow) {
    use objc2_app_kit::NSColor;
    let _ = window.with_webview(|wv| unsafe {
        let wk = &*(wv.inner() as *mut objc2::runtime::AnyObject);
        let no = objc2_foundation::NSNumber::numberWithBool(false);
        let _: () = objc2::msg_send![
            wk,
            setValue: &*no,
            forKey: objc2_foundation::ns_string!("drawsBackground")
        ];
        let clear = NSColor::clearColor();
        let _: () = objc2::msg_send![wk, setUnderPageBackgroundColor: &*clear];

        // NSWindow 加固:clear 背景 + 非透明,防 tao 时序问题
        let ns_ptr = wv.ns_window();
        if !ns_ptr.is_null() {
            let ns_window = &*(ns_ptr as *mut objc2_app_kit::NSWindow);
            ns_window.setOpaque(false);
            ns_window.setBackgroundColor(Some(&clear));
        }
    });
}

/// 拖动写盘节流:Moved 高频触发,限每 500ms 落一次盘
struct PosSaveThrottle(Mutex<std::time::Instant>);

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    open_main(&app);
    Ok(())
}

#[tauri::command]
fn set_mini_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    if visible {
        open_mini(&app);
    } else if let Some(m) = app.get_webview_window("mini") {
        m.hide().map_err(|e| e.to_string())?;
        save_mini_position(&app);
    }
    Ok(())
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
        .plugin(
            // 浮窗只记位置:resizable:false 尺寸由 conf 定,记忆旧 SIZE 会覆盖新配置;
            // 也不能存 visible(否则浮窗被隐藏后重启会一个窗口都不出现);
            // 主窗口不归插件管,大小行为与单窗口时代一致
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                .with_denylist(&["main"])
                .build(),
        )
        .on_window_event(|window, event| match event {
            // 主窗口点关闭 = 收回到胶囊;胶囊点关闭 = 隐藏(托盘/Dock 唤回);退出走托盘菜单
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                match window.label() {
                    "main" => open_mini(window.app_handle()),
                    _ => {
                        let _ = window.hide();
                        save_mini_position(window.app_handle());
                    }
                }
            }
            // 胶囊拖动时节流落盘,任何退出方式(含强杀)都不丢位置
            tauri::WindowEvent::Moved(_) if window.label() == "mini" => {
                let app = window.app_handle();
                let throttle = app.state::<PosSaveThrottle>();
                let mut last = throttle.0.lock().unwrap();
                if last.elapsed() >= std::time::Duration::from_millis(500) {
                    *last = std::time::Instant::now();
                    drop(last);
                    save_mini_position(app);
                }
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
            app.manage(PosSaveThrottle(Mutex::new(std::time::Instant::now())));

            // 透明胶囊:补设 WKWebView 实例级 drawsBackground,消除圆角外方形白底
            #[cfg(target_os = "macos")]
            if let Some(w) = app.get_webview_window("mini") {
                force_webview_transparent(&w);
            }

            // 菜单栏托盘:浮窗被隐藏后唯一的找回入口,也承担显式退出
            let show_mini = MenuItem::with_id(app, "show_mini", "显示浮窗", true, None::<&str>)?;
            let show_main = MenuItem::with_id(app, "show_main", "打开主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Agents Dashboard", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_mini, &show_main, &quit])?;
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().expect("missing default icon").clone())
                .tooltip("Agents Dashboard")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show_mini" => open_mini(app),
                    "show_main" => open_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键点托盘图标收起到胶囊;菜单走右键
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        open_mini(tray.app_handle());
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
            get_meta,
            show_main_window,
            set_mini_visible
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // 位置落盘兜底:托盘退出(app.exit)会经过这里;cmd+Q 靠拖动/收起时的主动保存
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                save_mini_position(app);
            }
            // macOS 点 Dock 图标:主窗口开着就聚焦它,否则收回到胶囊
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                let main_visible = app
                    .get_webview_window("main")
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false);
                if main_visible {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.set_focus();
                    }
                } else {
                    open_mini(app);
                }
            }
            _ => {}
        });
}
