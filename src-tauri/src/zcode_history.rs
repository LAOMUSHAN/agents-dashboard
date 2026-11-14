//! ZCode 早期用量索引器。
//!
//! `model_usage` 表从 2026-10-12 才有数据；更早的逐请求用量保存在
//! `message.data` 的 assistant 消息里（tokens / modelID / providerID / time），
//! 以及 `part.data` 的 tool 事件里。本模块把这些行物化到索引库，投影成与
//! `zc.model_usage` / `zc.tool_usage` 相同的列，由 `unified.rs` 以 `zc:` 前缀并入 zcode 源。
//!
//! 历史 assistant 的 `tokens.input` 已含缓存读（与实时 `model_usage.input_tokens` 一致），
//! **不再**像 DSH / Claude 那样把 cacheRead 加一次，否则命中部分会被重复计费。
//! 没有首 token 时间，`time_to_first_token_ms` 留 NULL。
//!
//! 首批全量索引约 35 万行，若一次扫完会卡住首屏 40-60 秒，因此按 rowid 分批：
//! 每轮 `ensure_fresh` 处理固定行数，几轮（界面每 5 秒刷新一次）内全部补齐。
//! 期间已有数据立即可查；补完后进入纯增量模式。
//!
//! 运行边界与 dsh.rs / claude.rs 一致：没有后台线程，只在界面刷新触发的
//! `ensure_fresh` 里工作；隐藏到托盘时调用方不扫盘；退出即停。
//! 对 ZCode 库始终只读（URI `mode=ro` + `query_only`），不写回源库。

use crate::error::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: &str = "1";
/// message 每轮处理的源行数窗口。2 万行约 1-2 秒，小于界面 5 秒刷新间隔。
const BATCH_ROWS: i64 = 20_000;
/// part 表行数远大于 message（114 万 vs 33 万），且 tool 行只占一部分，
/// 窗口取大些，让工具行在十几轮内补完而不是五十几轮。
const PART_WINDOW_ROWS: i64 = 100_000;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub available: bool,
    pub requests: i64,
    pub tools: i64,
    pub indexed_at: i64,
    /// 历史索引是否已全部补齐（分批建库完成）
    pub complete: bool,
    pub last_error: Option<String>,
}

impl IndexStats {
    pub fn error(message: String) -> Self {
        IndexStats {
            available: false,
            requests: 0,
            tools: 0,
            indexed_at: 0,
            complete: false,
            last_error: Some(message),
        }
    }
}

pub struct ZcodeHistoryIndexer {
    zcode_path: PathBuf,
    db_path: PathBuf,
    min_interval: Duration,
    last_run: Option<Instant>,
    last_error: Option<String>,
}

/// 一条历史用量行（列契约见 unified.rs 的 MODEL_COLUMNS）。
struct ModelRow {
    id: String,
    session_id: String,
    model_id: String,
    provider_id: String,
    agent: Option<String>,
    started_at: i64,
    duration_ms: Option<i64>,
    input: i64,
    output: i64,
    reasoning: i64,
    cache_read: i64,
    cache_write: i64,
}

struct ToolRow {
    id: String,
    tool_name: String,
    status: String,
    started_at: i64,
    duration_ms: Option<i64>,
}

impl ZcodeHistoryIndexer {
    pub fn new(zcode_path: PathBuf, db_path: PathBuf) -> Self {
        ZcodeHistoryIndexer {
            zcode_path,
            db_path,
            min_interval: Duration::from_secs(2),
            last_run: None,
            last_error: None,
        }
    }

    /// 只在调用时工作：按 rowid 分批读 ZCode 库，写入索引库。没有后台线程。
    /// `full=true` 时清空索引从头重建（schema 升级 / 手动重建）。
    pub fn ensure_fresh(&mut self, full: bool) -> Result<IndexStats, AppError> {
        if !full {
            if let Some(t) = self.last_run {
                if t.elapsed() < self.min_interval {
                    return self.stats();
                }
            }
        }
        let mut conn = self.open()?;
        self.init_schema(&mut conn, full)?;
        self.last_run = Some(Instant::now());
        if !self.zcode_path.exists() {
            let mut stats = self.stats_with(&conn)?;
            stats.available = false;
            return Ok(stats);
        }

        // 实时 model_usage 的起点：只索引早于它的部分，避免与实时行重复。
        let live_start = self.live_usage_start()?.unwrap_or(i64::MAX);
        let msg_wm: i64 = self.meta_i64(&conn, "msg_rowid")?;
        let tool_wm: i64 = self.meta_i64(&conn, "tool_rowid")?;

        let zcode = open_zcode_ro(&self.zcode_path)?;
        // 每轮都从水位往后取一批：rowid 主键让空批次几乎零成本，源库追加的新行
        // （rowid 更大）下一轮会被自然接住，不需要永久的 done 标记。
        let (rows, new_msg_wm, msg_settled) =
            read_message_batch(&zcode, msg_wm, live_start, BATCH_ROWS)?;
        let (tools, new_tool_wm, tool_settled) =
            read_tool_batch(&zcode, tool_wm, live_start, PART_WINDOW_ROWS)?;

        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO zcode_history_model_usage
                 (id,session_id,model_id,provider_id,agent,status,started_at,duration_ms,
                  time_to_first_token_ms,input_tokens,output_tokens,reasoning_tokens,
                  cache_read_input_tokens,cache_creation_input_tokens,
                  retry_count,cancelled_by_user,context_exceeded,
                  error_type,error_code,error_message)
                 VALUES(?1,?2,?3,?4,?5,'completed',?6,?7,NULL,?8,?9,?10,?11,?12,0,0,0,NULL,NULL,NULL)",
            )?;
            for r in &rows {
                stmt.execute(params![
                    r.id, r.session_id, r.model_id, r.provider_id, r.agent, r.started_at,
                    r.duration_ms, r.input, r.output, r.reasoning, r.cache_read, r.cache_write
                ])?;
            }
        }
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO zcode_history_tool_usage
                 (id,tool_name,status,started_at,duration_ms)
                 VALUES(?1,?2,?3,?4,?5)",
            )?;
            for t in &tools {
                stmt.execute(params![
                    t.id, t.tool_name, t.status, t.started_at, t.duration_ms
                ])?;
            }
        }
        for (k, v) in [
            ("msg_rowid", new_msg_wm),
            ("tool_rowid", new_tool_wm),
            // complete = 本轮两个批次都没取满（暂时到末尾）；下一轮仍会继续扫新行。
            ("msg_done", i64::from(msg_settled)),
            ("tool_done", i64::from(tool_settled)),
            ("last_indexed_at", now_ms()),
        ] {
            tx.execute(
                "INSERT INTO zcode_history_meta(key,value) VALUES(?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![k, v.to_string()],
            )?;
        }
        tx.commit()?;
        self.last_error = None;
        self.stats_with(&conn)
    }

    pub fn stats(&self) -> Result<IndexStats, AppError> {
        let mut conn = self.open()?;
        self.init_schema(&mut conn, false)?;
        let mut stats = self.stats_with(&conn)?;
        if !self.zcode_path.exists() {
            stats.available = false;
        }
        Ok(stats)
    }

    /// 测试用：跳过 2 秒节流立即跑一次（生产路径仍走 ensure_fresh）。
    #[cfg(test)]
    pub fn force_refresh(&mut self) -> Result<IndexStats, AppError> {
        self.last_run = None;
        self.ensure_fresh(false)
    }

    /// 测试用：循环跑到分批全量完成。
    #[cfg(test)]
    pub fn ensure_complete(&mut self) -> Result<IndexStats, AppError> {
        for _ in 0..100 {
            let s = self.force_refresh()?;
            if s.complete {
                return Ok(s);
            }
        }
        Err(AppError::Task("分批索引 100 轮仍未完成".to_string()))
    }

    fn stats_with(&self, conn: &Connection) -> Result<IndexStats, AppError> {
        let requests: i64 = conn.query_row(
            "SELECT COUNT(*) FROM zcode_history_model_usage", [], |r| r.get(0),
        )?;
        let tools: i64 = conn.query_row(
            "SELECT COUNT(*) FROM zcode_history_tool_usage", [], |r| r.get(0),
        )?;
        let indexed_at = self.meta_i64(conn, "last_indexed_at")?;
        let complete = self.meta_i64(conn, "msg_done")? != 0
            && self.meta_i64(conn, "tool_done")? != 0;
        Ok(IndexStats {
            available: true,
            requests,
            tools,
            indexed_at,
            complete,
            last_error: self.last_error.clone(),
        })
    }

    fn meta_i64(&self, conn: &Connection, key: &str) -> Result<i64, AppError> {
        Ok(conn
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM zcode_history_meta WHERE key=?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    fn open(&self) -> Result<Connection, AppError> {
        if let Some(dir) = self.db_path.parent() {
            fs::create_dir_all(dir).map_err(|e| {
                AppError::Unavailable(format!("无法创建索引目录 {}: {e}", dir.display()))
            })?;
        }
        let conn = Connection::open(&self.db_path).map_err(|e| {
            AppError::Unavailable(format!("无法打开索引库 {}: {e}", self.db_path.display()))
        })?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;",
        )
        .map_err(|e| AppError::Unavailable(format!("初始化索引库失败: {e}")))?;
        Ok(conn)
    }

    fn init_schema(&self, conn: &mut Connection, full: bool) -> Result<(), AppError> {
        ensure_meta(conn)?;
        ensure_tables(conn)?; // 必须先建表，下面的 DELETE / DROP 才能执行
        let version: Option<String> = conn
            .query_row(
                "SELECT value FROM zcode_history_meta WHERE key='schema_version'",
                [], |r| r.get(0),
            )
            .optional()?;
        if version.as_deref() != Some(SCHEMA_VERSION) || full {
            conn.execute_batch(
                "DELETE FROM zcode_history_model_usage;
                 DELETE FROM zcode_history_tool_usage;
                 DELETE FROM zcode_history_meta WHERE key IN
                   ('msg_rowid','tool_rowid','msg_done','tool_done','last_indexed_at');",
            )?;
        }
        conn.execute(
            "INSERT INTO zcode_history_meta(key,value) VALUES('schema_version',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![SCHEMA_VERSION],
        )?;
        Ok(())
    }

    /// ZCode 实时表最早的 started_at；历史索引只补它之前的部分。
    fn live_usage_start(&self) -> Result<Option<i64>, AppError> {
        let conn = open_zcode_ro(&self.zcode_path)?;
        let min = conn
            .query_row("SELECT MIN(started_at) FROM model_usage", [], |r| {
                r.get::<_, Option<i64>>(0)
            })
            .optional()?
            .flatten();
        Ok(min)
    }
}

/// 按 rowid 分批读 message 的 assistant 用量行。
/// 字段在 SQL 侧用 json_extract 提取成紧凑列：实测取 `data` 原文到 Rust 解析要 20s/15 万行，
/// 而紧凑列只要 10s 量级且分批量更小。
fn read_message_batch(
    conn: &Connection,
    after_rowid: i64,
    before: i64,
    limit: i64,
) -> Result<(Vec<ModelRow>, i64, bool), AppError> {
    let window_end = after_rowid.saturating_add(limit);
    let mut stmt = conn
        .prepare(
            "SELECT rowid, id, session_id, time_created,
                    json_extract(data,'$.tokens.input'),
                    json_extract(data,'$.tokens.output'),
                    json_extract(data,'$.tokens.reasoning'),
                    json_extract(data,'$.tokens.cache.read'),
                    json_extract(data,'$.tokens.cache.write'),
                    json_extract(data,'$.time.created'),
                    json_extract(data,'$.time.completed'),
                    COALESCE(json_extract(data,'$.modelID'), json_extract(data,'$.modelId')),
                    COALESCE(json_extract(data,'$.providerID'), json_extract(data,'$.providerId')),
                    COALESCE(json_extract(data,'$.agent'), json_extract(data,'$.mode'))
             FROM message
             WHERE rowid > ?1 AND rowid <= ?2 AND time_created < ?3
               AND json_extract(data,'$.role') = 'assistant'
               AND json_extract(data,'$.tokens.input') IS NOT NULL
             ORDER BY rowid",
        )
        .map_err(|e| AppError::Unavailable(format!("准备历史消息查询失败: {e}")))?;
    let mut q = stmt.query(params![after_rowid, window_end, before])?;
    let mut rows = Vec::new();
    while let Some(r) = q.next()? {
        let id: String = r.get(1)?;
        let session_id: String = r.get(2)?;
        let time_created: i64 = r.get(3)?;
        let created: i64 = r.get::<_, Option<i64>>(9)?.unwrap_or(time_created);
        let completed: Option<i64> = r.get(10)?;
        let duration = completed.and_then(|c| if c > created { Some(c - created) } else { None });
        rows.push(ModelRow {
            id: format!("zh:{id}"),
            session_id,
            model_id: r.get::<_, Option<String>>(11)?.unwrap_or_else(|| "unknown".to_string()),
            provider_id: r.get::<_, Option<String>>(12)?.unwrap_or_else(|| "unknown".to_string()),
            agent: r.get(13)?,
            started_at: time_created,
            duration_ms: duration,
            input: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
            output: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
            reasoning: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
            cache_read: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
            cache_write: r.get::<_, Option<i64>>(8)?.unwrap_or(0),
        });
    }
    let more: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM message WHERE rowid > ?1 AND time_created < ?2)",
            params![window_end, before],
            |r| r.get(0),
        )
        .unwrap_or(false);
    Ok((rows, window_end, !more))
}

/// 按 rowid 窗口分批读 part 的 tool 行。
/// 用 `rowid BETWEEN` 切窗口而不是「取够 N 条 tool 行」：后者为了凑数要扫过大量
/// 非 tool 的 part 行，每轮都可能扫完整张 114 万行表。窗口只扫固定行数。
fn read_tool_batch(
    conn: &Connection,
    after_rowid: i64,
    before: i64,
    limit: i64,
) -> Result<(Vec<ToolRow>, i64, bool), AppError> {
    let window_end = after_rowid.saturating_add(limit);
    let mut stmt = conn
        .prepare(
            "SELECT rowid, id, time_created,
                    COALESCE(json_extract(data,'$.tool'), 'unknown'),
                    json_extract(data,'$.state.status'),
                    json_extract(data,'$.state.time.start'),
                    json_extract(data,'$.state.time.end')
             FROM part
             WHERE rowid > ?1 AND rowid <= ?2 AND time_created < ?3
               AND json_extract(data,'$.type') = 'tool'
             ORDER BY rowid",
        )
        .map_err(|e| AppError::Unavailable(format!("准备历史工具查询失败: {e}")))?;
    let mut q = stmt.query(params![after_rowid, window_end, before])?;
    let mut rows = Vec::new();
    while let Some(r) = q.next()? {
        let part_id: String = r.get(1)?;
        let time_created: i64 = r.get(2)?;
        let status = match r.get::<_, Option<String>>(4)?.as_deref().unwrap_or("completed") {
            "error" | "failed" => "error",
            "cancelled" => "cancelled",
            _ => "completed",
        }
        .to_string();
        let start: Option<i64> = r.get(5)?;
        let end: Option<i64> = r.get(6)?;
        let duration = end.zip(start).and_then(|(e, s)| if e > s { Some(e - s) } else { None });
        rows.push(ToolRow {
            id: format!("zh:tool:{part_id}"),
            tool_name: r.get::<_, Option<String>>(3)?.unwrap_or_else(|| "unknown".to_string()),
            status,
            started_at: time_created,
            duration_ms: duration,
        });
    }
    // 是否到末尾：查一下窗口之后还有没有任意一行（走 rowid 主键，几乎零成本）
    let more: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM part WHERE rowid > ?1 AND time_created < ?2)",
            params![window_end, before],
            |r| r.get(0),
        )
        .unwrap_or(false);
    Ok((rows, window_end, !more))
}

fn open_zcode_ro(path: &Path) -> Result<Connection, AppError> {
    let uri = format!("file:{}?mode=ro", path_for_uri(path));
    let conn = Connection::open(uri)
        .or_else(|_| Connection::open(path))
        .map_err(|e| AppError::Unavailable(format!("无法只读打开 ZCode 库: {e}")))?;
    conn.execute_batch("PRAGMA query_only=ON;")?;
    Ok(conn)
}

fn ensure_meta(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS zcode_history_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );",
    )?;
    Ok(())
}

/// 查询层在建立 TEMP VIEW 前调用；即使从没跑过索引，也要保证表结构可查询。
pub fn ensure_tables(conn: &Connection) -> Result<(), AppError> {
    ensure_meta(conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS zcode_history_model_usage (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            model_id TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            agent TEXT,
            status TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            duration_ms INTEGER,
            time_to_first_token_ms INTEGER,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            reasoning_tokens INTEGER,
            cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
            cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
            retry_count INTEGER NOT NULL DEFAULT 0,
            cancelled_by_user INTEGER NOT NULL DEFAULT 0,
            context_exceeded INTEGER NOT NULL DEFAULT 0,
            error_type TEXT,
            error_code TEXT,
            error_message TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_zh_mu_started ON zcode_history_model_usage(started_at);
         CREATE INDEX IF NOT EXISTS idx_zh_mu_session ON zcode_history_model_usage(session_id);
         CREATE INDEX IF NOT EXISTS idx_zh_mu_model ON zcode_history_model_usage(model_id);
         CREATE TABLE IF NOT EXISTS zcode_history_tool_usage (
            id TEXT PRIMARY KEY,
            tool_name TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            duration_ms INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_zh_tool_started ON zcode_history_tool_usage(started_at);",
    )?;
    Ok(())
}

fn path_for_uri(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace('?', "%3f")
        .replace('#', "%23")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::SourceFilter;
    use crate::unified;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("zh-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 造一个最小 ZCode 库：session / message / part / model_usage。
    fn make_zcode(path: &Path, live_start: i64) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, task_type TEXT);
             CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
             CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
             CREATE TABLE model_usage(id TEXT PRIMARY KEY, session_id TEXT, model_id TEXT, provider_id TEXT, agent TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER, time_to_first_token_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, retry_count INTEGER, cancelled_by_user INTEGER, context_exceeded INTEGER, error_type TEXT, error_code TEXT, error_message TEXT);
             CREATE TABLE tool_usage(tool_name TEXT, status TEXT, started_at INTEGER, duration_ms INTEGER);
             INSERT INTO session VALUES('s1', NULL, 'C:\\proj', '早期会话', 'interactive');
             INSERT INTO model_usage VALUES('live1','s1','m-live','p1','zcode-agent','completed',
                20000,100,10,100,20,0,30,0,0,0,0,NULL,NULL,NULL);",
        )
        .unwrap();
        let msg = |t: i64, model: &str| {
            format!(
                r#"{{"role":"assistant","time":{{"created":{t},"completed":{cp}}},"modelID":"{model}","providerID":"prov-1","agent":"zcode-agent","cost":0,"tokens":{{"total":12696,"input":1200,"output":30,"reasoning":5,"cache":{{"read":1000,"write":2}}}},"finish":"stop"}}"#,
                t = t,
                cp = t + 250,
                model = model
            )
        };
        for (id, t, model) in [
            ("m1", 1000i64, "gpt-5.6-luna"),
            ("m2", 2000i64, "deepseek-v4-flash"),
            ("m3", live_start + 1000, "m-live"),
        ] {
            conn.execute(
                "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?1,'s1',?2,?2,?3)",
                params![id, t, msg(t, model)],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES('p1','m1','s1',1000,1000,?1)",
            params![r#"{"type":"tool","callID":"c1","tool":"Bash","state":{"status":"completed","time":{"start":1000,"end":1200}}}"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES('p2','m2','s1',2000,2000,?1)",
            params![r#"{"type":"step-finish","reason":"stop","cost":0,"tokens":{"total":1200,"input":1200,"output":0}}"#],
        )
        .unwrap();
    }

    #[test]
    fn indexes_history_and_unifies_into_zcode() {
        let dir = temp_dir("unify");
        let zcode = dir.join("db.sqlite");
        let index = dir.join("index.sqlite");
        make_zcode(&zcode, 20_000);

        let mut indexer = ZcodeHistoryIndexer::new(zcode.clone(), index.clone());
        let stats = indexer.ensure_complete().unwrap();
        assert!(stats.available);
        assert!(stats.complete);
        // 两条历史（1000/2000），实时起点 20000 之后那条跳过
        assert_eq!(stats.requests, 2);
        assert_eq!(stats.tools, 1);

        let conn = Connection::open(&index).unwrap();
        let (input, output, cr, cw, reasoning, ttft, dur, status): (
            i64, i64, i64, i64, i64, Option<i64>, Option<i64>, String,
        ) = conn
            .query_row(
                "SELECT input_tokens,output_tokens,cache_read_input_tokens,
                        cache_creation_input_tokens,reasoning_tokens,time_to_first_token_ms,
                        duration_ms,status FROM zcode_history_model_usage ORDER BY started_at LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
            )
            .unwrap();
        assert_eq!((input, output, cr, cw, reasoning), (1200, 30, 1000, 2, 5));
        assert_eq!(ttft, None, "历史数据没有首 token 时间");
        assert_eq!(dur, Some(250));
        assert_eq!(status, "completed");
        drop(conn);

        // 统一视图：历史行并入 zcode 源，且 session 复用 zc.session
        let q = unified::open_query(&index, &zcode, SourceFilter::Zcode).unwrap();
        let (count, source): (i64, String) = q
            .query_row("SELECT COUNT(*), MIN(source) FROM model_usage", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(count, 3, "2 条历史 + 1 条实时");
        assert_eq!(source, "zcode");
        let ids: Vec<String> = q
            .prepare("SELECT id FROM model_usage ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(ids.iter().any(|s| s.starts_with("zh:")), "ids={ids:?}");
        let joined: i64 = q
            .query_row(
                "SELECT COUNT(*) FROM model_usage mu JOIN session s ON s.id=mu.session_id",
                [], |r| r.get(0),
            )
            .unwrap();
        assert_eq!(joined, 3, "INNER JOIN session 不能丢历史行");

        // 再插一条水位之后、实时起点之前的历史消息，增量应接住。
        // 显式给大 rowid：rowid 水位方案只接住「窗口之后追加」的行（真实库自增即如此）。
        let zc = Connection::open(&zcode).unwrap();
        zc.execute(
            "INSERT INTO message(rowid,id,session_id,time_created,time_updated,data)
             VALUES(20001,'m0','s1',15000,15000,?1)",
            params![r#"{"role":"assistant","time":{"created":15000,"completed":15100},"modelID":"old","providerID":"prov-1","tokens":{"input":10,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}"#],
        )
        .unwrap();
        drop(zc);
        let stats3 = indexer.force_refresh().unwrap();
        assert_eq!(stats3.requests, 3, "增量应补上新行");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 真实库冒烟测试：本机 ZCode 库 2026-10-12 之前应有 8/9/10 月的历史用量。
    /// 只写临时索引库，不碰真实 ZCode 库与真实 Dashboard 索引库。
    #[test]
    #[ignore]
    fn real_zcode_history_smoke() {
        let dir = temp_dir("real");
        let index = dir.join("index.sqlite");
        let zcode = crate::sources::zcode_db_path();
        let mut indexer = ZcodeHistoryIndexer::new(zcode.clone(), index.clone());
        let t0 = std::time::Instant::now();
        let mut rounds = 0;
        let stats = loop {
            rounds += 1;
            let s = indexer.force_refresh().unwrap();
            eprintln!("  第 {} 轮: requests={} tools={} complete={} 累计 {:?}",
                rounds, s.requests, s.tools, s.complete, t0.elapsed());
            if s.complete || rounds > 100 { break s; }
        };
        eprintln!("real history: available={} requests={} tools={} complete={} err={:?} 总耗时 {:?}",
            stats.available, stats.requests, stats.tools, stats.complete, stats.last_error, t0.elapsed());
        assert!(stats.available);
        assert!(stats.complete);
        assert!(stats.requests > 100_000, "requests={}", stats.requests);

        let conn = Connection::open(&index).unwrap();
        let months: Vec<(String, i64, i64, i64)> = conn
            .prepare(
                "SELECT strftime('%Y-%m',started_at/1000,'unixepoch','localtime') m,
                        COUNT(*), SUM(input_tokens), SUM(output_tokens)
                 FROM zcode_history_model_usage GROUP BY m ORDER BY m",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for m in &months {
            eprintln!("  {}: {} 行, input={} output={}", m.0, m.1, m.2, m.3);
        }
        assert!(months.iter().any(|m| m.0.starts_with("2026-08")), "8 月应在索引里: {months:?}");
        assert!(months.iter().any(|m| m.0.starts_with("2026-09")), "9 月应在索引里: {months:?}");

        let q = unified::open_query(&index, &zcode, SourceFilter::Zcode).unwrap();
        let (n, min_m): (i64, String) = q
            .query_row(
                "SELECT COUNT(*), strftime('%Y-%m',MIN(started_at)/1000,'unixepoch','localtime') FROM model_usage",
                [], |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        eprintln!("  统一视图 zcode 源行数: {n}, 最早月份 {min_m}");
        assert!(n > 100_000, "n={n}");
        assert_eq!(min_m, "2026-07");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 真实三源集成验收：在生产索引库副本上，补齐 ZCode 历史 + 自愈 DSH 孤儿，
    /// 再用 unified::open_query(All) 验证三个来源的历史数据都能查到。
    #[test]
    #[ignore]
    fn real_three_source_integration() {
        let src = crate::sources::dsh_index_path(
            &dirs::config_dir().unwrap().join("io.github.laomushan.agents-dashboard"),
        );
        let dir = temp_dir("three-source");
        let index = dir.join("index.sqlite");
        fs::copy(&src, &index).unwrap();
        let zcode = crate::sources::zcode_db_path();

        // 1) ZCode 历史索引用新代码在副本上分批建齐
        let mut zh = ZcodeHistoryIndexer::new(zcode.clone(), index.clone());
        let zh_stats = zh.ensure_complete().unwrap();
        assert!(zh_stats.complete, "ZCode 历史索引应补完");
        eprintln!("ZCode 历史: requests={} tools={}", zh_stats.requests, zh_stats.tools);

        // 2) DSH 孤儿自愈（同一副本，同一新代码）
        let mut dsh = crate::dsh::DshIndexer::new(
            crate::dsh::default_sessions_root(), index.clone(),
        );
        let dsh_stats = dsh.force_refresh().unwrap();
        eprintln!("DSH: sessions={} requests={} parsed={}", dsh_stats.sessions, dsh_stats.requests, dsh_stats.parsed_files);

        // 3) unified 全部来源：按 source 分组看时间跨度
        let q = unified::open_query(&index, &zcode, SourceFilter::All).unwrap();
        let mut stmt = q
            .prepare(
                "SELECT mu.source,
                        strftime('%Y-%m',MIN(mu.started_at)/1000,'unixepoch','localtime') mn,
                        strftime('%Y-%m',MAX(mu.started_at)/1000,'unixepoch','localtime') mx,
                        COUNT(*), SUM(mu.input_tokens + mu.output_tokens)
                 FROM model_usage mu GROUP BY mu.source ORDER BY mu.source",
            )
            .unwrap();
        let rows: Vec<(String, String, String, i64, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for (s, mn, mx, n, tok) in &rows {
            eprintln!("  {s:<8} {mn} ~ {mx}  {n} 行  tokens={tok}");
        }
        assert_eq!(rows.len(), 3, "应有 zcode / dsh / claude 三源: {rows:?}");
        let zc = rows.iter().find(|r| r.0 == "zcode").expect("zcode 源");
        assert_eq!(zc.1, "2026-07", "zcode 源最早应到 2026-07: {zc:?}");
        assert!(zc.3 > 200_000, "zcode 源应含实时 + 历史: {zc:?}");
        let dsh = rows.iter().find(|r| r.0 == "dsh").expect("dsh 源");
        assert!(dsh.1.as_str() <= "2026-08", "DSH 源应含 8 月: {dsh:?}");
        let claude = rows.iter().find(|r| r.0 == "claude").expect("claude 源");
        assert_eq!(claude.1, "2026-06", "Claude 源应含 6 月: {claude:?}");

        // 4) 逐月 token：验证 8/9 月确实有 ZCode 历史数据
        let mut stmt = q
            .prepare(
                "SELECT strftime('%Y-%m',started_at/1000,'unixepoch','localtime') m,
                        COUNT(*), SUM(input_tokens + output_tokens)
                 FROM model_usage WHERE source='zcode' GROUP BY m ORDER BY m",
            )
            .unwrap();
        let months: Vec<(String, i64, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for m in &months {
            eprintln!("  zcode {}: {} 行, tokens={}", m.0, m.1, m.2);
        }
        assert!(months.iter().any(|m| m.0 == "2026-08" && m.1 > 20_000), "8 月应有历史: {months:?}");
        assert!(months.iter().any(|m| m.0 == "2026-09" && m.1 > 80_000), "9 月应有历史: {months:?}");

        let _ = fs::remove_dir_all(&dir);
    }
}
