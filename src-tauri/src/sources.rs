use crate::error::AppError;
use crate::{db, providers};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 数据源类型。DSH 在 P6 接入（JSONL → zcode 同构索引库），
/// 查询层只认 model_usage / session / tool_usage 三张表，所以这里只需要换库路径与供应商名。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Zcode,
    #[allow(dead_code)]
    Dsh,
}

impl SourceKind {
    pub fn label(self) -> &'static str {
        match self {
            SourceKind::Zcode => "zcode",
            SourceKind::Dsh => "DSH",
        }
    }
}

/// 一个数据源要提供的全部能力：库路径、只读连接、供应商展示名、是否允许写回供应商配置。
pub trait DataSource: Send + Sync {
    fn kind(&self) -> SourceKind;
    fn db_path(&self) -> &Path;
    fn open(&self) -> Result<Connection, AppError>;
    fn provider_names(&self) -> HashMap<String, String>;
    fn supports_provider_editing(&self) -> bool;
}

/// zcode：~/.zcode/cli/db/db.sqlite（可用 ZCODE_DB_PATH 覆盖），只读打开。
pub struct ZcodeSource {
    path: PathBuf,
}

impl ZcodeSource {
    pub fn new() -> Self {
        Self { path: db::db_path() }
    }
}

impl DataSource for ZcodeSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Zcode
    }

    fn db_path(&self) -> &Path {
        &self.path
    }

    fn open(&self) -> Result<Connection, AppError> {
        Connection::open_with_flags(&self.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| {
            AppError::Unavailable(format!(
                "无法打开 zcode 数据库:{}（{e}）",
                self.path.display()
            ))
        })
    }

    fn provider_names(&self) -> HashMap<String, String> {
        providers::load_provider_names()
    }

    fn supports_provider_editing(&self) -> bool {
        true
    }
}
