//! 数据源范围与状态。
//!
//! 查询层把两个源（zcode / DSH）投影成一个带 `source` 列的查询面；
//! 本模块只定义范围枚举、展示名和路径，不持有任何连接或后台任务。

use serde::Deserialize;
use std::path::{Path, PathBuf};

/// 前端传来的数据源范围：全部 / 只看 zcode / 只看 DSH。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SourceFilter {
    #[default]
    All,
    Zcode,
    Dsh,
}

impl SourceFilter {
    /// 该范围是否包含某个源；前端/状态展示用。
    #[allow(dead_code)]
    pub fn includes(self, id: SourceId) -> bool {
        match self {
            SourceFilter::All => true,
            SourceFilter::Zcode => id == SourceId::Zcode,
            SourceFilter::Dsh => id == SourceId::Dsh,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceId {
    Zcode,
    Dsh,
}

impl SourceId {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceId::Zcode => "zcode",
            SourceId::Dsh => "dsh",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            SourceId::Zcode => "zcode",
            SourceId::Dsh => "DSH",
        }
    }
}

/// 每个源的可用性 / 新鲜度，随 DashboardPayload 一起返回。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub available: bool,
    /// DSH 索引最后更新时间（epoch ms）；zcode 是实时库，固定 0
    pub indexed_at: i64,
    pub error: Option<String>,
}

pub fn zcode_db_path() -> PathBuf {
    crate::db::db_path()
}

pub fn dsh_index_path(config_dir: &Path) -> PathBuf {
    config_dir.join("dsh-index.sqlite")
}

pub fn dsh_sessions_root() -> PathBuf {
    crate::dsh::default_sessions_root()
}
