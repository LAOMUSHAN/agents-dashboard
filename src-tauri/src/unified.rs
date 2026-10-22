//! 统一查询层：把 zcode 库与 DSH 索引库投影成一个带 `source` 列的查询面。
//!
//! 每个查询连接：
//! 1. 只读打开 `dsh-index.sqlite`；
//! 2. `ATTACH` zcode 库（只读 URI；库不存在时 attach 一个空内存库，保证视图结构一致）；
//! 3. 创建 `TEMP VIEW model_usage / session / tool_usage`，列名与旧表一致；
//! 4. `PRAGMA query_only=ON`，查询连接不可能写任何库。
//!
//! 这样 `queries.rs` 里的 SQL 不用改表名，只多一个 `source` 列可用；
//! 数据源范围（全部/zcode/DSH）在视图定义里过滤，查询函数无需关心。

use crate::error::AppError;
use crate::sources::SourceFilter;
use rusqlite::Connection;
use std::path::Path;

/// 视图列顺序（两个分支必须完全一致）
const MODEL_COLUMNS: &str = "source, id, session_id, model_id, provider_id, agent, status, \
     started_at, duration_ms, time_to_first_token_ms, input_tokens, output_tokens, \
     reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens, \
     retry_count, cancelled_by_user, context_exceeded, error_type, error_code, error_message";
const SESSION_COLUMNS: &str = "source, id, parent_id, directory, title, task_type";
const TOOL_COLUMNS: &str = "source, tool_name, status, started_at, duration_ms";

const ZC_MODEL: &str = "SELECT 'zcode', 'zc:' || id, 'zc:' || session_id, model_id, \
     'zc:' || provider_id, agent, status, started_at, duration_ms, time_to_first_token_ms, \
     input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, \
     cache_creation_input_tokens, retry_count, cancelled_by_user, context_exceeded, \
     error_type, error_code, error_message FROM zc.model_usage";
const DSH_MODEL: &str = "SELECT 'dsh', 'dsh:' || id, 'dsh:' || session_id, model_id, \
     'dsh:' || provider_id, agent, status, started_at, duration_ms, time_to_first_token_ms, \
     input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, \
     cache_creation_input_tokens, retry_count, cancelled_by_user, context_exceeded, \
     error_type, error_code, error_message FROM dsh_model_usage";

const ZC_SESSION: &str = "SELECT 'zcode', 'zc:' || id, 'zc:' || parent_id, directory, title, task_type FROM zc.session";
const DSH_SESSION: &str = "SELECT 'dsh', 'dsh:' || id, 'dsh:' || parent_id, directory, title, task_type FROM dsh_session";

const ZC_TOOL: &str = "SELECT 'zcode', tool_name, status, started_at, duration_ms FROM zc.tool_usage";
const DSH_TOOL: &str = "SELECT 'dsh', tool_name, status, started_at, duration_ms FROM dsh_tool_usage";

/// zcode 库不存在时用它顶上，让两个分支的视图结构保持一致（空表）。
const EMPTY_ZCODE_SCHEMA: &str = "
  CREATE TABLE zc.model_usage(
    id TEXT, session_id TEXT, model_id TEXT, provider_id TEXT, agent TEXT, status TEXT,
    started_at INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
    retry_count INTEGER, cancelled_by_user INTEGER, context_exceeded INTEGER,
    error_type TEXT, error_code TEXT, error_message TEXT
  );
  CREATE TABLE zc.session(id TEXT, parent_id TEXT, directory TEXT, title TEXT, task_type TEXT);
  CREATE TABLE zc.tool_usage(tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER);
";

pub fn open_query(
    index_path: &Path,
    zcode_path: &Path,
    filter: SourceFilter,
) -> Result<Connection, AppError> {
    // 索引库由 DshIndexer::ensure_fresh 建好。这里用读写方式打开（只读连接无法在
    // attach 的空内存库里建表），创建完视图后立刻 query_only，查询连接不可能写库。
    let conn = Connection::open(index_path).map_err(|e| {
        AppError::Unavailable(format!(
            "无法打开 DSH 索引库 {}: {e}",
            index_path.display()
        ))
    })?;
    attach_zcode(&conn, zcode_path)?;

    let (model, session, tool) = match filter {
        SourceFilter::All => (
            format!("{ZC_MODEL} UNION ALL {DSH_MODEL}"),
            format!("{ZC_SESSION} UNION ALL {DSH_SESSION}"),
            format!("{ZC_TOOL} UNION ALL {DSH_TOOL}"),
        ),
        SourceFilter::Zcode => (ZC_MODEL.to_string(), ZC_SESSION.to_string(), ZC_TOOL.to_string()),
        SourceFilter::Dsh => (DSH_MODEL.to_string(), DSH_SESSION.to_string(), DSH_TOOL.to_string()),
    };
    conn.execute_batch(&format!(
        "CREATE TEMP VIEW model_usage({MODEL_COLUMNS}) AS {model};
         CREATE TEMP VIEW session({SESSION_COLUMNS}) AS {session};
         CREATE TEMP VIEW tool_usage({TOOL_COLUMNS}) AS {tool};"
    ))
    .map_err(|e| AppError::Unavailable(format!("创建统一查询视图失败: {e}")))?;
    // 查询连接不允许写任何库（包括 attach 的 zcode）
    conn.execute_batch("PRAGMA query_only=ON;")
        .map_err(|e| AppError::Unavailable(format!("设置只读查询失败: {e}")))?;
    Ok(conn)
}

fn attach_zcode(conn: &Connection, zcode_path: &Path) -> Result<(), AppError> {
    if zcode_path.exists() {
        let uri = format!("file:{}?mode=ro", path_for_uri(zcode_path));
        if conn.execute("ATTACH DATABASE ?1 AS zc", [uri.as_str()]).is_ok() {
            return Ok(());
        }
        // URI attach 不被支持时退回普通路径；query_only 会阻止误写
        conn.execute(
            "ATTACH DATABASE ?1 AS zc",
            [zcode_path.to_string_lossy().to_string()],
        )
        .map_err(|e| {
            AppError::Unavailable(format!("无法 attach zcode 库 {}: {e}", zcode_path.display()))
        })?;
        return Ok(());
    }
    conn.execute("ATTACH DATABASE ':memory:' AS zc", [])
        .map_err(|e| AppError::Unavailable(format!("无法创建空 zcode 查询面: {e}")))?;
    conn.execute_batch(EMPTY_ZCODE_SCHEMA)
        .map_err(|e| AppError::Unavailable(format!("无法创建空 zcode 表: {e}")))?;
    Ok(())
}

fn path_for_uri(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace('?', "%3f")
        .replace('#', "%23")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsh::DshIndexer;
    use std::fs;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("unified-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_zcode(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE model_usage(
                id TEXT, session_id TEXT, model_id TEXT, provider_id TEXT, agent TEXT, status TEXT,
                started_at INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER,
                input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
                cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
                retry_count INTEGER, cancelled_by_user INTEGER, context_exceeded INTEGER,
                error_type TEXT, error_code TEXT, error_message TEXT
             );
             CREATE TABLE session(id TEXT, parent_id TEXT, directory TEXT, title TEXT, task_type TEXT);
             CREATE TABLE tool_usage(tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER);
             INSERT INTO session VALUES('s1', NULL, 'C:\\proj', 'zcode title', 'interactive');
             INSERT INTO model_usage VALUES('u1','s1','m-zcode','p1','zcode-agent','completed',
                1000,100,10,100,20,0,30,0,0,0,0,NULL,NULL,NULL);
             INSERT INTO tool_usage VALUES('Read','completed',1000,5);",
        )
        .unwrap();
    }

    fn make_dsh(dir: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
        let sess = dir.join("sessions").join("proj").join("sess");
        fs::create_dir_all(&sess).unwrap();
        let frame = [
            r#"{"type":"session","version":4,"id":"session-d1","createdAt":2000,"cwd":"C:\\proj"}"#,
            r#"{"type":"session/title","time":2001,"data":{"title":"dsh title"}}"#,
            r#"{"type":"step/start","time":2100,"data":{"turn":1,"step":1}}"#,
            r#"{"type":"assistant/message","time":2200,"data":{"turn":1,"step":1,"message":{"source":{"provider":"workbuddy","model":"m-dsh"}},"usage":{"inputTokens":10,"outputTokens":5,"cacheReadTokens":40}}}"#,
            r#"{"type":"tool/call","time":2150,"data":{"turn":1,"step":1,"callId":"c1","name":"read"}}"#,
            r#"{"type":"tool/result","time":2160,"data":{"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"c1"},"content":[{"type":"tool-result","toolCallId":"c1","isError":false}]}}}"#,
            r#"{"type":"turn/end","time":2200,"data":{"turn":1,"reason":{"kind":"completed"}}}"#,
        ]
        .join("\n")
            + "\n";
        fs::write(
            sess.join("session.jsonl.zstd"),
            zstd::stream::encode_all(frame.as_bytes(), 3).unwrap(),
        )
        .unwrap();
        let index = dir.join("dsh-index.sqlite");
        let mut indexer = DshIndexer::new(dir.join("sessions"), index.clone());
        indexer.ensure_fresh(true).unwrap();
        (index, dir.join("zcode.sqlite"))
    }

    #[test]
    fn unions_and_filters_both_sources() {
        let dir = temp_dir("union");
        let (index, zcode) = make_dsh(&dir);
        make_zcode(&zcode);

        let all = open_query(&index, &zcode, SourceFilter::All).unwrap();
        let rows: Vec<(String, i64)> = all
            .prepare("SELECT source, COUNT(*) FROM model_usage GROUP BY source ORDER BY source")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(rows, vec![("dsh".to_string(), 1), ("zcode".to_string(), 1)]);

        let ids: Vec<String> = all
            .prepare("SELECT id FROM model_usage ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(ids.iter().any(|s| s.starts_with("zc:")), "ids={ids:?}");
        assert!(ids.iter().any(|s| s.starts_with("dsh:")), "ids={ids:?}");

        let zc_only = open_query(&index, &zcode, SourceFilter::Zcode).unwrap();
        let n: i64 = zc_only
            .query_row("SELECT COUNT(*) FROM model_usage", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let title: String = zc_only
            .query_row("SELECT title FROM session", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "zcode title");

        let dsh_only = open_query(&index, &zcode, SourceFilter::Dsh).unwrap();
        let n: i64 = dsh_only
            .query_row("SELECT COUNT(*) FROM model_usage", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let (input, output, read): (i64, i64, i64) = dsh_only
            .query_row(
                "SELECT input_tokens, output_tokens, cache_read_input_tokens FROM model_usage",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((input, output, read), (50, 5, 40));

        // zcode 库不存在时仍能查询 DSH，且不报错
        let no_zc = open_query(&index, &dir.join("missing.sqlite"), SourceFilter::All).unwrap();
        let rows: Vec<(String, i64)> = no_zc
            .prepare("SELECT source, COUNT(*) FROM model_usage GROUP BY source")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(rows, vec![("dsh".to_string(), 1)]);

        let _ = fs::remove_dir_all(&dir);
    }
}
