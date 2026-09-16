use std::collections::HashMap;
use std::path::PathBuf;

// zcode 的供应商定义在 ~/.zcode/v2/config.json 的 provider 字段里,
// model_usage.provider_id 就是它的 key(UUID 或 builtin:xxx)
pub(crate) fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("ZCODE_CONFIG_PATH") {
        return PathBuf::from(p);
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".zcode/v2/config.json")
}

/// providerId -> 展示名;读不到配置或未收录的 id 由调用方回退为原始 id。只取名称,不外泄 apiKey 等字段
pub fn load_provider_names() -> HashMap<String, String> {
    // 配置文件里已不存在的旧 provider_id(如迁移前的 ark-coding-plan)手动给个可读名
    let mut names = HashMap::new();
    names.insert("ark-coding-plan".to_string(), "火山方舟 Coding Plan".to_string());

    let Ok(raw) = std::fs::read_to_string(config_path()) else {
        return names;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return names;
    };
    if let Some(providers) = v.get("provider").and_then(|p| p.as_object()) {
        for (id, p) in providers {
            if let Some(name) = p.get("name").and_then(|n| n.as_str()) {
                if !name.is_empty() {
                    names.insert(id.clone(), name.to_string());
                }
            }
        }
    }
    names
}
