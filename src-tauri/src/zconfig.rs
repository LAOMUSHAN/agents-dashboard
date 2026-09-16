//! zcode 配置文件(~/.zcode/v2/config.json)的读写,面板里唯一会改 zcode 文件的地方。
//! 写入前做带时间戳的备份(保留最近 5 份),临时文件 + rename 原子替换;
//! 读-改-写全程持锁串行,只改目标字段,文档里其他键(含未知字段)一律原样保留。

use crate::providers::config_path;
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

/// 从已解析的文档提取供应商条目列表
fn extract_entries(doc: &Value) -> Vec<ZProviderEntry> {
    let mut entries = Vec::new();
    if let Some(providers) = doc.get("provider").and_then(|p| p.as_object()) {
        for (id, p) in providers {
            entries.push(entry_from_json(id, p));
        }
    }
    entries
}

fn build_config(path: &Path, doc: &Value) -> ZProviderConfig {
    ZProviderConfig {
        path: path.display().to_string(),
        providers: extract_entries(doc),
    }
}

/// get_provider_config:读默认配置路径
pub fn load_default() -> Result<ZProviderConfig, String> {
    load_config(&config_path())
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
    update(&config_path(), f)
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

fn entry_from_json(id: &str, p: &Value) -> ZProviderEntry {
    let options = p.get("options");
    let api_key = options.and_then(|o| o.get("apiKey")).and_then(|k| k.as_str());
    // models 是"模型名 -> {limit:{context,output}, modalities:{input,output}, zcode?}"的映射
    //(真实 schema,不是数组),这里扁平化出前端需要的字段;
    // preserve_order 下迭代顺序即配置文件里的原始顺序
    let models = p
        .get("models")
        .and_then(|m| m.as_object())
        .map(|m| m.iter().map(|(name, v)| model_entry_from_json(name, v)).collect())
        .unwrap_or_default();
    ZProviderEntry {
        id: id.to_string(),
        name: p
            .get("name")
            .and_then(|n| n.as_str())
            .filter(|n| !n.is_empty())
            .unwrap_or(id)
            .to_string(),
        kind: opt_string(p.get("kind")),
        source: opt_string(p.get("source")),
        builtin: id.starts_with("builtin:"),
        enabled: p.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true),
        system_disabled_reason: opt_string(p.get("systemDisabledReason")),
        base_url: options.and_then(|o| o.get("baseURL")).and_then(as_string),
        has_api_key: api_key.is_some(),
        // 只回传尾 4 位;按字符切避免多字节边界 panic,过短的不给 hint
        api_key_hint: api_key.and_then(tail_hint),
        models,
    }
}

fn opt_string(v: Option<&Value>) -> Option<String> {
    v.and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string)
}

fn as_string(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// 模型条目扁平化:名字是映射的 key,limit/modalities 从值对象里取
fn model_entry_from_json(name: &str, v: &Value) -> ZModelEntry {
    let input_modalities = || {
        v.pointer("/modalities/input")
            .and_then(|a| a.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>())
            .unwrap_or_default()
    };
    ZModelEntry {
        name: name.to_string(),
        context_limit: v.pointer("/limit/context").and_then(|n| n.as_i64()),
        output_limit: v.pointer("/limit/output").and_then(|n| n.as_i64()),
        input_image: input_modalities().iter().any(|s| *s == "image"),
        input_video: input_modalities().iter().any(|s| *s == "video"),
    }
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

// ---------- 字段修改(在已解析文档上操作,不碰其他键) ----------

fn provider_mut<'a>(doc: &'a mut Value, id: &str) -> Result<&'a mut Map<String, Value>, String> {
    doc.get_mut("provider")
        .and_then(|p| p.as_object_mut())
        .ok_or_else(|| "配置文件中没有 provider 对象".to_string())?
        .get_mut(id)
        .and_then(|p| p.as_object_mut())
        .ok_or_else(|| format!("供应商不存在:{id}"))
}

fn options_mut(p: &mut Map<String, Value>) -> &mut Map<String, Value> {
    if !p.get("options").map(|o| o.is_object()).unwrap_or(false) {
        p.insert("options".into(), Value::Object(Map::new()));
    }
    p.get_mut("options").and_then(|o| o.as_object_mut()).expect("options 刚确保为对象")
}

pub fn set_enabled(doc: &mut Value, id: &str, enabled: bool) -> Result<(), String> {
    provider_mut(doc, id)?.insert("enabled".into(), Value::Bool(enabled));
    Ok(())
}

/// url 为 None 或空白时删除 baseURL 字段(与"未设置"状态一致)
pub fn set_base_url(doc: &mut Value, id: &str, url: Option<String>) -> Result<(), String> {
    let p = provider_mut(doc, id)?;
    match url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()) {
        Some(u) => options_mut(p).insert("baseURL".into(), Value::String(u)),
        None => options_mut(p).remove("baseURL"),
    };
    Ok(())
}

/// key 为 None 或空白时清除 apiKey 字段
pub fn set_api_key(doc: &mut Value, id: &str, key: Option<String>) -> Result<(), String> {
    let p = provider_mut(doc, id)?;
    match key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => options_mut(p).insert("apiKey".into(), Value::String(k)),
        None => options_mut(p).remove("apiKey"),
    };
    Ok(())
}

// ---------- 模型配置管理(models 映射) ----------

/// 取(必要时创建)供应商的 models 映射
fn models_mut<'a>(p: &'a mut Map<String, Value>) -> Result<&'a mut Map<String, Value>, String> {
    if !p.get("models").map(|m| m.is_object()).unwrap_or(false) {
        p.insert("models".into(), Value::Object(Map::new()));
    }
    p.get_mut("models").and_then(|m| m.as_object_mut()).ok_or_else(|| "models 字段异常".to_string())
}

/// 定位单个模型的值对象
fn model_entry_mut<'a>(
    p: &'a mut Map<String, Value>,
    model: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    p.get_mut("models")
        .and_then(|m| m.as_object_mut())
        .and_then(|m| m.get_mut(model))
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| format!("模型不存在:{model}"))
}

/// 新增模型。条目结构与现有数据对齐:modalities.input = text + 勾选的 image/video,
/// output 固定 text;上下文/输出上限任一填写才写 limit 字段
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
    let p = provider_mut(doc, id)?;
    let models = models_mut(p)?;
    if models.contains_key(name) {
        return Err(format!("模型已存在:{name}"));
    }
    insert_model_entry(models, name, context_limit, output_limit, input_image, input_video);
    Ok(())
}

/// 批量新增(从接口导入用):跳过空名与已存在的,一次落盘只做一次备份/写入。
/// 没有任何有效新增时报错
pub fn add_models(doc: &mut Value, id: &str, names: &[String]) -> Result<usize, String> {
    let candidates: Vec<String> = names.iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
    if candidates.is_empty() {
        return Err("没有可添加的模型".to_string());
    }
    let p = provider_mut(doc, id)?;
    let models = models_mut(p)?;
    let mut added = 0;
    for name in candidates {
        if models.contains_key(&name) {
            continue;
        }
        // 批量导入无法逐个勾模态,先按纯文本建条目,之后在界面上开
        insert_model_entry(models, &name, None, None, false, false);
        added += 1;
    }
    if added == 0 {
        return Err("所选模型均已配置".to_string());
    }
    Ok(added)
}

fn insert_model_entry(
    models: &mut Map<String, Value>,
    name: &str,
    context_limit: Option<i64>,
    output_limit: Option<i64>,
    input_image: bool,
    input_video: bool,
) {
    let mut limit = Map::new();
    if let Some(v) = context_limit {
        limit.insert("context".into(), json!(v));
    }
    if let Some(v) = output_limit {
        limit.insert("output".into(), json!(v));
    }
    let mut input = vec![Value::String("text".into())];
    if input_image {
        input.push(Value::String("image".into()));
    }
    if input_video {
        input.push(Value::String("video".into()));
    }
    let mut entry = Map::new();
    entry.insert("modalities".into(), json!({"input": input, "output": ["text"]}));
    if !limit.is_empty() {
        entry.insert("limit".into(), Value::Object(limit));
    }
    models.insert(name.to_string(), Value::Object(entry));
}

pub fn remove_model(doc: &mut Value, id: &str, model: &str) -> Result<(), String> {
    let name = model.trim();
    let p = provider_mut(doc, id)?;
    if models_mut(p)?.remove(name).is_none() {
        return Err(format!("模型不存在:{name}"));
    }
    Ok(())
}

/// 编辑上下文/输出上限;None 表示删除对应字段(两者都删光则连 limit 对象一并移除)
pub fn set_model_limits(
    doc: &mut Value,
    id: &str,
    model: &str,
    context_limit: Option<i64>,
    output_limit: Option<i64>,
) -> Result<(), String> {
    let name = model.trim();
    let p = provider_mut(doc, id)?;
    let entry = model_entry_mut(p, name)?;
    if !entry.get("limit").map(|l| l.is_object()).unwrap_or(false) {
        entry.insert("limit".into(), Value::Object(Map::new()));
    }
    let limit = entry.get_mut("limit").and_then(|l| l.as_object_mut()).expect("limit 刚确保为对象");
    match context_limit {
        Some(v) => drop(limit.insert("context".into(), json!(v))),
        None => drop(limit.remove("context")),
    }
    match output_limit {
        Some(v) => drop(limit.insert("output".into(), json!(v))),
        None => drop(limit.remove("output")),
    }
    if limit.is_empty() {
        entry.remove("limit");
    }
    Ok(())
}

/// 设置输入模态(text 恒在,image/video 由开关决定);output 一律不动。
/// 条目原本没有 modalities 时补一个最小结构
pub fn set_model_input_modalities(
    doc: &mut Value,
    id: &str,
    model: &str,
    image: bool,
    video: bool,
) -> Result<(), String> {
    let name = model.trim();
    let p = provider_mut(doc, id)?;
    let entry = model_entry_mut(p, name)?;
    if !entry.get("modalities").map(|m| m.is_object()).unwrap_or(false) {
        entry.insert("modalities".into(), json!({"output": ["text"]}));
    }
    let mods = entry
        .get_mut("modalities")
        .and_then(|m| m.as_object_mut())
        .expect("modalities 刚确保为对象");
    let mut input = vec![Value::String("text".into())];
    if image {
        input.push(Value::String("image".into()));
    }
    if video {
        input.push(Value::String("video".into()));
    }
    mods.insert("input".into(), Value::Array(input));
    Ok(())
}

// ---------- 新增供应商 ----------

/// 新增自定义供应商,条目结构与 zcode 自己写的自定义条目对齐:
/// UUID 作 key、source=custom,options 里 baseURL/apiKey 有值才写,
/// apiKeyRequired 恒为 true。返回新 id 供前端定位并展开
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
    if !doc
        .get("provider")
        .map(|p| p.is_object())
        .unwrap_or(false)
    {
        // 配置里还没有任何供应商时补出顶层 provider 对象
        doc.as_object_mut()
            .ok_or_else(|| "配置文件顶层不是对象".to_string())?
            .insert("provider".into(), Value::Object(Map::new()));
    }
    let providers = doc
        .get_mut("provider")
        .and_then(|p| p.as_object_mut())
        .expect("provider 刚确保为对象");
    let id = uuid::Uuid::new_v4().to_string();
    let mut options = Map::new();
    if let Some(u) = base_url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()) {
        options.insert("baseURL".into(), Value::String(u));
    }
    if let Some(k) = api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        options.insert("apiKey".into(), Value::String(k));
    }
    options.insert("apiKeyRequired".into(), Value::Bool(true));
    providers.insert(
        id.clone(),
        json!({
            "name": name,
            "kind": kind,
            "source": "custom",
            "options": Value::Object(options),
        }),
    );
    Ok(id)
}

/// 删除供应商条目。内置供应商(builtin: 前缀)是 zcode 自身的定义,
/// 面板不允许删,这里同样兜底拒绝
pub fn remove_provider(doc: &mut Value, id: &str) -> Result<(), String> {
    if id.starts_with("builtin:") {
        return Err(format!("内置供应商不可删除:{id}"));
    }
    let providers = doc
        .get_mut("provider")
        .and_then(|p| p.as_object_mut())
        .ok_or_else(|| "配置文件中没有 provider 对象".to_string())?;
    if providers.remove(id).is_none() {
        return Err(format!("供应商不存在:{id}"));
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

/// 读配置里该供应商的 baseURL/apiKey,请求其模型列表。密钥只在本函数内使用,
/// 不经过前端;与写操作共用锁,保证读到一致的配置快照
pub fn fetch_remote_models(id: &str) -> Result<Vec<String>, String> {
    let _guard = lock();
    let doc = load(&config_path())?;
    let p = doc
        .get("provider")
        .and_then(|p| p.as_object())
        .and_then(|m| m.get(id))
        .ok_or_else(|| format!("供应商不存在:{id}"))?;
    let options = p.get("options");
    let base = options
        .and_then(|o| o.get("baseURL"))
        .and_then(as_string)
        .ok_or_else(|| "该供应商未设置 Base URL".to_string())?;
    let key = options
        .and_then(|o| o.get("apiKey"))
        .and_then(|k| k.as_str())
        .unwrap_or("");

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败:{e}"))?;
    let mut last_err = String::new();
    for url in models_endpoint_candidates(&base) {
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

/// 备份当前文件(config.json.bak-YYYYMMDD-HHMMSS,保留最近 BACKUP_KEEP 份),
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
        path.file_name().and_then(|n| n.to_str()).unwrap_or("config"),
        std::process::id()
    ));
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("写入临时文件失败:{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换配置文件失败:{e}"))?;
    Ok(())
}

fn backup(path: &Path) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("config");
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

    /// 与真实 config.json 同构的最小样例:models 是"模型名 -> 元信息"的映射
    /// (2026-08-24 踩过的坑:不是数组),builtin 带 enabled/systemDisabledReason,
    /// 自定义(UUID key)没有 enabled 字段,options 含 apiKey/baseURL,顶层有未知键
    const FIXTURE: &str = r#"{
      "someFutureTopLevelKey": {"keep": true},
      "provider": {
        "builtin:zai-coding-plan": {
          "name": "智谱 Coding Plan",
          "kind": "anthropic",
          "source": "builtin",
          "enabled": false,
          "systemDisabledReason": "quota exceeded",
          "options": {"apiKey": "sk-abcdefgh12345678", "baseURL": "https://api.example.com"},
          "models": {
            "glm-5.3": {
              "modalities": {"input": ["text", "image", "video"], "output": ["text"]},
              "limit": {"context": 200000, "output": 32000}
            },
            "glm-4.7": {}
          }
        },
        "2dbad4a2-uuid-1": {
          "name": "自建中转",
          "kind": "openai",
          "source": "user",
          "models": {
            "kimi-k3": {
              "zcode": true,
              "modalities": {"input": ["text", "image"], "output": ["text"]},
              "limit": {"context": 100000, "output": 64000}
            }
          }
        }
      }
    }"#;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agents-dashboard-zconfig-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fixture_file(tag: &str) -> (PathBuf, PathBuf) {
        let dir = temp_dir(tag);
        let path = dir.join("config.json");
        std::fs::write(&path, FIXTURE).unwrap();
        (dir, path)
    }

    #[test]
    fn extract_reads_fields_and_masks_api_key() {
        let (_, path) = fixture_file("extract");
        let cfg = load_config(&path).unwrap();
        assert_eq!(cfg.providers.len(), 2);

        let builtin =
            cfg.providers.iter().find(|p| p.id == "builtin:zai-coding-plan").unwrap();
        assert!(builtin.builtin);
        assert!(!builtin.enabled);
        assert_eq!(builtin.system_disabled_reason.as_deref(), Some("quota exceeded"));
        assert_eq!(builtin.base_url.as_deref(), Some("https://api.example.com"));
        assert!(builtin.has_api_key);
        assert_eq!(builtin.api_key_hint.as_deref(), Some("5678"));
        // preserve_order 下模型顺序即配置文件里的原始顺序
        assert_eq!(builtin.models.len(), 2);
        let glm53 = &builtin.models[0];
        assert_eq!(glm53.name, "glm-5.3");
        assert_eq!(glm53.context_limit, Some(200000));
        assert_eq!(glm53.output_limit, Some(32000));
        assert!(glm53.input_image);
        assert!(glm53.input_video);
        // 空条目:limit/modalities 缺失时是 None/false
        let glm47 = &builtin.models[1];
        assert_eq!(glm47.name, "glm-4.7");
        assert_eq!(glm47.context_limit, None);
        assert!(!glm47.input_image);

        let custom = cfg.providers.iter().find(|p| p.id == "2dbad4a2-uuid-1").unwrap();
        assert!(!custom.builtin);
        // 自定义供应商没有 enabled 字段,视为启用
        assert!(custom.enabled);
        assert!(!custom.has_api_key);
        assert!(custom.api_key_hint.is_none());
        let kimi = &custom.models[0];
        assert_eq!(kimi.name, "kimi-k3");
        assert!(kimi.input_image);
        assert!(!kimi.input_video);

        // 序列化后的响应绝不包含 apiKey 明文
        let ser = serde_json::to_string(&cfg).unwrap();
        assert!(!ser.contains("sk-abcdefgh12345678"));
        // 钉死线上字段名:camelCase 会把 base_url 错转成 baseUrl,必须保持 baseURL
        assert!(ser.contains(r#""baseURL":"https://api.example.com""#));
        let _ = std::fs::remove_dir_all(temp_dir("extract"));
    }

    #[test]
    fn mutations_preserve_unknown_fields_and_support_clearing() {
        let (dir, path) = fixture_file("mutate");
        update(&path, |doc| set_enabled(doc, "2dbad4a2-uuid-1", false)).unwrap();
        update(&path, |doc| {
            set_base_url(doc, "2dbad4a2-uuid-1", Some(" https://relay.example.com/v1 ".into()))
        })
        .unwrap();
        update(&path, |doc| set_api_key(doc, "2dbad4a2-uuid-1", Some("sk-newkey-98765432".into())))
            .unwrap();

        let doc = load(&path).unwrap();
        // 未知顶层键原样保留
        assert!(doc.get("someFutureTopLevelKey").is_some());
        let custom = doc.pointer("/provider/2dbad4a2-uuid-1").unwrap();
        assert_eq!(custom.get("enabled"), Some(&Value::Bool(false)));
        assert_eq!(custom["options"]["baseURL"], "https://relay.example.com/v1");
        assert_eq!(custom["options"]["apiKey"], "sk-newkey-98765432");
        // 未触碰的字段不动
        assert_eq!(custom["kind"], "openai");
        assert!(custom.pointer("/models/kimi-k3").is_some());

        // 清除语义:None 和空白都把字段删掉
        update(&path, |doc| set_api_key(doc, "2dbad4a2-uuid-1", None)).unwrap();
        update(&path, |doc| set_base_url(doc, "2dbad4a2-uuid-1", Some("   ".into()))).unwrap();
        let custom = load(&path)
            .unwrap()
            .pointer("/provider/2dbad4a2-uuid-1")
            .unwrap()
            .clone();
        assert!(custom.pointer("/options/apiKey").is_none());
        assert!(custom.pointer("/options/baseURL").is_none());

        // 不存在的供应商报错且不落盘
        let before = std::fs::read_to_string(&path).unwrap();
        assert!(update(&path, |doc| set_enabled(doc, "nope", true)).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn write_creates_backup_and_prunes_old_ones() {
        let (dir, path) = fixture_file("backup");
        // 先手工造满额旧备份,固定宽度时间戳保证字典序即时间序
        for i in 1..=BACKUP_KEEP {
            let bak = path.with_file_name(format!("config.json.bak-2026010{i}-000000"));
            std::fs::write(bak, "old").unwrap();
        }
        let cfg = load_config(&path).unwrap();
        write_with_backup(&path, &serde_json::to_value(&cfg).unwrap()).unwrap();

        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("config.json.bak-"))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        // 新备份生成后总数回到上限,最旧的一份(20260101)被清掉
        assert_eq!(names.len(), BACKUP_KEEP);
        assert!(names.iter().any(|n| n.starts_with("config.json.bak-20") && !n.contains("-202601")));
        assert!(!names.iter().any(|n| n.contains("20260101")));

        // 主文件内容仍是合法 JSON 且数据完好
        assert!(load(&path).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn model_management_add_edit_remove() {
        let (dir, path) = fixture_file("models");

        // 新增:带上限与图像输入;模态 input = text + 勾选项
        update(&path, |doc| {
            add_model(doc, "2dbad4a2-uuid-1", "new-model", Some(128000), None, true, false)
        })
        .unwrap();
        let cfg = load_config(&path).unwrap();
        let custom = cfg.providers.iter().find(|p| p.id == "2dbad4a2-uuid-1").unwrap();
        let m = custom.models.iter().find(|m| m.name == "new-model").unwrap();
        assert_eq!(m.context_limit, Some(128000));
        assert_eq!(m.output_limit, None);
        assert!(m.input_image && !m.input_video);

        // 编辑 limit 与输入模态
        update(&path, |doc| {
            set_model_limits(doc, "2dbad4a2-uuid-1", "new-model", Some(256000), Some(32000))
        })
        .unwrap();
        update(&path, |doc| {
            set_model_input_modalities(doc, "2dbad4a2-uuid-1", "new-model", true, true)
        })
        .unwrap();

        // 已有条目的未知字段(zcode 标记)与 output 模态不受影响
        let doc = load(&path).unwrap();
        let kimi = doc.pointer("/provider/2dbad4a2-uuid-1/models/kimi-k3").unwrap();
        assert_eq!(kimi.get("zcode"), Some(&Value::Bool(true)));
        assert_eq!(kimi.pointer("/modalities/output"), Some(&json!(["text"])));
        let newm = doc.pointer("/provider/2dbad4a2-uuid-1/models/new-model").unwrap();
        assert_eq!(
            newm.pointer("/modalities/input"),
            Some(&json!(["text", "image", "video"]))
        );
        assert_eq!(newm.pointer("/limit/context"), Some(&json!(256000)));

        // limit 全删光时连对象一并移除,modalities 保留
        update(&path, |doc| set_model_limits(doc, "2dbad4a2-uuid-1", "new-model", None, None))
            .unwrap();
        let newm =
            load(&path).unwrap().pointer("/provider/2dbad4a2-uuid-1/models/new-model").unwrap().clone();
        assert!(newm.get("limit").is_none());
        assert!(newm.get("modalities").is_some());

        // 删除
        update(&path, |doc| remove_model(doc, "2dbad4a2-uuid-1", "new-model")).unwrap();
        let cfg = load_config(&path).unwrap();
        let custom = cfg.providers.iter().find(|p| p.id == "2dbad4a2-uuid-1").unwrap();
        assert!(!custom.models.iter().any(|m| m.name == "new-model"));
        assert!(custom.models.iter().any(|m| m.name == "kimi-k3"));

        // 错误分支:重名、不存在、空白名、未知供应商
        assert!(update(&path, |doc| add_model(doc, "2dbad4a2-uuid-1", "kimi-k3", None, None, false, false))
            .is_err());
        assert!(update(&path, |doc| remove_model(doc, "2dbad4a2-uuid-1", "nope")).is_err());
        assert!(update(&path, |doc| add_model(doc, "2dbad4a2-uuid-1", "   ", None, None, false, false)).is_err());
        assert!(update(&path, |doc| add_model(doc, "nope", "x", None, None, false, false)).is_err());
        assert!(update(&path, |doc| set_model_input_modalities(
            doc,
            "2dbad4a2-uuid-1",
            "nope",
            true,
            false
        ))
        .is_err());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn remote_model_endpoint_and_parsing() {
        // 端点候选:带版本段的直接拼 /models,其余先试裸拼再试补 /v1
        assert_eq!(
            models_endpoint_candidates("https://api.example.com/v1/"),
            vec!["https://api.example.com/v1/models"]
        );
        assert_eq!(
            models_endpoint_candidates("https://api.example.com"),
            vec![
                "https://api.example.com/models",
                "https://api.example.com/v1/models"
            ]
        );
        assert_eq!(
            models_endpoint_candidates("https://api.example.com/v1/models"),
            vec!["https://api.example.com/v1/models"]
        );

        // OpenAI 兼容响应
        let v: Value = serde_json::from_str(
            r#"{"object":"list","data":[{"id":"b-model"},{"id":"a-model"},{"id":"a-model"}]}"#,
        )
        .unwrap();
        assert_eq!(parse_models_response(&v).unwrap(), vec!["a-model", "b-model"]);

        // id 缺失时回退 name;非法/空响应报错
        let v: Value = serde_json::from_str(r#"{"data":[{"name":"m-1"}]}"#).unwrap();
        assert_eq!(parse_models_response(&v).unwrap(), vec!["m-1"]);
        let v: Value = serde_json::from_str(r#"{"data":[]}"#).unwrap();
        assert!(parse_models_response(&v).is_err());
        let v: Value = serde_json::from_str(r#"{"error":{"message":"nope"}}"#).unwrap();
        assert!(parse_models_response(&v).is_err());
    }

    #[test]
    fn batch_add_skips_existing_and_requires_content() {
        let (dir, path) = fixture_file("batch");
        update(&path, |doc| {
            add_models(doc, "2dbad4a2-uuid-1", &["m-new".into(), "kimi-k3".into(), "  ".into()])
                .map(|_| ())
        })
        .unwrap();
        let custom = load_config(&path)
            .unwrap()
            .providers
            .into_iter()
            .find(|p| p.id == "2dbad4a2-uuid-1")
            .unwrap();
        assert_eq!(
            custom.models.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
            vec!["kimi-k3", "m-new"]
        );
        // 全部已存在或全空时报错,不落盘
        let before = std::fs::read_to_string(&path).unwrap();
        assert!(update(&path, |doc| add_models(doc, "2dbad4a2-uuid-1", &["m-new".into()]).map(|_| ()))
            .is_err());
        assert!(update(&path, |doc| add_models(doc, "2dbad4a2-uuid-1", &[" ".into()]).map(|_| ()))
            .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn add_provider_creates_custom_entry_with_uuid_key() {
        let (dir, path) = fixture_file("add-provider");
        let mut id = String::new();
        update(&path, |doc| {
            id = add_provider(
                doc,
                " 我的中转站 ",
                "openai-compatible",
                Some(" https://relay.example.com/v1 ".into()),
                Some("sk-brandnew-12345678".into()),
            )?;
            Ok(())
        })
        .unwrap();

        // key 是合法 UUID,与 builtin 前缀风格区分
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        let doc = load(&path).unwrap();
        // 未知顶层键不受影响,新条目结构与 zcode 自写自定义条目一致
        assert!(doc.get("someFutureTopLevelKey").is_some());
        let entry = doc.pointer(&format!("/provider/{id}")).unwrap();
        assert_eq!(entry["name"], "我的中转站");
        assert_eq!(entry["kind"], "openai-compatible");
        assert_eq!(entry["source"], "custom");
        assert_eq!(entry["options"]["baseURL"], "https://relay.example.com/v1");
        assert_eq!(entry["options"]["apiKeyRequired"], Value::Bool(true));
        // 读回视图:enabled 缺失视为启用,builtin 为 false
        let cfg = load_config(&path).unwrap();
        let p = cfg.providers.iter().find(|p| p.id == id).unwrap();
        assert!(!p.builtin && p.enabled);
        assert!(p.has_api_key);

        // 可选字段留空时不写入对应 options 键
        let mut id2 = String::new();
        update(&path, |doc| {
            id2 = add_provider(doc, "极简", "anthropic", None, Some("  ".into()))?;
            Ok(())
        })
        .unwrap();
        let opts = load(&path).unwrap().pointer(&format!("/provider/{id2}/options")).unwrap().clone();
        assert!(opts.get("baseURL").is_none());
        assert!(opts.get("apiKey").is_none());
        assert_eq!(opts.get("apiKeyRequired"), Some(&Value::Bool(true)));

        // 配置里没有 provider 对象时也能从零建出
        let dir2 = temp_dir("fresh");
        let fresh = dir2.join("config.json");
        std::fs::write(&fresh, r#"{"someOtherKey":1}"#).unwrap();
        let mut id3 = String::new();
        update(&fresh, |doc| {
            id3 = add_provider(doc, "首个", "anthropic", None, None)?;
            Ok(())
        })
        .unwrap();
        let doc = load(&fresh).unwrap();
        assert!(doc.get("someOtherKey").is_some());
        assert!(doc.pointer(&format!("/provider/{id3}")).is_some());

        // 空白名称/类型报错且不落盘
        let before = std::fs::read_to_string(&path).unwrap();
        assert!(update(&path, |doc| add_provider(doc, "  ", "anthropic", None, None).map(|_| ()))
            .is_err());
        assert!(update(&path, |doc| add_provider(doc, "x", "  ", None, None).map(|_| ())).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);

        // 删除:自定义条目可删,其他条目不受影响
        update(&path, |doc| remove_provider(doc, &id2)).unwrap();
        let cfg = load_config(&path).unwrap();
        assert!(!cfg.providers.iter().any(|p| p.id == id2));
        assert!(cfg.providers.iter().any(|p| p.id == id));

        // 内置供应商与不存在的 id 都拒绝,文件不动
        let before = std::fs::read_to_string(&path).unwrap();
        assert!(update(&path, |doc| remove_provider(doc, "builtin:zai-coding-plan")).is_err());
        assert!(update(&path, |doc| remove_provider(doc, "nope")).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);

        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(temp_dir("fresh"));
    }

    #[test]
    fn invalid_json_and_missing_file_report_errors() {
        let dir = temp_dir("bad");
        let path = dir.join("config.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(load_config(&path).is_err());
        assert!(update(&path, |doc| set_enabled(doc, "x", true)).is_err());

        let missing = dir.join("nope.json");
        assert!(load_config(&missing).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
