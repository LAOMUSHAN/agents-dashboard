//! zcode 新版个人供应商配置(`~/.zcode/v2/provider_config.json`)的读写。
//!
//! 文件结构:
//! ```json
//! { "schemaVersion": 1, "config": {
//!     "providerOrder": ["id", ...],
//!     "providerConfigRules": { "providerRules": [
//!       { "providerId", "providerName", "enabled",
//!         "config": { "group", "access": {"type","apiKey"},
//!                     "api": {"type","baseUrl"},
//!                     "personalModelIds": [], "modelOrder": [] } } ] },
//!     "modelConfigRules": { "providerModelRules": [
//!       { "providerId", "modelId",
//!         "config": { "enabled", "properties": {"contextWindow","inputFormat"},
//!                     "optionSpecs": {"maxOutputTokens":{"max"}} } } ],
//!       "manualProviderModelRules": [] } } }
//! ```
//! 2026-09 之后 zcode「模型设置」页真正读写的是这个文件;旧 config.json 已停更。
//! 写入前做带时间戳的备份(保留最近 5 份),临时文件 + rename 原子替换,
//! 读-改-写全程持锁,只改目标字段,文档里其他键一律原样保留。

use crate::providers::{family_label, personal_config_path, setting_path};
use crate::types::{ZModelEntry, ZProviderConfig, ZProviderEntry};
use serde_json::{Map, Value, json};
use std::path::Path;
use std::sync::Mutex;

/// 同一时刻只有一个命令在做读-改-写,避免并发写互相覆盖
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    // 锁被 panic 污染后仍继续用:配置写入不值得让应用从此不可用
    CONFIG_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// 读取并解析配置文件;解析失败要报错而不是静默降级,否则后续写会把坏数据固化
fn load(path: &Path) -> Result<Value, String> {
    let raw =
        std::fs::read_to_string(path).map_err(|e| format!("无法读取 {}:{e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("{} 不是合法 JSON:{e}", path.display()))
}

pub fn load_default() -> Result<ZProviderConfig, String> {
    load_config(&personal_config_path())
}

fn load_config(path: &Path) -> Result<ZProviderConfig, String> {
    let doc = load(path)?;
    Ok(build_config(path, &doc))
}

/// 读-改-写默认配置文件,写命令统一入口
pub fn update_default<F>(f: F) -> Result<ZProviderConfig, String>
where
    F: FnOnce(&mut Value) -> Result<(), String>,
{
    update(&personal_config_path(), f)
}

/// 读-改-写全程持锁;f 返回 Err 时不落盘。返回写入后的最新配置供前端直接刷新
fn update<F>(path: &Path, f: F) -> Result<ZProviderConfig, String>
where
    F: FnOnce(&mut Value) -> Result<(), String>,
{
    let _guard = lock();
    let mut doc = load(path)?;
    f(&mut doc)?;
    write_with_backup(path, &doc)?;
    Ok(build_config(path, &doc))
}

fn build_config(path: &Path, doc: &Value) -> ZProviderConfig {
    let (mut preset, personal): (Vec<_>, Vec<_>) =
        extract_entries(doc).into_iter().partition(|p| p.preset);
    // 智谱区:家族行(Z.ai / BigModel)在前,账号覆盖行(account:xxx)在后
    let mut providers = family_rows();
    providers.append(&mut preset);
    providers.extend(personal);
    ZProviderConfig { path: path.display().to_string(), providers }
}

// ---------- 读取 ----------

fn rules(doc: &Value) -> &[Value] {
    doc.pointer("/config/providerConfigRules/providerRules")
        .and_then(|r| r.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
}

fn model_rules(doc: &Value) -> &[Value] {
    doc.pointer("/config/modelConfigRules/providerModelRules")
        .and_then(|r| r.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
}

fn arr_strings(v: Option<&Value>, key: &str) -> Vec<String> {
    v.and_then(|v| v.get(key))
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn extract_entries(doc: &Value) -> Vec<ZProviderEntry> {
    let model_rules = model_rules(doc);
    let builtin_names = crate::providers::builtin_provider_names();
    let mut entries: Vec<ZProviderEntry> = rules(doc)
        .iter()
        .filter_map(|r| entry_from_rule(r, model_rules, &builtin_names))
        .collect();
    // providerOrder 是「模型设置」页的拖拽顺序;不在表里的(账号覆盖行)排在后面,
    // 稳定排序保证它们维持文件里的相对顺序
    let order = arr_strings(doc.get("config"), "providerOrder");
    let rank: std::collections::HashMap<&str, usize> =
        order.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
    entries.sort_by_key(|e| rank.get(e.id.as_str()).copied().unwrap_or(usize::MAX));
    entries
}

fn entry_from_rule(
    rule: &Value,
    model_rules: &[Value],
    builtin_names: &std::collections::HashMap<String, String>,
) -> Option<ZProviderEntry> {
    let id = rule.get("providerId").and_then(|v| v.as_str())?.to_string();
    let cfg = rule.get("config");
    let group = cfg
        .and_then(|c| c.get("group"))
        .and_then(|g| g.as_str())
        .map(str::to_string);
    // account: 是 zcode 账号体系的内置供应商覆盖行,group 非 standard-personal 的也归智谱区
    let preset = id.starts_with("account:")
        || id.starts_with("family:")
        || group.as_deref().map(|g| g != "standard-personal").unwrap_or(false);
    let api_key = cfg
        .and_then(|c| c.pointer("/access/apiKey"))
        .and_then(|k| k.as_str())
        .map(str::trim)
        .filter(|k| !k.is_empty());
    let name = rule
        .get("providerName")
        .and_then(|n| n.as_str())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .or_else(|| builtin_names.get(&id).cloned())
        .unwrap_or_else(|| id.clone());
    let models = models_for(&id, cfg, model_rules);
    Some(ZProviderEntry {
        id,
        name,
        kind: cfg
            .and_then(|c| c.pointer("/api/type"))
            .and_then(|t| t.as_str())
            .map(str::to_string),
        source: Some(if preset { "builtin" } else { "personal" }.to_string()),
        builtin: preset,
        preset,
        group,
        enabled: rule.get("enabled").and_then(|e| e.as_bool()) != Some(false),
        system_disabled_reason: None,
        base_url: cfg
            .and_then(|c| c.pointer("/api/baseUrl"))
            .and_then(|u| u.as_str())
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(str::to_string),
        has_api_key: api_key.is_some(),
        api_key_hint: api_key.and_then(tail_hint),
        models,
    })
}

/// 模型展示顺序:modelOrder 里属于本供应商的排前面,其余 personalModelIds 顺延;
/// personalModelIds 为空时说明模型继承自模板,直接用 modelOrder
fn models_for(provider: &str, cfg: Option<&Value>, model_rules: &[Value]) -> Vec<ZModelEntry> {
    let Some(cfg) = cfg else {
        return Vec::new();
    };
    let ids = arr_strings(Some(cfg), "personalModelIds");
    let order = arr_strings(Some(cfg), "modelOrder");
    let mut out: Vec<String> = Vec::new();
    for id in order.iter().filter(|id| ids.contains(id)) {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    for id in &ids {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    if out.is_empty() {
        out = order;
    }
    out.into_iter().map(|m| model_entry(provider, &m, model_rules)).collect()
}

fn model_entry(provider: &str, model: &str, model_rules: &[Value]) -> ZModelEntry {
    let rule = model_rules.iter().find(|r| {
        r.get("providerId").and_then(|v| v.as_str()) == Some(provider)
            && r.get("modelId").and_then(|v| v.as_str()) == Some(model)
    });
    let props = rule.and_then(|r| r.pointer("/config/properties"));
    let input_format = props.and_then(|p| p.get("inputFormat"));
    let flag = |key: &str| {
        input_format
            .and_then(|f| f.get(key))
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    };
    ZModelEntry {
        name: model.to_string(),
        context_limit: props
            .and_then(|p| p.get("contextWindow"))
            .and_then(|v| v.as_i64()),
        output_limit: rule
            .and_then(|r| r.pointer("/config/optionSpecs/maxOutputTokens/max"))
            .and_then(|v| v.as_i64()),
        input_image: flag("supportsImage"),
        input_video: flag("supportsVideo"),
    }
}

/// 智谱区家族行:setting.json 里配置了连接方式的家族才显示。
/// 这些行只是展示 zcode 账号供应商,面板不提供编辑。
fn family_rows() -> Vec<ZProviderEntry> {
    let Ok(raw) = std::fs::read_to_string(setting_path()) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(selections) = v
        .get("providerFamilyConnectionSelections")
        .and_then(|s| s.as_object())
    else {
        return Vec::new();
    };
    selections
        .keys()
        .map(|family| ZProviderEntry {
            id: format!("family:{family}"),
            name: family_label(family).to_string(),
            kind: None,
            source: Some("builtin".to_string()),
            builtin: true,
            preset: true,
            group: Some(format!("{family}-family")),
            enabled: true,
            system_disabled_reason: None,
            base_url: None,
            has_api_key: false,
            api_key_hint: None,
            models: Vec::new(),
        })
        .collect()
}

/// 密钥长度超过 8 才给尾 4 位 hint,太短的无法匿名展示
fn tail_hint(s: &str) -> Option<String> {
    let count = s.chars().count();
    if count > 8 {
        Some(s.chars().skip(count - 4).collect())
    } else {
        None
    }
}

// ---------- 结构访问 ----------

fn config_mut(doc: &mut Value) -> Result<&mut Map<String, Value>, String> {
    doc.get_mut("config")
        .and_then(|c| c.as_object_mut())
        .ok_or_else(|| "provider_config.json 缺少 config 对象".to_string())
}

fn rules_mut(doc: &mut Value) -> Result<&mut Vec<Value>, String> {
    config_mut(doc)?
        .get_mut("providerConfigRules")
        .and_then(|v| v.as_object_mut())
        .and_then(|o| o.get_mut("providerRules"))
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "配置里没有 providerRules 数组".to_string())
}

fn rule_mut<'a>(doc: &'a mut Value, id: &str) -> Result<&'a mut Map<String, Value>, String> {
    rules_mut(doc)?
        .iter_mut()
        .find(|r| r.get("providerId").and_then(|v| v.as_str()) == Some(id))
        .and_then(|r| r.as_object_mut())
        .ok_or_else(|| format!("供应商不存在:{id}"))
}

fn rule_config_mut<'a>(rule: &'a mut Map<String, Value>) -> &'a mut Map<String, Value> {
    if !rule.get("config").map(|v| v.is_object()).unwrap_or(false) {
        rule.insert("config".into(), Value::Object(Map::new()));
    }
    rule.get_mut("config")
        .and_then(|v| v.as_object_mut())
        .expect("config 刚确保为对象")
}

fn sub_object_mut<'a>(map: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    if !map.get(key).map(|v| v.is_object()).unwrap_or(false) {
        map.insert(key.to_string(), Value::Object(Map::new()));
    }
    map.get_mut(key)
        .and_then(|v| v.as_object_mut())
        .expect("对象字段")
}

fn array_mut<'a>(map: &'a mut Map<String, Value>, key: &str) -> &'a mut Vec<Value> {
    if !map.get(key).map(|v| v.is_array()).unwrap_or(false) {
        map.insert(key.to_string(), Value::Array(Vec::new()));
    }
    map.get_mut(key)
        .and_then(|v| v.as_array_mut())
        .expect("数组字段")
}

fn provider_order_mut(doc: &mut Value) -> Result<&mut Vec<Value>, String> {
    Ok(array_mut(config_mut(doc)?, "providerOrder"))
}

fn model_rules_mut(doc: &mut Value) -> Result<&mut Vec<Value>, String> {
    let cfg = config_mut(doc)?;
    if !cfg.get("modelConfigRules").map(|v| v.is_object()).unwrap_or(false) {
        cfg.insert(
            "modelConfigRules".into(),
            json!({"providerModelRules": [], "manualProviderModelRules": []}),
        );
    }
    let rules = cfg
        .get_mut("modelConfigRules")
        .and_then(|v| v.as_object_mut())
        .expect("modelConfigRules 刚确保为对象");
    if !rules.get("providerModelRules").map(|v| v.is_array()).unwrap_or(false) {
        rules.insert("providerModelRules".into(), Value::Array(Vec::new()));
    }
    Ok(rules
        .get_mut("providerModelRules")
        .and_then(|v| v.as_array_mut())
        .expect("providerModelRules 刚确保为数组"))
}

/// 取(必要时创建)某供应商某模型的 config 对象
fn ensure_model_config<'a>(
    doc: &'a mut Value,
    provider: &str,
    model: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    let rules = model_rules_mut(doc)?;
    let idx = rules.iter().position(|r| {
        r.get("providerId").and_then(|v| v.as_str()) == Some(provider)
            && r.get("modelId").and_then(|v| v.as_str()) == Some(model)
    });
    let idx = match idx {
        Some(i) => i,
        None => {
            rules.push(json!({
                "providerId": provider,
                "modelId": model,
                "config": {},
            }));
            rules.len() - 1
        }
    };
    let rule = rules[idx].as_object_mut().expect("模型规则是对象");
    Ok(sub_object_mut(rule, "config"))
}

// ---------- 字段修改 ----------

pub fn set_enabled(doc: &mut Value, id: &str, enabled: bool) -> Result<(), String> {
    rule_mut(doc, id)?.insert("enabled".into(), Value::Bool(enabled));
    Ok(())
}

/// url 为 None 或空白时删除 baseUrl 字段(与"未设置"状态一致)
pub fn set_base_url(doc: &mut Value, id: &str, url: Option<String>) -> Result<(), String> {
    let rule = rule_mut(doc, id)?;
    let api = sub_object_mut(rule_config_mut(rule), "api");
    match url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()) {
        Some(u) => api.insert("baseUrl".into(), Value::String(u)),
        None => api.remove("baseUrl"),
    };
    Ok(())
}

/// key 为 None 或空白时清除 apiKey 字段
pub fn set_api_key(doc: &mut Value, id: &str, key: Option<String>) -> Result<(), String> {
    let rule = rule_mut(doc, id)?;
    let access = sub_object_mut(rule_config_mut(rule), "access");
    match key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => access.insert("apiKey".into(), Value::String(k)),
        None => access.remove("apiKey"),
    };
    Ok(())
}

pub fn add_model(
    doc: &mut Value,
    id: &str,
    model: &str,
    context_limit: Option<i64>,
    output_limit: Option<i64>,
    input_image: bool,
    input_video: bool,
) -> Result<(), String> {
    let name = model.trim();
    if name.is_empty() {
        return Err("模型名不能为空".to_string());
    }
    {
        let rule = rule_mut(doc, id)?;
        let cfg = rule_config_mut(rule);
        let ids = array_mut(cfg, "personalModelIds");
        if ids.iter().any(|v| v.as_str() == Some(name)) {
            return Err(format!("模型已存在:{name}"));
        }
        ids.push(Value::String(name.to_string()));
        let order = array_mut(cfg, "modelOrder");
        if !order.iter().any(|v| v.as_str() == Some(name)) {
            order.push(Value::String(name.to_string()));
        }
    }
    let cfg = ensure_model_config(doc, id, name)?;
    cfg.insert("enabled".into(), Value::Bool(true));
    if let Some(v) = context_limit {
        sub_object_mut(cfg, "properties").insert("contextWindow".into(), json!(v));
    }
    if let Some(v) = output_limit {
        sub_object_mut(sub_object_mut(cfg, "optionSpecs"), "maxOutputTokens")
            .insert("max".into(), json!(v));
    }
    if input_image || input_video {
        let format = sub_object_mut(sub_object_mut(cfg, "properties"), "inputFormat");
        format.insert("supportsImage".into(), Value::Bool(input_image));
        format.insert("supportsVideo".into(), Value::Bool(input_video));
    }
    Ok(())
}

/// 批量新增(从接口导入用):跳过空名与已存在的,一次落盘只做一次备份/写入。
/// 没有任何有效新增时报错
pub fn add_models(doc: &mut Value, id: &str, names: &[String]) -> Result<usize, String> {
    let candidates: Vec<String> = names
        .iter()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect();
    if candidates.is_empty() {
        return Err("没有可添加的模型".to_string());
    }
    let mut added = 0;
    for name in candidates {
        let exists = {
            let rule = rule_mut(doc, id)?;
            let cfg = rule_config_mut(rule);
            let ids = array_mut(cfg, "personalModelIds");
            let exists = ids.iter().any(|v| v.as_str() == Some(name.as_str()));
            if !exists {
                ids.push(Value::String(name.clone()));
                let order = array_mut(cfg, "modelOrder");
                if !order.iter().any(|v| v.as_str() == Some(name.as_str())) {
                    order.push(Value::String(name.clone()));
                }
            }
            exists
        };
        if exists {
            continue;
        }
        // 批量导入无法逐个勾模态,先按纯文本建条目,之后在界面上开
        let cfg = ensure_model_config(doc, id, &name)?;
        cfg.insert("enabled".into(), Value::Bool(true));
        added += 1;
    }
    if added == 0 {
        return Err("所选模型均已配置".to_string());
    }
    Ok(added)
}

pub fn remove_model(doc: &mut Value, id: &str, model: &str) -> Result<(), String> {
    let name = model.trim();
    let found = {
        let rule = rule_mut(doc, id)?;
        let cfg = rule_config_mut(rule);
        let mut found = false;
        for key in ["personalModelIds", "modelOrder"] {
            if let Some(arr) = cfg.get_mut(key).and_then(|v| v.as_array_mut()) {
                if arr.iter().any(|v| v.as_str() == Some(name)) {
                    found = true;
                }
                arr.retain(|v| v.as_str() != Some(name));
            }
        }
        found
    };
    if !found {
        return Err(format!("模型不存在:{name}"));
    }
    if let Ok(rules) = model_rules_mut(doc) {
        rules.retain(|r| {
            !(r.get("providerId").and_then(|v| v.as_str()) == Some(id)
                && r.get("modelId").and_then(|v| v.as_str()) == Some(name))
        });
    }
    Ok(())
}

/// 编辑上下文/输出上限;None 表示删除对应字段(两者都删光则连 properties 一并移除)
pub fn set_model_limits(
    doc: &mut Value,
    id: &str,
    model: &str,
    context_limit: Option<i64>,
    output_limit: Option<i64>,
) -> Result<(), String> {
    let name = model.trim();
    let cfg = ensure_model_config(doc, id, name)?;
    let props_empty = {
        let props = sub_object_mut(cfg, "properties");
        match context_limit {
            Some(v) => drop(props.insert("contextWindow".into(), json!(v))),
            None => drop(props.remove("contextWindow")),
        }
        props.is_empty()
    };
    if props_empty {
        cfg.remove("properties");
    }
    let max_empty;
    let specs_empty = {
        let specs = sub_object_mut(cfg, "optionSpecs");
        {
            let max = sub_object_mut(specs, "maxOutputTokens");
            match output_limit {
                Some(v) => drop(max.insert("max".into(), json!(v))),
                None => drop(max.remove("max")),
            }
            max_empty = max.is_empty();
        }
        if max_empty {
            specs.remove("maxOutputTokens");
        }
        specs.is_empty()
    };
    if specs_empty {
        cfg.remove("optionSpecs");
    }
    Ok(())
}

/// 设置输入模态(properties.inputFormat);supportsPdf 等其他开关原样保留
pub fn set_model_input_modalities(
    doc: &mut Value,
    id: &str,
    model: &str,
    image: bool,
    video: bool,
) -> Result<(), String> {
    let name = model.trim();
    let cfg = ensure_model_config(doc, id, name)?;
    let format = sub_object_mut(sub_object_mut(cfg, "properties"), "inputFormat");
    format.insert("supportsImage".into(), Value::Bool(image));
    format.insert("supportsVideo".into(), Value::Bool(video));
    Ok(())
}

// ---------- 新增 / 删除供应商 ----------

/// 新增自定义供应商,结构与 zcode 自己创建的一致:
/// UUID 作 providerId,group=standard-personal,access/api 里只写有值的字段,
/// 并追加到 providerOrder 末尾。返回新 id 供前端定位并展开
pub fn add_provider(
    doc: &mut Value,
    name: &str,
    kind: &str,
    base_url: Option<String>,
    api_key: Option<String>,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("供应商名称不能为空".to_string());
    }
    let kind = kind.trim();
    if kind.is_empty() {
        return Err("供应商类型不能为空".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut access = Map::new();
    access.insert("type".into(), Value::String("api-key".into()));
    if let Some(k) = api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        access.insert("apiKey".into(), Value::String(k));
    }
    let mut api = Map::new();
    api.insert("type".into(), Value::String(kind.to_string()));
    if let Some(u) = base_url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()) {
        api.insert("baseUrl".into(), Value::String(u));
    }
    let mut cfg = Map::new();
    cfg.insert("group".into(), Value::String("standard-personal".into()));
    cfg.insert("access".into(), Value::Object(access));
    cfg.insert("api".into(), Value::Object(api));
    cfg.insert("personalModelIds".into(), Value::Array(Vec::new()));
    cfg.insert("modelOrder".into(), Value::Array(Vec::new()));
    rules_mut(doc)?.push(json!({
        "providerId": id,
        "providerName": name,
        "config": Value::Object(cfg),
    }));
    provider_order_mut(doc)?.push(Value::String(id.clone()));
    Ok(id)
}

/// 删除供应商条目、顺序表与模型规则。账号/内置供应商由 zcode 管理,不允许删
pub fn remove_provider(doc: &mut Value, id: &str) -> Result<(), String> {
    {
        let rule = rule_mut(doc, id)?;
        let preset = id.starts_with("account:")
            || id.starts_with("family:")
            || rule
                .get("config")
                .and_then(|c| c.get("group"))
                .and_then(|g| g.as_str())
                .map(|g| g != "standard-personal")
                .unwrap_or(false);
        if preset {
            return Err(format!("内置账号供应商不可删除:{id}"));
        }
    }
    rules_mut(doc)?.retain(|r| r.get("providerId").and_then(|v| v.as_str()) != Some(id));
    if let Ok(order) = provider_order_mut(doc) {
        order.retain(|v| v.as_str() != Some(id));
    }
    if let Ok(rules) = model_rules_mut(doc) {
        rules.retain(|r| r.get("providerId").and_then(|v| v.as_str()) != Some(id));
    }
    Ok(())
}

// ---------- 从供应商接口拉取可用模型(OpenAI 兼容 GET {baseURL}/models) ----------

/// 依常见约定生成候选端点:base 已带版本段(/v1 等)时直接拼 /models,
/// 否则先试 {base}/models 再试 {base}/v1/models
fn models_endpoint_candidates(base: &str) -> Vec<String> {
    let b = base.trim_end_matches('/');
    if b.ends_with("/models") {
        return vec![b.to_string()];
    }
    let last = b.rsplit('/').next().unwrap_or("");
    if last.starts_with('v') && last[1..].chars().all(|c| c.is_ascii_digit()) {
        vec![format!("{b}/models")]
    } else {
        vec![format!("{b}/models"), format!("{b}/v1/models")]
    }
}

/// 解析 OpenAI 兼容的模型列表响应:{"data":[{"id":...}]}(id 缺失时回退 name)
fn parse_models_response(v: &Value) -> Result<Vec<String>, String> {
    let ids: Vec<String> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|it| {
                    it.get("id")
                        .or_else(|| it.get("name"))
                        .and_then(|s| s.as_str())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        return Err("接口响应里没有模型列表(data 字段为空或缺失)".to_string());
    }
    let mut ids = ids;
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// 读配置里该供应商的 baseUrl/apiKey,请求其模型列表。密钥只在本函数内使用,
/// 不经过前端;与写操作共用锁,保证读到一致的配置快照
pub fn fetch_remote_models(id: &str) -> Result<Vec<String>, String> {
    let _guard = lock();
    let doc = load(&personal_config_path())?;
    let rule = rules(&doc)
        .iter()
        .find(|r| r.get("providerId").and_then(|v| v.as_str()) == Some(id))
        .ok_or_else(|| format!("供应商不存在:{id}"))?;
    let base = rule
        .pointer("/config/api/baseUrl")
        .and_then(|u| u.as_str())
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .ok_or_else(|| "该供应商未设置 Base URL".to_string())?;
    let key = rule
        .pointer("/config/access/apiKey")
        .and_then(|k| k.as_str())
        .unwrap_or("");

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败:{e}"))?;
    let mut last_err = String::new();
    for url in models_endpoint_candidates(base) {
        let mut req = client.get(&url);
        if !key.is_empty() {
            // 同时带 Bearer 与 x-api-key,兼容 OpenAI 系与 Anthropic 系网关
            req = req
                .header("Authorization", format!("Bearer {key}"))
                .header("x-api-key", key);
        }
        match req.send() {
            Ok(resp) => match resp.error_for_status() {
                Ok(resp) => {
                    let v: Value = resp.json().map_err(|e| format!("响应解析失败:{e}"))?;
                    return parse_models_response(&v);
                }
                Err(e) => last_err = format!("{url}:{e}"),
            },
            Err(e) => last_err = format!("{url}:{e}"),
        }
    }
    Err(format!("拉取失败:{last_err}"))
}

// ---------- 落盘 ----------

const BACKUP_KEEP: usize = 5;

/// 备份当前文件(provider_config.json.bak-YYYYMMDD-HHMMSS,保留最近 BACKUP_KEEP 份),
/// 然后同目录写临时文件再 rename,保证任何时刻磁盘上都是一个完整文件
fn write_with_backup(path: &Path, doc: &Value) -> Result<(), String> {
    let json = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    if path.exists() {
        backup(path)?;
    }
    let dir = path.parent().ok_or_else(|| format!("路径异常:{}", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("provider_config"),
        std::process::id()
    ));
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("写入临时文件失败:{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换配置文件失败:{e}"))?;
    Ok(())
}

fn backup(path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("provider_config");
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let bak = path.with_file_name(format!("{name}.bak-{ts}"));
    // 备份失败就中止写入:写坏用户配置的后果比写不进去严重
    std::fs::copy(path, &bak).map_err(|e| format!("创建备份失败:{e}"))?;
    prune_backups(path, name);
    Ok(())
}

fn prune_backups(path: &Path, name: &str) {
    let prefix = format!("{name}.bak-");
    let Some(Ok(entries)) = path.parent().map(|d| d.read_dir()) else {
        return;
    };
    let mut baks: Vec<_> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .map(|e| e.path())
        .collect();
    baks.sort();
    while baks.len() > BACKUP_KEEP {
        let oldest = baks.remove(0);
        let _ = std::fs::remove_file(oldest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 与真实 provider_config.json 同构的最小样例:未知键、未知字段、
    /// 账号覆盖行(account:)、模型规则(上下文/输出/模态)都覆盖到
    const FIXTURE: &str = r#"{
      "schemaVersion": 1,
      "futureTopLevelKey": {"keep": true},
      "config": {
        "providerOrder": ["prov-b", "prov-a"],
        "providerConfigRules": {
          "providerRules": [
            {
              "providerId": "prov-a",
              "providerName": "Alpha",
              "config": {
                "group": "standard-personal",
                "access": {"type": "api-key", "apiKey": "sk-abcdefgh12345678"},
                "api": {"type": "anthropic-messages", "baseUrl": "https://a.example.com"},
                "personalModelIds": ["m1", "m2"],
                "modelOrder": ["m2", "m1"]
              }
            },
            {
              "providerId": "prov-b",
              "providerName": "Beta",
              "enabled": false,
              "config": {
                "group": "standard-personal",
                "access": {"type": "api-key"},
                "api": {"type": "openai-chat-completions"},
                "personalModelIds": [],
                "modelOrder": ["deepseek-flash"]
              }
            },
            {
              "providerId": "account:zai-start-plan",
              "config": {
                "personalModelIds": ["GLM-5.3-Flash"],
                "modelOrder": ["GLM-5.3-Flash"]
              }
            }
          ]
        },
        "modelConfigRules": {
          "providerModelRules": [
            {
              "providerId": "prov-a",
              "modelId": "m1",
              "config": {
                "enabled": true,
                "properties": {"contextWindow": 200000, "inputFormat": {"supportsImage": true}},
                "optionSpecs": {"maxOutputTokens": {"max": 32000}}
              }
            }
          ],
          "manualProviderModelRules": []
        }
      }
    }"#;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agents-dashboard-personal-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fixture_file(tag: &str) -> (PathBuf, PathBuf) {
        let dir = temp_dir(tag);
        let path = dir.join("provider_config.json");
        std::fs::write(&path, FIXTURE).unwrap();
        (dir, path)
    }

    /// 测试只关心个人供应商;智谱区会读本机 setting.json,环境不同行数不同
    fn personal(cfg: &ZProviderConfig) -> Vec<&ZProviderEntry> {
        cfg.providers.iter().filter(|p| !p.preset).collect()
    }

    #[test]
    fn extract_reads_order_enabled_models_and_masks_api_key() {
        let (dir, path) = fixture_file("extract");
        let cfg = load_config(&path).unwrap();
        let list = personal(&cfg);
        assert_eq!(list.len(), 2);
        // providerOrder 决定顺序(prov-b 在前),账号覆盖行不在其中
        assert_eq!(list[0].id, "prov-b");
        assert_eq!(list[1].id, "prov-a");

        let alpha = list[1];
        assert_eq!(alpha.name, "Alpha");
        assert_eq!(alpha.kind.as_deref(), Some("anthropic-messages"));
        assert!(alpha.enabled);
        assert_eq!(alpha.base_url.as_deref(), Some("https://a.example.com"));
        assert!(alpha.has_api_key);
        assert_eq!(alpha.api_key_hint.as_deref(), Some("5678"));
        // modelOrder 把 m2 排到前面
        assert_eq!(alpha.models.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), vec!["m2", "m1"]);
        let m1 = &alpha.models[1];
        assert_eq!(m1.context_limit, Some(200000));
        assert_eq!(m1.output_limit, Some(32000));
        assert!(m1.input_image);
        assert!(!m1.input_video);
        let m2 = &alpha.models[0];
        assert_eq!(m2.context_limit, None);

        let beta = list[0];
        assert!(!beta.enabled);
        assert!(!beta.has_api_key);
        // personalModelIds 为空时回退 modelOrder(模板继承模型)
        assert_eq!(beta.models.len(), 1);
        assert_eq!(beta.models[0].name, "deepseek-flash");

        // 账号覆盖行归入智谱区;名称优先取内置定义(找不到时回退 id)
        let overlay = cfg.providers.iter().find(|p| p.id == "account:zai-start-plan").unwrap();
        assert!(overlay.preset);
        assert!(overlay.builtin);
        assert!(overlay.name == "Start Plan" || overlay.name == "account:zai-start-plan");

        // 序列化后的响应绝不包含 apiKey 明文
        let ser = serde_json::to_string(&cfg).unwrap();
        assert!(!ser.contains("sk-abcdefgh12345678"));
        // 钉死线上字段名:baseURL 必须保持大写 URL
        assert!(ser.contains(r#""baseURL":"https://a.example.com""#));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mutations_preserve_unknown_fields_and_support_clearing() {
        let (dir, path) = fixture_file("mutate");
        update(&path, |doc| set_enabled(doc, "prov-a", false)).unwrap();
        update(&path, |doc| {
            set_base_url(doc, "prov-a", Some(" https://relay.example.com/v1 ".into()))
        })
        .unwrap();
        update(&path, |doc| set_api_key(doc, "prov-a", Some("sk-newkey-98765432".into())))
            .unwrap();

        let doc = load(&path).unwrap();
        assert_eq!(doc["futureTopLevelKey"]["keep"], json!(true));
        assert_eq!(doc.pointer("/config/providerConfigRules/providerRules/0/enabled"), Some(&json!(false)));
        assert_eq!(
            doc.pointer("/config/providerConfigRules/providerRules/0/config/api/baseUrl"),
            Some(&json!("https://relay.example.com/v1"))
        );
        assert_eq!(
            doc.pointer("/config/providerConfigRules/providerRules/0/config/access/apiKey"),
            Some(&json!("sk-newkey-98765432"))
        );

        // 清除 baseUrl / apiKey
        update(&path, |doc| set_base_url(doc, "prov-a", None)).unwrap();
        update(&path, |doc| set_api_key(doc, "prov-a", None)).unwrap();
        let doc = load(&path).unwrap();
        assert!(doc
            .pointer("/config/providerConfigRules/providerRules/0/config/api")
            .and_then(|a| a.get("baseUrl"))
            .is_none());
        assert!(doc
            .pointer("/config/providerConfigRules/providerRules/0/config/access")
            .and_then(|a| a.get("apiKey"))
            .is_none());

        // 不存在的供应商要报错且不落盘
        assert!(update(&path, |doc| set_enabled(doc, "nope", true)).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn model_add_limits_modalities_and_remove() {
        let (dir, path) = fixture_file("models");
        update(&path, |doc| add_model(doc, "prov-b", "kimi-k3", Some(100000), Some(64000), true, false))
            .unwrap();
        let doc = load(&path).unwrap();
        let cfg = &doc.pointer("/config/providerConfigRules/providerRules/1/config").unwrap();
        assert!(cfg["personalModelIds"].as_array().unwrap().iter().any(|v| v == "kimi-k3"));
        assert!(cfg["modelOrder"].as_array().unwrap().iter().any(|v| v == "kimi-k3"));
        let rule = doc
            .pointer("/config/modelConfigRules/providerModelRules")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["providerId"] == json!("prov-b") && r["modelId"] == json!("kimi-k3"))
            .unwrap();
        assert_eq!(rule.pointer("/config/properties/contextWindow"), Some(&json!(100000)));
        assert_eq!(rule.pointer("/config/optionSpecs/maxOutputTokens/max"), Some(&json!(64000)));
        assert_eq!(rule.pointer("/config/properties/inputFormat/supportsImage"), Some(&json!(true)));

        // 重复添加报错
        assert!(update(&path, |doc| add_model(doc, "prov-b", "kimi-k3", None, None, false, false)).is_err());

        // 改上限:清空输出上限会删掉 optionSpecs,上下文保留
        update(&path, |doc| set_model_limits(doc, "prov-b", "kimi-k3", Some(200000), None)).unwrap();
        let doc = load(&path).unwrap();
        let rule = doc
            .pointer("/config/modelConfigRules/providerModelRules")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["providerId"] == json!("prov-b") && r["modelId"] == json!("kimi-k3"))
            .unwrap();
        assert_eq!(rule.pointer("/config/properties/contextWindow"), Some(&json!(200000)));
        assert!(rule.pointer("/config/optionSpecs").is_none());

        // 模态开关
        update(&path, |doc| set_model_input_modalities(doc, "prov-b", "kimi-k3", false, true)).unwrap();
        let doc = load(&path).unwrap();
        let rule = doc
            .pointer("/config/modelConfigRules/providerModelRules")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["providerId"] == json!("prov-b") && r["modelId"] == json!("kimi-k3"))
            .unwrap();
        assert_eq!(rule.pointer("/config/properties/inputFormat/supportsImage"), Some(&json!(false)));
        assert_eq!(rule.pointer("/config/properties/inputFormat/supportsVideo"), Some(&json!(true)));

        // 删除:两个数组与模型规则都清掉
        update(&path, |doc| remove_model(doc, "prov-b", "kimi-k3")).unwrap();
        let doc = load(&path).unwrap();
        let cfg = &doc.pointer("/config/providerConfigRules/providerRules/1/config").unwrap();
        assert!(!cfg["personalModelIds"].as_array().unwrap().iter().any(|v| v == "kimi-k3"));
        assert!(!cfg["modelOrder"].as_array().unwrap().iter().any(|v| v == "kimi-k3"));
        assert!(!doc
            .pointer("/config/modelConfigRules/providerModelRules")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["providerId"] == json!("prov-b") && r["modelId"] == json!("kimi-k3")));
        // 不存在的模型要报错
        assert!(update(&path, |doc| remove_model(doc, "prov-b", "kimi-k3")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn add_and_remove_provider_keeps_order_and_model_rules() {
        let (dir, path) = fixture_file("providers");
        let mut new_id = String::new();
        update(&path, |doc| {
            new_id = add_provider(
                doc,
                "自建中转",
                "openai-chat-completions",
                Some(" https://relay.example.com/v1 ".into()),
                Some("sk-newkey-98765432".into()),
            )?;
            Ok(())
        })
        .unwrap();

        let doc = load(&path).unwrap();
        let order: Vec<&str> = doc
            .pointer("/config/providerOrder")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(order.last(), Some(&new_id.as_str()));
        let rule = doc
            .pointer("/config/providerConfigRules/providerRules")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["providerId"] == json!(new_id))
            .unwrap();
        assert_eq!(rule["providerName"], json!("自建中转"));
        assert_eq!(rule.pointer("/config/group"), Some(&json!("standard-personal")));
        assert_eq!(rule.pointer("/config/access/type"), Some(&json!("api-key")));
        assert_eq!(rule.pointer("/config/api/baseUrl"), Some(&json!("https://relay.example.com/v1")));
        assert_eq!(rule.pointer("/config/personalModelIds"), Some(&json!([])));

        // 加个模型再删供应商,模型规则要一起清掉
        update(&path, |doc| add_model(doc, &new_id, "m", None, None, false, false)).unwrap();
        update(&path, |doc| remove_provider(doc, &new_id)).unwrap();
        let doc = load(&path).unwrap();
        assert!(!doc
            .pointer("/config/providerConfigRules/providerRules")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["providerId"] == json!(new_id)));
        assert!(!doc
            .pointer("/config/providerOrder")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == &json!(new_id)));
        assert!(!doc
            .pointer("/config/modelConfigRules/providerModelRules")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["providerId"] == json!(new_id)));

        // 账号供应商不可删
        assert!(update(&path, |doc| remove_provider(doc, "account:zai-start-plan")).is_err());
        // 空名称/类型拒绝
        assert!(update(&path, |doc| add_provider(doc, "  ", "anthropic-messages", None, None).map(|_| ()))
            .is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn add_models_skips_duplicates_and_reports_nothing_added() {
        let (dir, path) = fixture_file("batch");
        update(&path, |doc| add_models(doc, "prov-b", &["a".into(), "b".into(), "a".into()]).map(|_| ()))
            .unwrap();
        let doc = load(&path).unwrap();
        let cfg = &doc.pointer("/config/providerConfigRules/providerRules/1/config").unwrap();
        let ids: Vec<&str> = cfg["personalModelIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["a", "b"]);
        assert!(update(&path, |doc| add_models(doc, "prov-b", &["a".into()]).map(|_| ())).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}