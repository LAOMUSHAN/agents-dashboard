//! DSH 会话日志索引器。
//!
//! DSH 没有 SQLite 用量库，只有 `~/.dsh/sessions/<项目>/<会话>/session[.v4].jsonl.zstd`
//! （多帧 zstd、逐帧追加）。本模块把这些日志物化成 zcode 同构的查询表，供统一查询层
//! 通过 ATTACH + UNION VIEW 使用。
//!
//! 运行边界（硬约束）：
//! - 本模块没有任何后台线程、定时器或文件 watcher；只在 `ensure_fresh` 被调用时工作。
//! - 调用方（查询命令）只在 App 运行、窗口可见时调用；App 退出后不留下任何活动。
//! - 只写 `dsh-index.sqlite`；`~/.dsh` 与 zcode 库始终只读。
//!
//! 解析口径：
//! - v0/v4 同一会话两份并存时优先 v4（按目录去重，按会话 id 替换行）。
//! - `input_tokens = inputTokens + cacheReadTokens`（DSH 的 input 不含缓存读）。
//! - 没有 `assistant/message` 的 step 用 `llm/retry` + `turn/end` 合成 error 行。
//! - 逐帧流式解压、逐行解析，不把整个解压文件读进内存。

use crate::error::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 索引库 schema 版本。DSH 数据只是缓存，版本不符时整库重建。
const SCHEMA_VERSION: i64 = 2;
/// 增量刷新单次时间预算；超过就把剩余文件留给下一次刷新。
const DEFAULT_BUDGET_MS: u64 = 250;

pub fn default_sessions_root() -> PathBuf {
    if let Ok(p) = std::env::var("DSH_SESSIONS_PATH") {
        return PathBuf::from(p);
    }
    if let Ok(p) = std::env::var("DSH_HOME") {
        return PathBuf::from(p).join("sessions");
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".dsh/sessions")
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    /// 索引根目录是否存在（不存在时 available=false，查询层按空源处理）
    pub available: bool,
    pub sessions: i64,
    pub requests: i64,
    pub tools: i64,
    pub files: i64,
    pub indexed_at: i64,
    /// 本次刷新实际解析的文件数
    pub parsed_files: i64,
    /// 本次刷新是否走了全量重建
    pub full_rebuild: bool,
    pub last_error: Option<String>,
}

impl IndexStats {
    /// 索引器不可用时的占位状态（查询层仍然可以返回另一个源的数据）。
    pub fn error(message: String) -> Self {
        IndexStats {
            available: false,
            sessions: 0,
            requests: 0,
            tools: 0,
            files: 0,
            indexed_at: 0,
            parsed_files: 0,
            full_rebuild: false,
            last_error: Some(message),
        }
    }
}

/// 一个会话目录里选中的日志文件（v4 优先）。
struct SessionFile {
    dir_key: String,
    path: PathBuf,
    format: &'static str,
    size: u64,
    mtime: i64,
}

struct StoredFile {
    path: PathBuf,
    size: u64,
    mtime: i64,
    session_id: Option<String>,
}

struct Usage {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
}

struct Failure {
    code: String,
    message: String,
}

struct StepAcc {
    start: i64,
    end: Option<i64>,
    message_time: Option<i64>,
    first_chunk: Option<i64>,
    has_message: bool,
    usage: Option<Usage>,
    model: Option<String>,
    provider: Option<String>,
    retries: i64,
    failure: Option<Failure>,
    attempt_failure: Option<Failure>,
}

struct ToolAcc {
    call_id: String,
    name: String,
    start: i64,
    end: Option<i64>,
    is_error: bool,
}

struct ModelRow {
    id: String,
    session_id: String,
    turn: i64,
    step: i64,
    model_id: String,
    provider_id: String,
    agent: String,
    status: String,
    started_at: i64,
    completed_at: Option<i64>,
    duration_ms: Option<i64>,
    ttft_ms: Option<i64>,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    retry_count: i64,
    cancelled_by_user: i64,
    context_exceeded: i64,
    error_type: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
}

struct ToolRow {
    id: String,
    session_id: String,
    call_id: String,
    tool_name: String,
    status: String,
    started_at: i64,
    completed_at: Option<i64>,
    duration_ms: Option<i64>,
}

struct ParsedSession {
    id: String,
    raw_id: String,
    parent_id: Option<String>,
    directory: String,
    title: String,
    task_type: String,
    origin: Option<String>,
    agent: String,
    time_created: i64,
    time_updated: i64,
    rows: Vec<ModelRow>,
    tools: Vec<ToolRow>,
}

pub struct DshIndexer {
    root: PathBuf,
    db_path: PathBuf,
    budget: Duration,
    /// 两次增量之间的最小间隔；运行期由界面刷新触发，避免 5 秒刷新反复扫盘
    min_interval: Duration,
    last_run: Option<Instant>,
    last_error: Option<String>,
}

impl DshIndexer {
    pub fn new(root: PathBuf, db_path: PathBuf) -> Self {
        DshIndexer {
            root,
            db_path,
            budget: Duration::from_millis(DEFAULT_BUDGET_MS),
            min_interval: Duration::from_secs(10),
            last_run: None,
            last_error: None,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// 只在调用时工作：扫描文件、按 (size, mtime) 增量解析。没有后台线程。
    /// `full=true` 时忽略缓存全量重建（首次建库/schema 升级/手动重建）。
    pub fn ensure_fresh(&mut self, full: bool) -> Result<IndexStats, AppError> {
        if !full {
            if let Some(t) = self.last_run {
                if t.elapsed() < self.min_interval {
                    return self.stats();
                }
            }
        }
        // 即使 ~/.dsh 不存在也建空库：查询层需要一个可 attach 的索引库
        let mut conn = self.open()?;
        self.init_schema(&mut conn)?;
        self.last_run = Some(Instant::now());
        if !self.root.exists() {
            let mut stats = self.stats_with(&conn)?;
            stats.available = false;
            return Ok(stats);
        }
        let files = self.scan()?;
        let mut stored = self.load_files(&conn)?;
        // 空索引（首次建库 / schema 升级后）不做时间预算：一次建完，避免首屏只有半个 DSH
        let effective_full = full || stored.is_empty();
        let started = Instant::now();
        let mut parsed_files = 0i64;
        let mut errors: Vec<String> = Vec::new();

        for f in &files {
            let unchanged = stored
                .get(&f.dir_key)
                .map(|s| s.path == f.path && s.size == f.size && s.mtime == f.mtime)
                .unwrap_or(false);
            if unchanged && !effective_full {
                continue;
            }
            if !effective_full && started.elapsed() > self.budget {
                break;
            }
            match self.index_file(&mut conn, f) {
                Ok(()) => parsed_files += 1,
                Err(e) => {
                    let msg = format!("{}: {e}", f.path.display());
                    errors.push(msg.clone());
                    // 保留旧索引，只记错误；下次刷新还会重试（size/mtime 未更新）
                    let _ = conn.execute(
                        "INSERT INTO dsh_files(dir,path,format,size,mtime,session_id,indexed_at,last_error)
                         VALUES(?1,?2,?3,?4,?5,NULL,?6,?7)
                         ON CONFLICT(dir) DO UPDATE SET last_error=excluded.last_error",
                        params![
                            f.dir_key,
                            f.path.to_string_lossy().to_string(),
                            f.format,
                            f.size as i64,
                            f.mtime,
                            now_ms(),
                            msg
                        ],
                    );
                }
            }
        }

        // 清理已消失的会话目录；只删除不在本次扫描里的目录，避免误删 v4 刚接管的数据
        let present: HashSet<String> = files.iter().map(|f| f.dir_key.clone()).collect();
        let gone: Vec<(String, Option<String>)> = stored
            .drain()
            .filter(|(k, _)| !present.contains(k))
            .map(|(k, v)| (k, v.session_id))
            .collect();
        for (dir_key, session_id) in gone {
            if let Some(sid) = session_id {
                delete_session_rows(&mut conn, &sid)?;
            }
            conn.execute("DELETE FROM dsh_files WHERE dir=?1", params![dir_key])?;
        }

        conn.execute(
            "INSERT INTO meta(key,value) VALUES('last_indexed_at',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![now_ms().to_string()],
        )?;
        self.last_error = if errors.is_empty() {
            None
        } else {
            Some(errors.join("；"))
        };
        let mut stats = self.stats_with(&conn)?;
        stats.parsed_files = parsed_files;
        stats.full_rebuild = effective_full;
        Ok(stats)
    }

    pub fn stats(&self) -> Result<IndexStats, AppError> {
        let mut conn = self.open()?;
        self.init_schema(&mut conn)?;
        let mut stats = self.stats_with(&conn)?;
        if !self.root.exists() {
            stats.available = false;
        }
        Ok(stats)
    }

    fn stats_with(&self, conn: &Connection) -> Result<IndexStats, AppError> {
        let sessions: i64 = conn.query_row("SELECT COUNT(*) FROM dsh_session", [], |r| r.get(0))?;
        let requests: i64 = conn.query_row("SELECT COUNT(*) FROM dsh_model_usage", [], |r| r.get(0))?;
        let tools: i64 = conn.query_row("SELECT COUNT(*) FROM dsh_tool_usage", [], |r| r.get(0))?;
        let files: i64 = conn.query_row("SELECT COUNT(*) FROM dsh_files", [], |r| r.get(0))?;
        let indexed_at: i64 = conn
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM meta WHERE key='last_indexed_at'",
                [],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        Ok(IndexStats {
            available: true,
            sessions,
            requests,
            tools,
            files,
            indexed_at,
            parsed_files: 0,
            full_rebuild: false,
            last_error: self.last_error.clone(),
        })
    }

    fn open(&self) -> Result<Connection, AppError> {
        if let Some(dir) = self.db_path.parent() {
            fs::create_dir_all(dir)
                .map_err(|e| AppError::Unavailable(format!("无法创建索引目录 {}: {e}", dir.display())))?;
        }
        let conn = Connection::open(&self.db_path)
            .map_err(|e| AppError::Unavailable(format!("无法打开 DSH 索引库 {}: {e}", self.db_path.display())))?;
        // WAL：读写连接互不阻塞；synchronous=NORMAL 足够（索引可重建）
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;")
            .map_err(|e| AppError::Unavailable(format!("初始化 DSH 索引库失败: {e}")))?;
        Ok(conn)
    }

    fn init_schema(&self, conn: &mut Connection) -> Result<(), AppError> {
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version == SCHEMA_VERSION {
            return Ok(());
        }
        // 索引是缓存：版本不符直接重建，不做迁移
        conn.execute_batch(
            "DROP TABLE IF EXISTS dsh_files;
             DROP TABLE IF EXISTS dsh_session;
             DROP TABLE IF EXISTS dsh_model_usage;
             DROP TABLE IF EXISTS dsh_tool_usage;
             DROP TABLE IF EXISTS meta;",
        )?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS dsh_files (
                dir TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                format TEXT NOT NULL,
                size INTEGER NOT NULL,
                mtime INTEGER NOT NULL,
                session_id TEXT,
                indexed_at INTEGER NOT NULL,
                last_error TEXT
             );
             CREATE TABLE IF NOT EXISTS dsh_session (
                id TEXT PRIMARY KEY,
                raw_id TEXT,
                parent_id TEXT,
                directory TEXT NOT NULL,
                title TEXT,
                task_type TEXT,
                origin TEXT,
                agent TEXT,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS dsh_model_usage (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                turn INTEGER NOT NULL,
                step INTEGER NOT NULL,
                model_id TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                agent TEXT,
                status TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                completed_at INTEGER,
                duration_ms INTEGER,
                time_to_first_token_ms INTEGER,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
                reasoning_tokens INTEGER,
                retry_count INTEGER NOT NULL DEFAULT 0,
                cancelled_by_user INTEGER NOT NULL DEFAULT 0,
                context_exceeded INTEGER NOT NULL DEFAULT 0,
                error_type TEXT,
                error_code TEXT,
                error_message TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_dsh_mu_started ON dsh_model_usage(started_at);
             CREATE INDEX IF NOT EXISTS idx_dsh_mu_session ON dsh_model_usage(session_id);
             CREATE INDEX IF NOT EXISTS idx_dsh_mu_model ON dsh_model_usage(model_id);
             CREATE TABLE IF NOT EXISTS dsh_tool_usage (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                tool_call_id TEXT,
                tool_name TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                completed_at INTEGER,
                duration_ms INTEGER
             );
             CREATE INDEX IF NOT EXISTS idx_dsh_tool_session ON dsh_tool_usage(session_id);",
        )?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(())
    }

    fn scan(&self) -> Result<Vec<SessionFile>, AppError> {
        let mut out = Vec::new();
        let projects = fs::read_dir(&self.root).map_err(|e| {
            AppError::Unavailable(format!("无法读取 DSH 会话目录 {}: {e}", self.root.display()))
        })?;
        for project in projects {
            let project = match project {
                Ok(p) => p,
                Err(_) => continue,
            };
            if !project.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let sessions = match fs::read_dir(project.path()) {
                Ok(s) => s,
                Err(_) => continue,
            };
            for session in sessions {
                let session = match session {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                if !session.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let mut v4: Option<PathBuf> = None;
                let mut v0: Option<PathBuf> = None;
                let entries = match fs::read_dir(session.path()) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !name.starts_with("session") || !name.ends_with(".jsonl.zstd") {
                        continue;
                    }
                    if name.contains(".v4.") {
                        v4 = Some(entry.path());
                    } else {
                        v0 = Some(entry.path());
                    }
                }
                let (path, format) = match (v4, v0) {
                    (Some(p), _) => (p, "v4"),
                    (None, Some(p)) => (p, "v0"),
                    _ => continue,
                };
                let meta = match fs::metadata(&path) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                out.push(SessionFile {
                    dir_key: session.path().to_string_lossy().to_string(),
                    path,
                    format,
                    size: meta.len(),
                    mtime: mtime_ms(&meta),
                });
            }
        }
        out.sort_by(|a, b| a.dir_key.cmp(&b.dir_key));
        Ok(out)
    }

    fn load_files(&self, conn: &Connection) -> Result<HashMap<String, StoredFile>, AppError> {
        let mut stmt = conn.prepare("SELECT dir,path,size,mtime,session_id FROM dsh_files")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                StoredFile {
                    path: PathBuf::from(r.get::<_, String>(1)?),
                    size: r.get::<_, i64>(2)? as u64,
                    mtime: r.get::<_, i64>(3)?,
                    session_id: r.get::<_, Option<String>>(4)?,
                },
            ))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (k, v) = row?;
            map.insert(k, v);
        }
        Ok(map)
    }

    fn index_file(&self, conn: &mut Connection, file: &SessionFile) -> Result<(), AppError> {
        let parsed = parse_session_file(&file.path)?;
        let tx = conn.transaction()?;
        // 同一会话的 v0/v4 可能先后出现：先按 session id 清掉旧行，再整体写入
        tx.execute("DELETE FROM dsh_model_usage WHERE session_id=?1", params![parsed.id])?;
        tx.execute("DELETE FROM dsh_tool_usage WHERE session_id=?1", params![parsed.id])?;
        tx.execute("DELETE FROM dsh_session WHERE id=?1", params![parsed.id])?;
        tx.execute(
            "INSERT OR REPLACE INTO dsh_session
             (id,raw_id,parent_id,directory,title,task_type,origin,agent,time_created,time_updated)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                parsed.id,
                parsed.raw_id,
                parsed.parent_id,
                parsed.directory,
                parsed.title,
                parsed.task_type,
                parsed.origin,
                parsed.agent,
                parsed.time_created,
                parsed.time_updated
            ],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO dsh_model_usage
                 (id,session_id,turn,step,model_id,provider_id,agent,status,started_at,completed_at,
                  duration_ms,time_to_first_token_ms,input_tokens,output_tokens,
                  cache_read_input_tokens,cache_creation_input_tokens,reasoning_tokens,
                  retry_count,cancelled_by_user,context_exceeded,error_type,error_code,error_message)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,NULL,?17,?18,?19,?20,?21,?22)",
            )?;
            for r in &parsed.rows {
                stmt.execute(params![
                    r.id,
                    r.session_id,
                    r.turn,
                    r.step,
                    r.model_id,
                    r.provider_id,
                    r.agent,
                    r.status,
                    r.started_at,
                    r.completed_at,
                    r.duration_ms,
                    r.ttft_ms,
                    r.input,
                    r.output,
                    r.cache_read,
                    r.cache_write,
                    r.retry_count,
                    r.cancelled_by_user,
                    r.context_exceeded,
                    r.error_type,
                    r.error_code,
                    r.error_message
                ])?;
            }
        }
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO dsh_tool_usage
                 (id,session_id,tool_call_id,tool_name,status,started_at,completed_at,duration_ms)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            )?;
            for t in &parsed.tools {
                stmt.execute(params![
                    t.id,
                    t.session_id,
                    t.call_id,
                    t.tool_name,
                    t.status,
                    t.started_at,
                    t.completed_at,
                    t.duration_ms
                ])?;
            }
        }
        tx.execute(
            "INSERT INTO dsh_files(dir,path,format,size,mtime,session_id,indexed_at,last_error)
             VALUES(?1,?2,?3,?4,?5,?6,?7,NULL)
             ON CONFLICT(dir) DO UPDATE SET
                path=excluded.path, format=excluded.format, size=excluded.size, mtime=excluded.mtime,
                session_id=excluded.session_id, indexed_at=excluded.indexed_at, last_error=NULL",
            params![
                file.dir_key,
                file.path.to_string_lossy().to_string(),
                file.format,
                file.size as i64,
                file.mtime,
                parsed.id,
                now_ms()
            ],
        )?;
        tx.commit()?;
        Ok(())
    }
}

fn delete_session_rows(conn: &mut Connection, session_id: &str) -> Result<(), AppError> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM dsh_model_usage WHERE session_id=?1", params![session_id])?;
    tx.execute("DELETE FROM dsh_tool_usage WHERE session_id=?1", params![session_id])?;
    tx.execute("DELETE FROM dsh_session WHERE id=?1", params![session_id])?;
    tx.commit()?;
    Ok(())
}

fn normalize_id(raw: &str) -> String {
    raw.strip_prefix("session-").unwrap_or(raw).to_string()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 解析单个会话日志。流式逐帧解压 + 逐行；尾部未写完的帧只丢弃，不报错。
fn parse_session_file(path: &Path) -> Result<ParsedSession, AppError> {
    let file = fs::File::open(path)
        .map_err(|e| AppError::Unavailable(format!("无法打开 DSH 日志 {}: {e}", path.display())))?;
    let decoder = zstd::stream::read::Decoder::new(BufReader::new(file))
        .map_err(|e| AppError::Unavailable(format!("无法解压 DSH 日志 {}: {e}", path.display())))?;
    let reader = BufReader::new(decoder);

    let mut session_id: Option<String> = None;
    let mut parent_raw: Option<String> = None;
    let mut directory = String::new();
    let mut origin: Option<String> = None;
    let mut created = 0i64;
    let mut last_time = 0i64;
    let mut title: Option<String> = None;
    let mut first_user: Option<String> = None;
    let mut descriptor: Option<String> = None;
    let mut steps: BTreeMap<(i64, i64), StepAcc> = BTreeMap::new();
    let mut tools: HashMap<String, ToolAcc> = HashMap::new();
    let mut turn_reason: HashMap<i64, String> = HashMap::new();
    let mut last_model: Option<String> = None;
    let mut last_provider: Option<String> = None;
    let mut bad_lines = 0usize;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            // 正在写的文件尾部可能是半帧/半行：保留已解析部分
            Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                bad_lines += 1;
                continue;
            }
        };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        let time = v.get("time").and_then(Value::as_i64).unwrap_or(0);
        if time > last_time {
            last_time = time;
        }
        let data = v.get("data");
        match kind {
            "session" => {
                session_id = v.get("id").and_then(Value::as_str).map(normalize_id);
                parent_raw = v.get("parentSession").and_then(Value::as_str).map(normalize_id);
                directory = v.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
                origin = v.get("origin").and_then(Value::as_str).map(|s| s.to_string());
                created = v.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
            }
            "session/title" => {
                if let Some(t) = data.and_then(|d| d.get("title")).and_then(Value::as_str) {
                    if !t.trim().is_empty() {
                        title = Some(t.to_string());
                    }
                }
            }
            "user/message" => {
                if first_user.is_none() {
                    if let Some(text) = data
                        .and_then(|d| d.get("content"))
                        .and_then(Value::as_array)
                        .and_then(|arr| arr.iter().find_map(|c| c.get("text").and_then(Value::as_str)))
                    {
                        first_user = Some(text.to_string());
                    }
                }
            }
            "subagent/descriptor" => {
                if let Some(label) = data.and_then(|d| d.get("label")).and_then(Value::as_str) {
                    descriptor = Some(label.to_string());
                }
            }
            "step/start" => {
                let turn = data.and_then(|d| d.get("turn")).and_then(Value::as_i64).unwrap_or(0);
                let step = data.and_then(|d| d.get("step")).and_then(Value::as_i64).unwrap_or(0);
                steps.entry((turn, step)).or_insert(StepAcc {
                    start: time,
                    end: None,
                    message_time: None,
                    first_chunk: None,
                    has_message: false,
                    usage: None,
                    model: None,
                    provider: None,
                    retries: 0,
                    failure: None,
                    attempt_failure: None,
                });
            }
            "step/end" => {
                let turn = data.and_then(|d| d.get("turn")).and_then(Value::as_i64).unwrap_or(0);
                let step = data.and_then(|d| d.get("step")).and_then(Value::as_i64).unwrap_or(0);
                if let Some(s) = steps.get_mut(&(turn, step)) {
                    if s.end.is_none() {
                        s.end = Some(time);
                    }
                }
            }
            "turn/end" => {
                let turn = data.and_then(|d| d.get("turn")).and_then(Value::as_i64).unwrap_or(0);
                let reason = data
                    .and_then(|d| d.get("reason"))
                    .and_then(|r| r.get("kind"))
                    .and_then(Value::as_str)
                    .unwrap_or("error")
                    .to_string();
                turn_reason.insert(turn, reason);
                for ((t, _), s) in steps.iter_mut() {
                    if *t == turn && s.end.is_none() {
                        s.end = Some(time);
                    }
                }
            }
            "assistant/message" => {
                let turn = data.and_then(|d| d.get("turn")).and_then(Value::as_i64).unwrap_or(0);
                let step = data.and_then(|d| d.get("step")).and_then(Value::as_i64).unwrap_or(0);
                let s = steps.entry((turn, step)).or_insert(StepAcc {
                    start: time,
                    end: None,
                    message_time: None,
                    first_chunk: None,
                    has_message: false,
                    usage: None,
                    model: None,
                    provider: None,
                    retries: 0,
                    failure: None,
                    attempt_failure: None,
                });
                s.message_time = Some(time);
                s.end = Some(time);
                s.has_message = true;
                if let Some(u) = data.and_then(|d| d.get("usage")) {
                    s.usage = Some(Usage {
                        input: u.get("inputTokens").and_then(Value::as_i64).unwrap_or(0),
                        output: u.get("outputTokens").and_then(Value::as_i64).unwrap_or(0),
                        cache_read: u.get("cacheReadTokens").and_then(Value::as_i64).unwrap_or(0),
                        cache_write: u.get("cacheWriteTokens").and_then(Value::as_i64).unwrap_or(0),
                    });
                }
                if let Some(src) = data.and_then(|d| d.get("message")).and_then(|m| m.get("source")) {
                    if let Some(m) = src.get("model").and_then(Value::as_str) {
                        s.model = Some(m.to_string());
                        last_model = Some(m.to_string());
                    }
                    if let Some(p) = src.get("provider").and_then(Value::as_str) {
                        s.provider = Some(p.to_string());
                        last_provider = Some(p.to_string());
                    }
                }
            }
            "assistant/chunk" => {
                let turn = data.and_then(|d| d.get("turn")).and_then(Value::as_i64).unwrap_or(0);
                let step = data.and_then(|d| d.get("step")).and_then(Value::as_i64).unwrap_or(0);
                let chunk = data.and_then(|d| d.get("chunk"));
                let ctype = chunk.and_then(|c| c.get("type")).and_then(Value::as_str).unwrap_or("");
                if let Some(s) = steps.get_mut(&(turn, step)) {
                    if matches!(ctype, "text-delta" | "reasoning-delta" | "tool-call-delta" | "block-start") {
                        s.first_chunk = Some(s.first_chunk.map_or(time, |t| t.min(time)));
                    }
                    if ctype == "finish" {
                        if let Some(f) = chunk
                            .and_then(|c| c.get("reason"))
                            .and_then(|r| r.get("failure"))
                        {
                            s.attempt_failure = Some(Failure {
                                code: f.get("code").and_then(Value::as_str).unwrap_or("ERROR").to_string(),
                                message: f.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
                            });
                        }
                    }
                }
            }
            "text-chunks" | "reasoning-chunks" | "tool-call-chunks" => {
                let turn = data.and_then(|d| d.get("turn")).and_then(Value::as_i64).unwrap_or(0);
                let step = data.and_then(|d| d.get("step")).and_then(Value::as_i64).unwrap_or(0);
                let t0 = v.get("time0").and_then(Value::as_i64);
                if let (Some(t0), Some(s)) = (t0, steps.get_mut(&(turn, step))) {
                    s.first_chunk = Some(s.first_chunk.map_or(t0, |t| t.min(t0)));
                }
            }
            "tool/call" => {
                let call_id = data.and_then(|d| d.get("callId")).and_then(Value::as_str).unwrap_or("");
                if call_id.is_empty() {
                    continue;
                }
                let name = data
                    .and_then(|d| d.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                tools.entry(call_id.to_string()).or_insert(ToolAcc {
                    call_id: call_id.to_string(),
                    name,
                    start: time,
                    end: None,
                    is_error: false,
                });
            }
            "tool/result" => {
                let call_id = data
                    .and_then(|d| d.get("message"))
                    .and_then(|m| m.get("source"))
                    .and_then(|s| s.get("callId"))
                    .and_then(Value::as_str)
                    .or_else(|| {
                        data.and_then(|d| d.get("message"))
                            .and_then(|m| m.get("content"))
                            .and_then(Value::as_array)
                            .and_then(|arr| arr.first())
                            .and_then(|c| c.get("toolCallId"))
                            .and_then(Value::as_str)
                    })
                    .unwrap_or("");
                if let Some(t) = tools.get_mut(call_id) {
                    t.end = Some(time);
                    t.is_error = data
                        .and_then(|d| d.get("message"))
                        .and_then(|m| m.get("content"))
                        .and_then(Value::as_array)
                        .and_then(|arr| arr.first())
                        .and_then(|c| c.get("isError"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                }
            }
            "llm/retry" => {
                let turn = data.and_then(|d| d.get("turn")).and_then(Value::as_i64).unwrap_or(0);
                let step = data.and_then(|d| d.get("step")).and_then(Value::as_i64).unwrap_or(0);
                if let Some(s) = steps.get_mut(&(turn, step)) {
                    s.retries += 1;
                    if let Some(f) = data.and_then(|d| d.get("failure")) {
                        s.failure = Some(Failure {
                            code: f.get("code").and_then(Value::as_str).unwrap_or("ERROR").to_string(),
                            message: f.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
                        });
                    }
                }
            }
            "assistant/attempt" => {
                let turn = data.and_then(|d| d.get("turn")).and_then(Value::as_i64).unwrap_or(0);
                let step = data.and_then(|d| d.get("step")).and_then(Value::as_i64).unwrap_or(0);
                let failure = data
                    .and_then(|d| d.get("stream"))
                    .and_then(Value::as_array)
                    .and_then(|arr| {
                        arr.iter().find_map(|item| {
                            let chunk = item.get("chunk")?;
                            if chunk.get("type").and_then(Value::as_str) != Some("finish") {
                                return None;
                            }
                            let reason = chunk.get("reason")?;
                            if reason.get("kind").and_then(Value::as_str) != Some("error") {
                                return None;
                            }
                            reason.get("failure")
                        })
                    });
                if let (Some(f), Some(s)) = (failure, steps.get_mut(&(turn, step))) {
                    s.attempt_failure = Some(Failure {
                        code: f.get("code").and_then(Value::as_str).unwrap_or("ERROR").to_string(),
                        message: f.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
                    });
                }
            }
            _ => {}
        }
    }

    let raw_id = session_id.ok_or_else(|| {
        AppError::Task(format!("DSH 日志缺少 session 记录: {}", path.display()))
    })?;
    let id = normalize_id(&raw_id);
    if created == 0 {
        created = last_time;
    }
    if last_time == 0 {
        last_time = created;
    }
    let task_type = if origin.as_deref() == Some("subagent") {
        "subagent_child".to_string()
    } else {
        "interactive".to_string()
    };
    let agent = if origin.as_deref() == Some("subagent") {
        "dsh-subagent".to_string()
    } else {
        "dsh".to_string()
    };
    let title = title
        .or_else(|| first_user.map(|t| one_line(&t, 80)))
        .or(descriptor)
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "-".to_string());

    let mut rows = Vec::with_capacity(steps.len());
    for ((turn, step), s) in steps.iter() {
        let status = if s.has_message {
            "completed"
        } else {
            match turn_reason.get(turn).map(String::as_str) {
                Some("aborted") | Some("interrupted") => "cancelled",
                _ => "error",
            }
        };
        let reason = turn_reason.get(turn).map(String::as_str).unwrap_or("");
        let completed_at = s.message_time.or(s.end).or(Some(s.start));
        let duration = completed_at.and_then(|c| if c > s.start { Some(c - s.start) } else { None });
        let ttft = s
            .first_chunk
            .and_then(|c| if c > s.start { Some(c - s.start) } else { None });
        let (input, output, cache_read, cache_write) = match &s.usage {
            Some(u) => (u.input + u.cache_read, u.output, u.cache_read, u.cache_write),
            None => (0, 0, 0, 0),
        };
        let failure = s.failure.as_ref().or(s.attempt_failure.as_ref());
        let (error_type, error_code, error_message) = if status == "completed" {
            (None, None, None)
        } else if let Some(f) = failure {
            (Some(f.code.clone()), Some(f.code.clone()), Some(f.message.clone()))
        } else {
            let code = if reason.is_empty() { "ERROR" } else { reason };
            (Some(code.to_string()), Some(code.to_string()), None)
        };
        let context_exceeded = failure
            .map(|f| {
                let text = format!("{} {}", f.code, f.message).to_ascii_lowercase();
                text.contains("context") || text.contains("too long") || text.contains("max_tokens")
            })
            .unwrap_or(false);
        rows.push(ModelRow {
            id: format!("{id}:{turn}:{step}"),
            session_id: id.clone(),
            turn: *turn,
            step: *step,
            model_id: s
                .model
                .clone()
                .or_else(|| last_model.clone())
                .unwrap_or_else(|| "unknown".to_string()),
            provider_id: s
                .provider
                .clone()
                .or_else(|| last_provider.clone())
                .unwrap_or_else(|| "unknown".to_string()),
            agent: agent.clone(),
            status: status.to_string(),
            started_at: s.start,
            completed_at,
            duration_ms: duration,
            ttft_ms: ttft,
            input,
            output,
            cache_read,
            cache_write,
            retry_count: s.retries,
            cancelled_by_user: i64::from(reason == "aborted"),
            context_exceeded: i64::from(context_exceeded),
            error_type,
            error_code,
            error_message,
        });
    }

    let any_cancelled = turn_reason
        .values()
        .any(|r| r == "aborted" || r == "interrupted");
    let mut tool_rows = Vec::with_capacity(tools.len());
    for t in tools.values() {
        let status = match t.end {
            Some(_) => {
                if t.is_error {
                    "error"
                } else {
                    "completed"
                }
            }
            None => {
                if any_cancelled {
                    "cancelled"
                } else {
                    "error"
                }
            }
        };
        let duration = t.end.and_then(|e| if e > t.start { Some(e - t.start) } else { None });
        tool_rows.push(ToolRow {
            id: format!("{id}:{}", t.call_id),
            session_id: id.clone(),
            call_id: t.call_id.clone(),
            tool_name: t.name.clone(),
            status: status.to_string(),
            started_at: t.start,
            completed_at: t.end,
            duration_ms: duration,
        });
    }

    let _ = bad_lines;
    Ok(ParsedSession {
        id,
        raw_id,
        parent_id: parent_raw,
        directory,
        title,
        task_type,
        origin,
        agent,
        time_created: created,
        time_updated: last_time,
        rows,
        tools: tool_rows,
    })
}

fn one_line(text: &str, max: usize) -> String {
    let flat: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        flat.chars().take(max).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::OptionalExtension;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-index-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn normalizes_session_prefix() {
        assert_eq!(normalize_id("session-abc"), "abc");
        assert_eq!(normalize_id("abc"), "abc");
    }

    #[test]
    fn parses_multiframe_fixture() {
        let dir = temp_dir("fixture");
        let sess = dir.join("sessions").join("proj").join("sess");
        fs::create_dir_all(&sess).unwrap();

        let frame1 = [
            r#"{"type":"session","version":4,"id":"session-abc","createdAt":1000,"cwd":"C:\\proj"}"#,
            r#"{"type":"session/title","time":1001,"data":{"title":"Fixture"}}"#,
            r#"{"type":"step/start","time":1100,"data":{"turn":1,"step":1}}"#,
            r#"{"type":"assistant/chunk","time":1150,"data":{"turn":1,"step":1,"chunk":{"type":"text-delta","text":"hi"}}}"#,
            r#"{"type":"tool/call","time":1200,"data":{"turn":1,"step":1,"callId":"c1","name":"read"}}"#,
        ]
        .join("\n")
            + "\n";
        let frame2 = [
            r#"{"type":"tool/result","time":1300,"data":{"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"c1"},"content":[{"type":"tool-result","toolCallId":"c1","isError":false}]}}}"#,
            r#"{"type":"assistant/message","time":1500,"data":{"turn":1,"step":1,"message":{"source":{"provider":"p","model":"m"}},"usage":{"inputTokens":100,"outputTokens":20,"cacheReadTokens":50,"cacheWriteTokens":5}}}"#,
            r#"{"type":"step/start","time":1600,"data":{"turn":1,"step":2}}"#,
            r#"{"type":"llm/retry","time":1650,"data":{"turn":1,"step":2,"failure":{"code":"RATE_LIMIT","message":"429"}}}"#,
            r#"{"type":"turn/end","time":1700,"data":{"turn":1,"reason":{"kind":"error"}}}"#,
        ]
        .join("\n")
            + "\n";

        let mut bytes = Vec::new();
        bytes.extend(zstd::stream::encode_all(frame1.as_bytes(), 3).unwrap());
        bytes.extend(zstd::stream::encode_all(frame2.as_bytes(), 3).unwrap());
        fs::write(sess.join("session.jsonl.zstd"), bytes).unwrap();

        let mut indexer = DshIndexer::new(dir.join("sessions"), dir.join("index.sqlite"));
        let stats = indexer.ensure_fresh(true).unwrap();
        assert!(stats.available);
        assert_eq!(stats.sessions, 1);
        assert_eq!(stats.requests, 2);
        assert_eq!(stats.tools, 1);

        let conn = Connection::open(dir.join("index.sqlite")).unwrap();
        let (status, input, output, cr, cw, ttft, dur): (String, i64, i64, i64, i64, i64, i64) = conn
            .query_row(
                "SELECT status,input_tokens,output_tokens,cache_read_input_tokens,
                        cache_creation_input_tokens,time_to_first_token_ms,duration_ms
                 FROM dsh_model_usage WHERE turn=1 AND step=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
            .unwrap();
        assert_eq!(status, "completed");
        assert_eq!((input, output, cr, cw), (150, 20, 50, 5));
        assert_eq!(ttft, 50);
        assert_eq!(dur, 400);

        let (status, code, retries): (String, String, i64) = conn
            .query_row(
                "SELECT status,error_code,retry_count FROM dsh_model_usage WHERE turn=1 AND step=2",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "error");
        assert_eq!(code, "RATE_LIMIT");
        assert_eq!(retries, 1);

        let (title, task_type): (String, String) = conn
            .query_row("SELECT title,task_type FROM dsh_session", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(title, "Fixture");
        assert_eq!(task_type, "interactive");

        let (tool_status, tool_dur): (String, i64) = conn
            .query_row("SELECT status,duration_ms FROM dsh_tool_usage", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(tool_status, "completed");
        assert_eq!(tool_dur, 100);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 真实数据对账：token 汇总必须与 DSH 自己的 session_projcache 一致。
    /// 依赖本机 ~/.dsh，CI 上没数据会直接跳过，所以标记 ignored；本机手动跑：
    /// `cargo test -- --ignored reconcile_real_dsh`
    #[test]
    #[ignore]
    fn reconcile_real_dsh() {
        let root = default_sessions_root();
        if !root.exists() {
            eprintln!("skip: {} 不存在", root.display());
            return;
        }
        let dir = temp_dir("real");
        let mut indexer = DshIndexer::new(root.clone(), dir.join("index.sqlite"));
        let stats = indexer.ensure_fresh(true).unwrap();
        assert!(stats.requests > 1000, "requests={}", stats.requests);

        let conn = Connection::open(dir.join("index.sqlite")).unwrap();
        let rows = {
            let mut stmt = conn
                .prepare(
                    "SELECT session_id, SUM(input_tokens), SUM(output_tokens),
                            SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens)
                     FROM dsh_model_usage GROUP BY session_id",
                )
                .unwrap();
            let it = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                })
                .unwrap();
            it.collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };

        let home = dirs::home_dir().unwrap();
        let cache_dir = home.join(".dsh/storages/session_projcache/sessions");
        let mut checked = 0usize;
        for (sid, input, output, cr, cw) in rows {
            // 索引里的 id 去掉了 session- 前缀；projcache 文件名可能带前缀，两种都试
            let raw_id: Option<String> = conn
                .query_row("SELECT raw_id FROM dsh_session WHERE id=?1", [&sid], |r| r.get(0))
                .optional()
                .unwrap();
            let mut text = None;
            // 日志里的 session id 可能是裸 UUID，也可能带 session- 前缀；
            // projcache 文件名则统一是 session-<uuid>。四种组合都试。
            let mut cands = vec![sid.clone(), format!("session-{sid}")];
            if let Some(raw) = raw_id {
                cands.push(raw.clone());
                cands.push(format!("session-{raw}"));
            }
            for cand in cands {
                if let Ok(t) = fs::read_to_string(cache_dir.join(format!("{cand}.json"))) {
                    text = Some(t);
                    break;
                }
            }
            let Some(text) = text else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            let totals = v
                .pointer("/record/rows/tokenUsage/val/totals")
                .cloned()
                .unwrap_or(Value::Null);
            let uncached = totals.get("uncachedInputTokens").and_then(Value::as_i64).unwrap_or(0);
            let out = totals.get("outputTokens").and_then(Value::as_i64).unwrap_or(0);
            let read = totals.get("cacheReadTokens").and_then(Value::as_i64).unwrap_or(0);
            let write = totals.get("cacheWriteTokens").and_then(Value::as_i64).unwrap_or(0);
            assert_eq!(input, uncached + read, "session {sid} input");
            assert_eq!(output, out, "session {sid} output");
            assert_eq!(cr, read, "session {sid} cacheRead");
            assert_eq!(cw, write, "session {sid} cacheWrite");
            checked += 1;
        }
        assert!(checked > 50, "checked={checked}");
        eprintln!(
            "reconciled {checked} sessions, requests={} files={} sessions={} tools={} err={:?}",
            stats.requests, stats.files, stats.sessions, stats.tools, stats.last_error
        );
        eprintln!("db at {}", dir.join("index.sqlite").display());
    }
}
