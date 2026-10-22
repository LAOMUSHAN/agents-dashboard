use std::collections::HashMap;
use std::path::PathBuf;

// zcode 的供应商配置分两处:
// - ~/.zcode/v2/provider_config.json 是 2026-09 之后 ZCode 自己的「模型设置」页读写的地方,
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

/// 新版供应商配置:用于读取供应商展示名
pub(crate) fn provider_config_path() -> PathBuf {
    if let Ok(p) = std::env::var("ZCODE_PROVIDER_CONFIG_PATH") {
        return PathBuf::from(p);
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".zcode/v2/provider_config.json")
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
    merge_rule_names(&mut names, &provider_config_path());
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

/// DSH 的供应商定义在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的
/// `config.providers.<key>.displayName`。usage 里记录的是这个 key（如 workbuddy），
/// 这里做一个轻量 YAML 行解析，避免为几个展示名引入完整 YAML 依赖。
pub fn load_dsh_provider_names() -> HashMap<String, String> {
    let mut names = HashMap::new();
    let profiles = dsh_profiles_dir();
    let desktop = profiles.join("desktop/cordis.patch.yml");
    let mut files: Vec<PathBuf> = if desktop.exists() {
        vec![desktop]
    } else {
        let Ok(entries) = std::fs::read_dir(&profiles) else {
            return names;
        };
        entries
            .flatten()
            .map(|e| e.path().join("cordis.patch.yml"))
            .filter(|p| p.exists())
            .collect()
    };
    files.sort();
    for path in files {
        parse_dsh_provider_names(&path, &mut names);
    }
    names
}

fn dsh_profiles_dir() -> PathBuf {
    if let Ok(p) = std::env::var("DSH_PROFILES_DIR") {
        return PathBuf::from(p);
    }
    if let Ok(p) = std::env::var("DSH_HOME") {
        return PathBuf::from(p).join("profiles");
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".dsh/profiles")
}

fn parse_dsh_provider_names(path: &PathBuf, out: &mut HashMap<String, String>) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let mut in_providers = false;
    let mut provider_indent: Option<usize> = None;
    let mut last_key: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if trimmed == "providers:" {
            in_providers = true;
            provider_indent = None;
            last_key = None;
            continue;
        }
        if !in_providers {
            continue;
        }
        // 回到与 providers 同级或更浅的键，说明这一段结束
        if indent <= 4 && trimmed.ends_with(':') {
            in_providers = false;
            continue;
        }
        if let Some(key) = trimmed.strip_suffix(':') {
            if !key.contains(' ') {
                if provider_indent.is_none() {
                    provider_indent = Some(indent);
                }
                if Some(indent) == provider_indent {
                    let key = key.trim().trim_matches('"').trim_matches('\'').to_string();
                    // 先登记原始 key，displayName 再覆盖
                    out.entry(key.clone()).or_insert_with(|| key.clone());
                    last_key = Some(key);
                    continue;
                }
            }
        }
        if let Some(rest) = trimmed.strip_prefix("displayName:") {
            if let Some(key) = &last_key {
                let name = rest
                    .split(" #")
                    .next()
                    .unwrap_or("")
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string();
                if !name.is_empty() {
                    out.insert(key.clone(), name);
                }
            }
        }
    }
}

