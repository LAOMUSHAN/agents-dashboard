use rusqlite::Connection;
use std::path::PathBuf;

pub fn db_path() -> PathBuf {
    if let Ok(p) = std::env::var("ZCODE_DB_PATH") {
        return PathBuf::from(p);
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".zcode/cli/db/db.sqlite")
}

/// 只读打开 zcode 的库,zcode 自身运行不受影响(WAL 模式下并发读安全)
pub fn open_db() -> rusqlite::Result<Connection> {
    Connection::open_with_flags(db_path(), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
}
