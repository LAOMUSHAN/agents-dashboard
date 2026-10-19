use std::fmt;

/// 后端统一错误：内部保留分类，序列化给前端时压成一行可读文本
/// （前端各面板目前只展示字符串，保持兼容；后续要按 code 分流时再改成对象）。
#[derive(Debug)]
pub enum AppError {
    Db(rusqlite::Error),
    Unavailable(String),
    Task(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Db(e) => write!(f, "数据库查询失败：{e}"),
            AppError::Unavailable(e) => write!(f, "{e}"),
            AppError::Task(e) => write!(f, "后台任务失败：{e}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Db(e)
    }
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
