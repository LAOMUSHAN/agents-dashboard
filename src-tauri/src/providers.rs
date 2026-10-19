use std::collections::HashMap;
use std::path::PathBuf;

// zcode 的供应商配置分两处:
// - ~/.zcode/v2/provider_config.json 是 2026-09 之后「模型设置」页真正读写的地方,
//   model_usage.provider_id 现在就是这里的 providerId(UUID / new-provider-N / account:xxx);
// - ~/.zcode/v2/config.json 是旧版存储,2026-09-13 后不再更新,只留作名称兜底。
// 内置账号供应商(Z.ai / BigModel 套餐)定义在 ZCode 安装目录的 zcode-builtin.json 里。

/// 旧版配置路径(仅名称兜底,不再写入)
pub(crate) fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("ZCODE_CONFIG_PATH") {
        return PathBuf::from(p);
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".zcode/v2/config.json")
}

/// 新版个人供应商配置:面板读写的就是这个文件
pub(crate) fn personal_config_path() -> PathBuf {
    if let Ok(p) = std::env::var("ZCODE_PROVIDER_CONFIG_PATH") {
        return PathBuf::from(p);
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".zcode/v2/provider_config.json")
}

/// zcode 桌面端设置(账号套餐选择、窗口等)
pub(crate) fn setting_path() -> PathBuf {
    if let Ok(p) = std::env::var("ZCODE_SETTING_PATH") {
        return PathBuf::from(p);
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".zcode/v2/setting.json")
}

/// 内置供应商定义文件:随 ZCode 安装包分发,位置随安装方式变化。
/// 优先用 ZCode 注入给 CLI 的环境变量,其次猜默认安装路径。
pub(crate) fn builtin_config_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE") {
        return Some(PathBuf::from(p));
    }
    let base = dirs::data_local_dir()?;
    let p = base.join("Programs/ZCode/resources/config/provider/zcode-builtin.json");
    p.exists().then_some(p)
}

/// 智谱内置账号供应商的家族展示名
pub(crate) fn family_label(family: &str) -> &'static str {
    match family {
        "zai" => "Z.ai",
        "bigmodel" => "BigModel",
        _ => "智谱",
    }
}

/// 内置账号供应商的 id -> 名称(Z.ai / BigModel 的账号套餐)
pub(crate) fn builtin_provider_names() -> HashMap<String, String> {
    let mut names = HashMap::new();
    if let Some(path) = builtin_config_path() {
        merge_rule_names(&mut names, &path);
    }
    names
}

/// providerId -> 展示名。优先级:个人配置 > 内置定义 > 旧配置 > 手工兜底;
/// 都查不到时由调用方回退成原始 id
pub fn load_provider_names() -> HashMap<String, String> {
    let mut names = HashMap::new();
    // 旧配置里已删除、但历史用量里仍可能出现的 id
    names.insert("ark-coding-plan".to_string(), "火山方舟 Coding Plan".to_string());
    names.insert("builtin:zai-start-plan".to_string(), "Start Plan".to_string());

    if let Some(path) = builtin_config_path() {
        merge_rule_names(&mut names, &path);
    }
    merge_rule_names(&mut names, &personal_config_path());
    merge_legacy_names(&mut names, &config_path());
    names
}

/// 读 provider_config 结构的 providerRules(内置文件与个人文件同构)
fn merge_rule_names(names: &mut HashMap<String, String>, path: &PathBuf) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    let Some(rules) = v
        .pointer("/config/providerConfigRules/providerRules")
        .and_then(|r| r.as_array())
    else {
        return;
    };
    for r in rules {
        let Some(id) = r.get("providerId").and_then(|i| i.as_str()) else {
            continue;
        };
        if let Some(name) = r.get("providerName").and_then(|n| n.as_str()) {
            let name = name.trim();
            if !name.is_empty() {
                names.insert(id.to_string(), name.to_string());
            }
        }
    }
}

fn merge_legacy_names(names: &mut HashMap<String, String>, path: &PathBuf) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    if let Some(providers) = v.get("provider").and_then(|p| p.as_object()) {
        for (id, p) in providers {
            if let Some(name) = p.get("name").and_then(|n| n.as_str()) {
                let name = name.trim();
                if !name.is_empty() {
                    names.entry(id.clone()).or_insert_with(|| name.to_string());
                }
            }
        }
    }
}
