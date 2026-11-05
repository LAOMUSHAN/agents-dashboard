//! Claude Code 会话日志索引器。
//!
//! 数据源只有 `~/.claude/projects/**/*.jsonl`：不读、不写 Claude Code 的任何配置，
//! 不注册 statusline / OTel / 代理，也不需要用户改 settings.json。
//!
//! 运行边界与 `dsh.rs` 一致：
//! - 没有后台线程、定时器或文件 watcher；只在 `ensure_fresh` 被调用时工作。
//! - 调用方（查询命令）只在 App 运行、窗口可见时调用；App 退出后不再读盘。
//!
//! 解析口径：
//! - 2.1.3xx 的 transcript 有 `api-request`（请求开始）与 assistant 的 `requestRef`，
//!   完成时间取同一 request 的**最后**一条 assistant 块；首 token 用
//!   `首块 timestamp − thinkingDurationMs` 反推，只有首块是 thinking 时才成立。
//! - 老版本没有 `api-request`，退回上一条 user/tool_result 的时间作为起点，UI 仍可看总速度。
//! - `input_tokens = input_tokens + cache_read_input_tokens`：Claude 的 input 不含缓存读，
//!   而查询层/计价的 input 是「含缓存命中的总 prompt」，与 DSH 的映射一致。
//! - 同一 `message.id + requestId` 可能被 `--resume`/fork 复制到多个会话，按 usage 取最大、
//!   保留首次出现的 session 归属，避免重复计数。
//! - `subagents/**/agent-*.jsonl` 是独立文件，session 行带 `parent_id`，
//!   请求日志按父会话分组。

use crate::error::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: &str = "2";
const DEFAULT_BUDGET_MS: u64 = 250;

pub fn default_projects_root() -> PathBuf {
    if let Ok(p) = std::env::var("CLAUDE_PROJECTS_PATH") {
        return PathBuf::from(p);
    }
    if let Ok(p) = std::env::var("CLAUDE_CONFIG_DIR") {
        // Claude Code 允许逗号分隔多个配置目录；索引第一个，和 ccusage 的默认行为一致
        if let Some(first) = p.split(',').map(str::trim).find(|s| !s.is_empty()) {
            return PathBuf::from(first).join("projects");
        }
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude/projects")
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub available: bool,
    pub sessions: i64,
    pub requests: i64,
    pub tools: i64,
    pub files: i64,
    pub indexed_at: i64,
    pub parsed_files: i64,
    pub full_rebuild: bool,
    pub last_error: Option<String>,
}

impl IndexStats {
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

struct ClaudeFile {
    path: PathBuf,
    session_key: String,
    parent_id: Option<String>,
    is_subagent: bool,
    agent_hint: String,
    size: u64,
    mtime: i64,
}

struct StoredFile {
    size: u64,
    mtime: i64,
    offset: i64,
    tail: String,
    session_id: Option<String>,
    last_event_at: i64,
}

struct ExistingRow {
    session_id: String,
    started_at: i64,
    completed_at: Option<i64>,
    ttft_ms: Option<i64>,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    reasoning: Option<i64>,
    first_block_at: i64,
    first_block_thinking: bool,
    first_block_thinking_ms: i64,
    model_id: String,
    request_ref: Option<String>,
    message_id: Option<String>,
    cache_5m: Option<i64>,
    cache_1h: Option<i64>,
    agent: Option<String>,
}

struct ModelInput<'a> {
    id: &'a str,
    session_id: &'a str,
    model: &'a str,
    agent: Option<&'a str>,
    started_at: i64,
    completed_at: i64,
    is_first_block: bool,
    has_thinking: bool,
    thinking_duration: Option<i64>,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    reasoning: Option<i64>,
    cache_5m: Option<i64>,
    cache_1h: Option<i64>,
    request_ref: Option<&'a str>,
    message_id: &'a str,
}

#[derive(Default)]
struct SessionAcc {
    seen: bool,
    raw_id: Option<String>,
    directory: String,
    title: Option<String>,
    origin: Option<String>,
    agent: Option<String>,
    time_created: i64,
    time_updated: i64,
    error_count: i64,
    total_cost_usd: Option<f64>,
    total_api_duration_ms: Option<i64>,
    last_event_at: i64,
}

struct ParseState<'a> {
    file: &'a ClaudeFile,
    acc: SessionAcc,
    api_starts: HashMap<String, i64>,
}

pub struct ClaudeIndexer {
    root: PathBuf,
    db_path: PathBuf,
    budget: Duration,
    min_interval: Duration,
    last_run: Option<Instant>,
    last_error: Option<String>,
}

impl ClaudeIndexer {
    pub fn new(root: PathBuf, db_path: PathBuf) -> Self {
        ClaudeIndexer {
            root,
            db_path,
            budget: Duration::from_millis(DEFAULT_BUDGET_MS),
            min_interval: Duration::from_secs(2),
            last_run: None,
            last_error: None,
        }
    }

    #[allow(dead_code)]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 只在调用时工作：扫描文件、按 (size, mtime, tail) 增量解析。没有后台线程。
    pub fn ensure_fresh(&mut self, full: bool) -> Result<IndexStats, AppError> {
        if !full {
            if let Some(t) = self.last_run {
                if t.elapsed() < self.min_interval {
                    return self.stats();
                }
            }
        }
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
        // 空索引（首次建库 / schema 升级后）一次建完，避免首屏只有半个 Claude
        let effective_full = full || stored.is_empty();
        let started = Instant::now();
        let mut parsed_files = 0i64;
        let mut errors: Vec<String> = Vec::new();

        for f in &files {
            let path_key = f.path.to_string_lossy().to_string();
            let unchanged = stored
                .get(&path_key)
                .map(|s| s.size == f.size && s.mtime == f.mtime)
                .unwrap_or(false);
            if unchanged && !effective_full {
                continue;
            }
            if !effective_full && started.elapsed() > self.budget {
                break;
            }
            match self.index_file(&mut conn, f, stored.get(&path_key)) {
                Ok(()) => parsed_files += 1,
                Err(e) => errors.push(format!("{}: {e}", f.path.display())),
            }
        }

        // 文件被删除/改名：清掉它名下的会话行
        let present: HashSet<String> = files
            .iter()
            .map(|f| f.path.to_string_lossy().to_string())
            .collect();
        let gone: Vec<(String, Option<String>)> = stored
            .drain()
            .filter(|(k, _)| !present.contains(k))
            .map(|(k, v)| (k, v.session_id))
            .collect();
        for (path, session_id) in gone {
            if let Some(sid) = session_id {
                delete_session_rows(&conn, &sid)?;
            }
            conn.execute("DELETE FROM claude_files WHERE path=?1", params![path])?;
        }

        conn.execute(
            "INSERT INTO claude_meta(key,value) VALUES('last_indexed_at',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![now_ms().to_string()],
        )?;
        self.last_error = if errors.is_empty() { None } else { Some(errors.join("；")) };
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
        let sessions: i64 = conn.query_row("SELECT COUNT(*) FROM claude_session", [], |r| r.get(0))?;
        let requests: i64 = conn.query_row("SELECT COUNT(*) FROM claude_model_usage", [], |r| r.get(0))?;
        let tools: i64 = conn.query_row("SELECT COUNT(*) FROM claude_tool_usage", [], |r| r.get(0))?;
        let files: i64 = conn.query_row("SELECT COUNT(*) FROM claude_files", [], |r| r.get(0))?;
        let indexed_at: i64 = conn
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM claude_meta WHERE key='last_indexed_at'",
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
            .map_err(|e| AppError::Unavailable(format!("无法打开索引库 {}: {e}", self.db_path.display())))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;")
            .map_err(|e| AppError::Unavailable(format!("初始化索引库失败: {e}")))?;
        Ok(conn)
    }

    fn init_schema(&self, conn: &mut Connection) -> Result<(), AppError> {
        ensure_meta(conn)?;
        let version: Option<String> = conn
            .query_row("SELECT value FROM claude_meta WHERE key='schema_version'", [], |r| r.get(0))
            .optional()?;
        if version.as_deref() != Some(SCHEMA_VERSION) {
            conn.execute_batch(
                "DROP TABLE IF EXISTS claude_files;
                 DROP TABLE IF EXISTS claude_session;
                 DROP TABLE IF EXISTS claude_model_usage;
                 DROP TABLE IF EXISTS claude_tool_usage;
                 DROP TABLE IF EXISTS claude_api_request;",
            )?;
        }
        ensure_tables(conn)?;
        conn.execute(
            "INSERT INTO claude_meta(key,value) VALUES('schema_version',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![SCHEMA_VERSION],
        )?;
        Ok(())
    }

    fn scan(&self) -> Result<Vec<ClaudeFile>, AppError> {
        let mut paths = Vec::new();
        walk_jsonl(&self.root, &mut paths);
        paths.sort();
        let mut out = Vec::with_capacity(paths.len());
        for path in paths {
            let Some((session_key, parent_id, is_subagent, agent_hint)) = session_key(&self.root, &path)
            else {
                continue;
            };
            let meta = match fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            out.push(ClaudeFile {
                path,
                session_key,
                parent_id,
                is_subagent,
                agent_hint,
                size: meta.len(),
                mtime: mtime_ms(&meta),
            });
        }
        Ok(out)
    }

    fn load_files(&self, conn: &Connection) -> Result<HashMap<String, StoredFile>, AppError> {
        let mut stmt = conn.prepare(
            "SELECT path,size,mtime,offset,tail,session_id,last_event_at FROM claude_files",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                StoredFile {
                    size: r.get::<_, i64>(1)? as u64,
                    mtime: r.get::<_, i64>(2)?,
                    offset: r.get::<_, i64>(3)?,
                    tail: r.get::<_, String>(4)?,
                    session_id: r.get::<_, Option<String>>(5)?,
                    last_event_at: r.get::<_, i64>(6)?,
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

    fn index_file(
        &self,
        conn: &mut Connection,
        file: &ClaudeFile,
        stored: Option<&StoredFile>,
    ) -> Result<(), AppError> {
        // 文件变短或已消费前缀的尾部指纹变了，说明被重写/截断，整文件重建
        let rebuild = match stored {
            None => true,
            Some(s) => s.size > file.size || !tail_matches(&file.path, s.offset, &s.tail),
        };
        let start_offset = if rebuild { 0 } else { stored.map(|s| s.offset).unwrap_or(0) };
        let last_event_at = stored.map(|s| s.last_event_at).unwrap_or(0);

        let tx = conn.transaction()?;
        if rebuild {
            delete_session_rows(&tx, &file.session_key)?;
            tx.execute("DELETE FROM claude_api_request WHERE session_id=?1", params![file.session_key])?;
        }

        let mut state = ParseState {
            file,
            acc: SessionAcc {
                last_event_at,
                ..Default::default()
            },
            api_starts: HashMap::new(),
        };

        let mut handle = File::open(&file.path)
            .map_err(|e| AppError::Unavailable(format!("无法打开 Claude 日志 {}: {e}", file.path.display())))?;
        handle
            .seek(SeekFrom::Start(start_offset as u64))
            .map_err(|e| AppError::Unavailable(format!("无法定位 Claude 日志 {}: {e}", file.path.display())))?;
        let mut reader = BufReader::new(handle);
        let mut pos = start_offset;
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader
                .read_line(&mut line)
                .map_err(|e| AppError::Unavailable(format!("读取 Claude 日志 {}: {e}", file.path.display())))?;
            if n == 0 {
                break;
            }
            // 尾部半行留到下次刷新再读，offset 不越过它
            if !line.ends_with('\n') {
                break;
            }
            pos += n as i64;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            state.ingest(&tx, trimmed)?;
        }

        if state.acc.seen {
            upsert_session(&tx, file, &state.acc)?;
        }
        let tail = tail_hex(&file.path, pos)?;
        tx.execute(
            "INSERT INTO claude_files(path,session_id,size,mtime,offset,tail,last_event_at,indexed_at,last_error)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,NULL)
             ON CONFLICT(path) DO UPDATE SET
                session_id=excluded.session_id, size=excluded.size, mtime=excluded.mtime,
                offset=excluded.offset, tail=excluded.tail, last_event_at=excluded.last_event_at,
                indexed_at=excluded.indexed_at, last_error=NULL",
            params![
                file.path.to_string_lossy().to_string(),
                if state.acc.seen { Some(file.session_key.clone()) } else { None },
                file.size as i64,
                file.mtime,
                pos,
                tail,
                state.acc.last_event_at,
                now_ms()
            ],
        )?;
        tx.commit()?;
        Ok(())
    }
}

impl<'a> ParseState<'a> {
    fn ingest(&mut self, conn: &Connection, line: &str) -> Result<(), AppError> {
        let Some(kind) = record_type(line) else { return Ok(()) };
        if !matches!(
            kind,
            "assistant" | "user" | "api-request" | "custom-title" | "agent-name" | "last-prompt"
                | "cost-state" | "system"
        ) {
            return Ok(());
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        };
        let ts = parse_ts(v.get("timestamp"));
        match kind {
            "api-request" => self.ingest_api_request(conn, &v, ts)?,
            "assistant" => self.ingest_assistant(conn, &v, ts)?,
            "user" => self.ingest_user(conn, &v, ts)?,
            "custom-title" => {
                self.touch(&v, ts);
                if let Some(t) = v.get("customTitle").and_then(Value::as_str) {
                    if !t.trim().is_empty() {
                        self.acc.title = Some(t.trim().to_string());
                    }
                }
            }
            "agent-name" => {
                self.touch(&v, ts);
                if self.acc.title.is_none() {
                    if let Some(t) = v.get("agentName").and_then(Value::as_str) {
                        if !t.trim().is_empty() {
                            self.acc.title = Some(t.trim().to_string());
                        }
                    }
                }
            }
            "last-prompt" => {
                self.touch(&v, ts);
                if self.acc.title.is_none() {
                    if let Some(t) = v.get("lastPrompt").and_then(Value::as_str) {
                        self.acc.title = Some(title_from_text(t));
                    }
                }
            }
            "cost-state" => {
                self.touch(&v, ts);
                if let Some(c) = v.get("totalCostUSD").and_then(Value::as_f64) {
                    self.acc.total_cost_usd = Some(c);
                }
                if let Some(d) = v.get("totalAPIDuration").and_then(Value::as_i64) {
                    self.acc.total_api_duration_ms = Some(d);
                }
            }
            "system" => {
                self.touch(&v, ts);
                if v.get("subtype").and_then(Value::as_str) == Some("api_error") {
                    self.acc.error_count += 1;
                    self.ingest_api_error(conn, &v, ts)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn touch(&mut self, v: &Value, ts: i64) {
        self.acc.seen = true;
        if ts > 0 {
            if self.acc.time_created == 0 || ts < self.acc.time_created {
                self.acc.time_created = ts;
            }
            if ts > self.acc.time_updated {
                self.acc.time_updated = ts;
            }
        }
        if let Some(cwd) = v.get("cwd").and_then(Value::as_str) {
            if !cwd.is_empty() {
                self.acc.directory = cwd.to_string();
            }
        }
        if let Some(ep) = v.get("entrypoint").and_then(Value::as_str) {
            self.acc.origin = Some(ep.to_string());
        }
        if let Some(a) = v.get("agentId").and_then(Value::as_str) {
            self.acc.agent = Some(a.to_string());
        }
        if let Some(sid) = v.get("sessionId").and_then(Value::as_str) {
            self.acc.raw_id = Some(sid.to_string());
        }
    }

    fn ingest_api_request(&mut self, conn: &Connection, v: &Value, ts: i64) -> Result<(), AppError> {
        let Some(id) = v.get("id").and_then(Value::as_str) else { return Ok(()) };
        if ts <= 0 {
            return Ok(());
        }
        let model = v
            .get("params")
            .and_then(|p| p.get("model"))
            .and_then(Value::as_str);
        conn.execute(
            "INSERT INTO claude_api_request(id,session_id,started_at,model) VALUES(?1,?2,?3,?4)
             ON CONFLICT(id) DO UPDATE SET
                started_at=MIN(claude_api_request.started_at, excluded.started_at),
                model=COALESCE(excluded.model, claude_api_request.model)",
            params![id, self.file.session_key, ts, model],
        )?;
        self.api_starts.insert(id.to_string(), ts);
        self.touch(v, ts);
        Ok(())
    }

    /// `system/api_error` 没有 requestRef，只能挂到本会话里最近一次 api-request 上。
    /// 失败尝试单独一行 status='error'，不参与主统计（主统计只取 completed），
    /// 但会进健康页的错误/重试计数。
    fn ingest_api_error(&self, conn: &Connection, v: &Value, ts: i64) -> Result<(), AppError> {
        let retry = v.get("retryAttempt").and_then(Value::as_i64).unwrap_or(0);
        let latest: Option<(String, i64, Option<String>)> = conn
            .query_row(
                "SELECT id,started_at,model FROM claude_api_request
                 WHERE session_id=?1 AND started_at<=?2
                 ORDER BY started_at DESC LIMIT 1",
                params![self.file.session_key, ts],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((api_id, start, model)) = latest else {
            return Ok(());
        };
        let error = v.get("error");
        let code = error
            .and_then(|e| e.get("connection"))
            .and_then(|c| c.get("code"))
            .and_then(Value::as_str)
            .or_else(|| error.and_then(|e| e.get("type")).and_then(Value::as_str))
            .unwrap_or("api_error");
        let message = error
            .and_then(|e| e.get("formatted").or_else(|| e.get("message")))
            .and_then(Value::as_str);
        let duration = if ts > start { Some(ts - start) } else { None };
        conn.execute(
            "INSERT OR IGNORE INTO claude_model_usage
             (id,session_id,turn,step,model_id,provider_id,agent,status,started_at,completed_at,
              duration_ms,time_to_first_token_ms,input_tokens,output_tokens,
              cache_read_input_tokens,cache_creation_input_tokens,reasoning_tokens,
              retry_count,cancelled_by_user,context_exceeded,error_type,error_code,error_message,
              request_ref,message_id,first_block_at,first_block_thinking,first_block_thinking_ms,
              cache_creation_5m_input_tokens,cache_creation_1h_input_tokens)
             VALUES(?1,?2,0,0,?3,'anthropic',?4,'error',?5,?6,?7,NULL,0,0,0,0,NULL,?8,0,0,
                    'api_error',?9,?10,?11,NULL,0,0,0,NULL,NULL)",
            params![
                format!("{api_id}:error:{retry}"),
                self.file.session_key,
                model.unwrap_or_else(|| "unknown".to_string()),
                v.get("agentId").and_then(Value::as_str),
                start,
                ts,
                duration,
                retry,
                code,
                message,
                api_id
            ],
        )?;
        Ok(())
    }

    fn ingest_assistant(&mut self, conn: &Connection, v: &Value, ts: i64) -> Result<(), AppError> {
        let Some(msg) = v.get("message") else { return Ok(()) };
        let Some(message_id) = msg.get("id").and_then(Value::as_str) else { return Ok(()) };
        let model = msg.get("model").and_then(Value::as_str).unwrap_or("");
        if model.is_empty() || model == "<synthetic>" {
            return Ok(());
        }
        let request_id = v
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or(message_id);
        let request_ref = v.get("requestRef").and_then(Value::as_str);
        let row_id = if request_id == message_id {
            message_id.to_string()
        } else {
            format!("{message_id}:{request_id}")
        };
        let started_at = self.start_for(conn, request_ref, ts)?;
        if started_at <= 0 {
            return Ok(());
        }

        let usage = msg.get("usage").cloned().unwrap_or(Value::Null);
        let input_raw = usage.get("input_tokens").and_then(Value::as_i64).unwrap_or(0);
        let cache_read = usage
            .get("cache_read_input_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let cache_write = usage
            .get("cache_creation_input_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let output = usage.get("output_tokens").and_then(Value::as_i64).unwrap_or(0);
        let reasoning = usage
            .get("output_tokens_details")
            .and_then(|d| d.get("thinking_tokens"))
            .and_then(Value::as_i64);
        let cache_5m = usage
            .get("cache_creation")
            .and_then(|c| c.get("ephemeral_5m_input_tokens"))
            .and_then(Value::as_i64);
        let cache_1h = usage
            .get("cache_creation")
            .and_then(|c| c.get("ephemeral_1h_input_tokens"))
            .and_then(Value::as_i64);

        let mut has_thinking = false;
        let mut tool_uses: Vec<(String, String)> = Vec::new();
        if let Some(arr) = msg.get("content").and_then(Value::as_array) {
            for block in arr {
                match block.get("type").and_then(Value::as_str) {
                    Some("thinking") => has_thinking = true,
                    Some("tool_use") => {
                        if let (Some(id), Some(name)) = (
                            block.get("id").and_then(Value::as_str),
                            block.get("name").and_then(Value::as_str),
                        ) {
                            tool_uses.push((id.to_string(), name.to_string()));
                        }
                    }
                    _ => {}
                }
            }
        }

        let api_block = v.get("apiBlockIndex").and_then(Value::as_i64).unwrap_or(0);
        let thinking_duration = v.get("thinkingDurationMs").and_then(Value::as_i64);
        let agent = v.get("agentId").and_then(Value::as_str);

        self.touch(v, ts);
        upsert_model(
            conn,
            &ModelInput {
                id: &row_id,
                session_id: &self.file.session_key,
                model,
                agent,
                started_at,
                completed_at: ts,
                is_first_block: api_block == 0,
                has_thinking,
                thinking_duration,
                // Claude 的 input 不含缓存读；查询层的 input 是含缓存命中的总 prompt
                input: input_raw + cache_read,
                output,
                cache_read,
                cache_write,
                reasoning,
                cache_5m,
                cache_1h,
                request_ref,
                message_id,
            },
        )?;

        for (id, name) in tool_uses {
            conn.execute(
                "INSERT INTO claude_tool_usage(id,session_id,tool_call_id,tool_name,status,started_at,completed_at,duration_ms)
                 VALUES(?1,?2,?1,?3,'pending',?4,NULL,NULL)
                 ON CONFLICT(id) DO UPDATE SET
                    session_id=COALESCE(claude_tool_usage.session_id, excluded.session_id),
                    tool_name=excluded.tool_name,
                    started_at=CASE
                        WHEN claude_tool_usage.started_at=0 THEN excluded.started_at
                        WHEN excluded.started_at>0 AND excluded.started_at<claude_tool_usage.started_at
                            THEN excluded.started_at
                        ELSE claude_tool_usage.started_at END",
                params![id, self.file.session_key, name, ts],
            )?;
        }
        Ok(())
    }

    fn ingest_user(&mut self, conn: &Connection, v: &Value, ts: i64) -> Result<(), AppError> {
        self.touch(v, ts);
        if ts > 0 {
            self.acc.last_event_at = ts;
        }
        let interrupted = v
            .get("toolUseResult")
            .and_then(|r| r.get("interrupted"))
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let mut text: Option<String> = None;
        match v.get("message").and_then(|m| m.get("content")) {
            Some(Value::String(s)) => text = Some(s.clone()),
            Some(Value::Array(arr)) => {
                for block in arr {
                    match block.get("type").and_then(Value::as_str) {
                        Some("tool_result") => {
                            let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
                                continue;
                            };
                            let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                            let status = if interrupted {
                                "cancelled"
                            } else if is_error {
                                "error"
                            } else {
                                "completed"
                            };
                            let updated = conn.execute(
                                "UPDATE claude_tool_usage
                                 SET status=?2, completed_at=?3,
                                     duration_ms=CASE WHEN started_at>0 AND ?3>=started_at
                                                      THEN ?3-started_at ELSE 0 END
                                 WHERE tool_call_id=?1",
                                params![id, status, ts],
                            )?;
                            if updated == 0 {
                                conn.execute(
                                    "INSERT INTO claude_tool_usage(id,session_id,tool_call_id,tool_name,status,started_at,completed_at,duration_ms)
                                     VALUES(?1,?2,?1,'unknown',?3,?4,?4,0)",
                                    params![id, self.file.session_key, status, ts],
                                )?;
                            }
                        }
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(Value::as_str) {
                                text.get_or_insert_with(String::new).push_str(t);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }

        if self.acc.title.is_none() && !v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false) {
            if let Some(t) = text {
                if !t.trim().is_empty() {
                    self.acc.title = Some(title_from_text(&t));
                }
            }
        }
        Ok(())
    }

    fn start_for(&self, conn: &Connection, request_ref: Option<&str>, fallback: i64) -> Result<i64, AppError> {
        if let Some(r) = request_ref {
            if let Some(t) = self.api_starts.get(r) {
                return Ok(*t);
            }
            let t: Option<i64> = conn
                .query_row(
                    "SELECT started_at FROM claude_api_request WHERE id=?1",
                    params![r],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(t) = t {
                return Ok(t);
            }
        }
        if self.acc.last_event_at > 0 {
            return Ok(self.acc.last_event_at);
        }
        Ok(fallback)
    }
}

fn upsert_session(conn: &Connection, file: &ClaudeFile, acc: &SessionAcc) -> Result<(), AppError> {
    let task_type = if file.is_subagent { "subagent_child" } else { "interactive" };
    let agent = acc
        .agent
        .clone()
        .or_else(|| if file.is_subagent { Some(file.agent_hint.clone()) } else { None });
    conn.execute(
        "INSERT INTO claude_session
         (id,raw_id,parent_id,directory,title,task_type,origin,agent,time_created,time_updated,
          error_count,total_cost_usd,total_api_duration_ms)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
         ON CONFLICT(id) DO UPDATE SET
            raw_id=COALESCE(claude_session.raw_id, excluded.raw_id),
            parent_id=COALESCE(claude_session.parent_id, excluded.parent_id),
            directory=CASE WHEN excluded.directory<>'' THEN excluded.directory ELSE claude_session.directory END,
            title=COALESCE(excluded.title, claude_session.title),
            task_type=excluded.task_type,
            origin=COALESCE(excluded.origin, claude_session.origin),
            agent=COALESCE(excluded.agent, claude_session.agent),
            time_created=CASE
                WHEN claude_session.time_created=0 THEN excluded.time_created
                WHEN excluded.time_created>0 AND excluded.time_created<claude_session.time_created
                    THEN excluded.time_created
                ELSE claude_session.time_created END,
            time_updated=MAX(claude_session.time_updated, excluded.time_updated),
            error_count=claude_session.error_count + excluded.error_count,
            total_cost_usd=COALESCE(excluded.total_cost_usd, claude_session.total_cost_usd),
            total_api_duration_ms=COALESCE(excluded.total_api_duration_ms, claude_session.total_api_duration_ms)",
        params![
            file.session_key,
            acc.raw_id,
            file.parent_id,
            acc.directory,
            acc.title,
            task_type,
            acc.origin,
            agent,
            acc.time_created,
            acc.time_updated,
            acc.error_count,
            acc.total_cost_usd,
            acc.total_api_duration_ms
        ],
    )?;
    Ok(())
}

fn upsert_model(conn: &Connection, m: &ModelInput<'_>) -> Result<(), AppError> {
    let existing: Option<ExistingRow> = conn
        .query_row(
            "SELECT session_id,started_at,completed_at,time_to_first_token_ms,
                    input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,
                    reasoning_tokens,first_block_at,first_block_thinking,first_block_thinking_ms,
                    model_id,request_ref,message_id,cache_creation_5m_input_tokens,
                    cache_creation_1h_input_tokens,agent
             FROM claude_model_usage WHERE id=?1",
            params![m.id],
            |r| {
                Ok(ExistingRow {
                    session_id: r.get(0)?,
                    started_at: r.get(1)?,
                    completed_at: r.get(2)?,
                    ttft_ms: r.get(3)?,
                    input: r.get(4)?,
                    output: r.get(5)?,
                    cache_read: r.get(6)?,
                    cache_write: r.get(7)?,
                    reasoning: r.get(8)?,
                    first_block_at: r.get(9)?,
                    first_block_thinking: r.get::<_, i64>(10)? != 0,
                    first_block_thinking_ms: r.get(11)?,
                    model_id: r.get(12)?,
                    request_ref: r.get(13)?,
                    message_id: r.get(14)?,
                    cache_5m: r.get(15)?,
                    cache_1h: r.get(16)?,
                    agent: r.get(17)?,
                })
            },
        )
        .optional()?;

    let session_id = existing
        .as_ref()
        .map(|e| e.session_id.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| m.session_id.to_string());
    let started_at = min_positive(existing.as_ref().map(|e| e.started_at).unwrap_or(0), m.started_at);
    let completed_at = max_opt(existing.as_ref().and_then(|e| e.completed_at), Some(m.completed_at));
    let duration = completed_at.and_then(|c| if c > started_at { Some(c - started_at) } else { None });

    let mut first_at = existing.as_ref().map(|e| e.first_block_at).unwrap_or(0);
    let mut first_thinking = existing.as_ref().map(|e| e.first_block_thinking).unwrap_or(false);
    let mut first_ms = existing.as_ref().map(|e| e.first_block_thinking_ms).unwrap_or(0);
    if m.is_first_block || first_at == 0 || (m.completed_at > 0 && m.completed_at < first_at) {
        first_at = m.completed_at;
        first_thinking = m.is_first_block && m.has_thinking;
        first_ms = m.thinking_duration.unwrap_or(0);
    }

    let mut ttft = existing.as_ref().and_then(|e| e.ttft_ms);
    if first_thinking && first_ms > 0 && first_at > started_at {
        let first_token = first_at - first_ms;
        let t = first_token - started_at;
        if t > 0 && duration.map(|d| t < d).unwrap_or(false) {
            ttft = Some(t);
        }
    }

    let input = max_i64(existing.as_ref().map(|e| e.input).unwrap_or(0), m.input);
    let output = max_i64(existing.as_ref().map(|e| e.output).unwrap_or(0), m.output);
    let cache_read = max_i64(existing.as_ref().map(|e| e.cache_read).unwrap_or(0), m.cache_read);
    let cache_write = max_i64(existing.as_ref().map(|e| e.cache_write).unwrap_or(0), m.cache_write);
    let reasoning = max_opt(existing.as_ref().and_then(|e| e.reasoning), m.reasoning);
    let cache_5m = max_opt(existing.as_ref().and_then(|e| e.cache_5m), m.cache_5m);
    let cache_1h = max_opt(existing.as_ref().and_then(|e| e.cache_1h), m.cache_1h);
    let model_id = if m.model.is_empty() {
        existing.as_ref().map(|e| e.model_id.clone()).unwrap_or_default()
    } else {
        m.model.to_string()
    };
    let request_ref = m
        .request_ref
        .map(str::to_string)
        .or_else(|| existing.as_ref().and_then(|e| e.request_ref.clone()));
    let message_id = existing
        .as_ref()
        .and_then(|e| e.message_id.clone())
        .unwrap_or_else(|| m.message_id.to_string());
    let agent = m
        .agent
        .map(str::to_string)
        .or_else(|| existing.as_ref().and_then(|e| e.agent.clone()));

    conn.execute(
        "INSERT OR REPLACE INTO claude_model_usage
         (id,session_id,turn,step,model_id,provider_id,agent,status,started_at,completed_at,duration_ms,
          time_to_first_token_ms,input_tokens,output_tokens,cache_read_input_tokens,
          cache_creation_input_tokens,reasoning_tokens,retry_count,cancelled_by_user,
          context_exceeded,error_type,error_code,error_message,request_ref,message_id,
          first_block_at,first_block_thinking,first_block_thinking_ms,
          cache_creation_5m_input_tokens,cache_creation_1h_input_tokens)
         VALUES(?1,?2,0,0,?3,'anthropic',?4,'completed',?5,?6,?7,?8,?9,?10,?11,?12,?13,0,0,0,NULL,NULL,NULL,?14,?15,?16,?17,?18,?19,?20)",
        params![
            m.id,
            session_id,
            model_id,
            agent,
            started_at,
            completed_at,
            duration,
            ttft,
            input,
            output,
            cache_read,
            cache_write,
            reasoning,
            request_ref,
            message_id,
            first_at,
            if first_thinking { 1 } else { 0 },
            first_ms,
            cache_5m,
            cache_1h
        ],
    )?;
    Ok(())
}

fn delete_session_rows(conn: &Connection, session_id: &str) -> Result<(), AppError> {
    conn.execute("DELETE FROM claude_model_usage WHERE session_id=?1", params![session_id])?;
    conn.execute("DELETE FROM claude_tool_usage WHERE session_id=?1", params![session_id])?;
    conn.execute("DELETE FROM claude_session WHERE id=?1", params![session_id])?;
    Ok(())
}

fn ensure_meta(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS claude_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );",
    )?;
    Ok(())
}

/// 查询层在建立 TEMP VIEW 前调用；即使 Claude 目录不存在，也要保证表结构可查询。
pub fn ensure_tables(conn: &Connection) -> Result<(), AppError> {
    ensure_meta(conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS claude_files (
            path TEXT PRIMARY KEY,
            session_id TEXT,
            size INTEGER NOT NULL,
            mtime INTEGER NOT NULL,
            offset INTEGER NOT NULL,
            tail TEXT NOT NULL,
            last_event_at INTEGER NOT NULL DEFAULT 0,
            indexed_at INTEGER NOT NULL,
            last_error TEXT
         );
         CREATE TABLE IF NOT EXISTS claude_session (
            id TEXT PRIMARY KEY,
            raw_id TEXT,
            parent_id TEXT,
            directory TEXT NOT NULL,
            title TEXT,
            task_type TEXT,
            origin TEXT,
            agent TEXT,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            error_count INTEGER NOT NULL DEFAULT 0,
            total_cost_usd REAL,
            total_api_duration_ms INTEGER
         );
         CREATE TABLE IF NOT EXISTS claude_model_usage (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            turn INTEGER NOT NULL DEFAULT 0,
            step INTEGER NOT NULL DEFAULT 0,
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
            error_message TEXT,
            request_ref TEXT,
            message_id TEXT,
            first_block_at INTEGER NOT NULL DEFAULT 0,
            first_block_thinking INTEGER NOT NULL DEFAULT 0,
            first_block_thinking_ms INTEGER NOT NULL DEFAULT 0,
            cache_creation_5m_input_tokens INTEGER,
            cache_creation_1h_input_tokens INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_claude_mu_started ON claude_model_usage(started_at);
         CREATE INDEX IF NOT EXISTS idx_claude_mu_session ON claude_model_usage(session_id);
         CREATE INDEX IF NOT EXISTS idx_claude_mu_model ON claude_model_usage(model_id);
         CREATE TABLE IF NOT EXISTS claude_tool_usage (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            tool_call_id TEXT,
            tool_name TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            completed_at INTEGER,
            duration_ms INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_claude_tool_session ON claude_tool_usage(session_id);
         CREATE INDEX IF NOT EXISTS idx_claude_tool_call ON claude_tool_usage(tool_call_id);
         CREATE TABLE IF NOT EXISTS claude_api_request (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            model TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_claude_api_session ON claude_api_request(session_id);",
    )?;
    Ok(())
}

fn walk_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_jsonl(&path, out);
        } else if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            // workflow 的 journal 不是会话 transcript，读了只会产生空会话
            if path.file_name().map(|n| n == "journal.jsonl").unwrap_or(false) {
                continue;
            }
            out.push(path);
        }
    }
}

/// 返回 (session_key, parent_id, is_subagent, agent_hint)。
/// 顶层 transcript 的 key 是文件名；subagent 文件用 `父会话:agent:文件名`，避免与父会话撞 id。
fn session_key(root: &Path, path: &Path) -> Option<(String, Option<String>, bool, String)> {
    let rel = path.strip_prefix(root).ok()?;
    let comps: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    if comps.len() < 2 {
        return None;
    }
    let stem = path.file_stem()?.to_string_lossy().to_string();
    if comps.len() == 2 {
        Some((stem.clone(), None, false, stem))
    } else {
        let parent = comps[1].clone();
        let agent = stem.strip_prefix("agent-").unwrap_or(&stem).to_string();
        Some((format!("{parent}:agent:{stem}"), Some(parent), true, agent))
    }
}

/// 只取顶层 `type`，不解析整行：assistant 行里可能带着几十 KB 的 tool_use 输入，
/// 但绝大多数无关行（api-request-blob、file-history 等）应该被快速跳过。
/// 不能简单找第一个 `"type":`——嵌套 content 块也有 type，且 JSON key 顺序不保证。
fn record_type(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    let mut depth = 0i32;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'{' | b'[' => {
                depth += 1;
                i += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                i += 1;
            }
            b'"' => {
                let start = i + 1;
                let mut j = start;
                let mut escaped = false;
                while j < bytes.len() {
                    match bytes[j] {
                        b'\\' if !escaped => {
                            escaped = true;
                            j += 1;
                        }
                        b'"' if !escaped => break,
                        _ => {
                            escaped = false;
                            j += 1;
                        }
                    }
                }
                if j >= bytes.len() {
                    return None;
                }
                if depth == 1 && &line[start..j] == "type" {
                    let mut k = j + 1;
                    while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                        k += 1;
                    }
                    if k < bytes.len() && bytes[k] == b':' {
                        k += 1;
                        while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                            k += 1;
                        }
                        if k < bytes.len() && bytes[k] == b'"' {
                            let vstart = k + 1;
                            let mut v = vstart;
                            let mut esc = false;
                            while v < bytes.len() {
                                match bytes[v] {
                                    b'\\' if !esc => {
                                        esc = true;
                                        v += 1;
                                    }
                                    b'"' if !esc => break,
                                    _ => {
                                        esc = false;
                                        v += 1;
                                    }
                                }
                            }
                            return Some(&line[vstart..v]);
                        }
                    }
                }
                i = j + 1;
            }
            _ => i += 1,
        }
    }
    None
}

fn parse_ts(v: Option<&Value>) -> i64 {
    v.and_then(Value::as_str)
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0)
}

fn title_from_text(text: &str) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = one_line.chars().take(80).collect();
    if one_line.chars().count() > 80 {
        out.push('…');
    }
    out
}

fn min_positive(a: i64, b: i64) -> i64 {
    match (a > 0, b > 0) {
        (true, true) => a.min(b),
        (true, false) => a,
        (false, true) => b,
        (false, false) => 0,
    }
}

fn max_i64(a: i64, b: i64) -> i64 {
    a.max(b)
}

fn max_opt(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (Some(x), None) => Some(x),
        (None, Some(y)) => Some(y),
        (None, None) => None,
    }
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

fn tail_hex(path: &Path, offset: i64) -> Result<String, AppError> {
    if offset <= 0 {
        return Ok(String::new());
    }
    let start = (offset - 64).max(0);
    let mut f = File::open(path)
        .map_err(|e| AppError::Unavailable(format!("无法打开 Claude 日志 {}: {e}", path.display())))?;
    f.seek(SeekFrom::Start(start as u64))
        .map_err(|e| AppError::Unavailable(format!("无法定位 Claude 日志 {}: {e}", path.display())))?;
    let mut buf = vec![0u8; (offset - start) as usize];
    f.read_exact(&mut buf)
        .map_err(|e| AppError::Unavailable(format!("读取 Claude 日志尾部 {}: {e}", path.display())))?;
    let mut out = String::with_capacity(buf.len() * 2);
    for b in buf {
        out.push_str(&format!("{b:02x}"));
    }
    Ok(out)
}

fn tail_matches(path: &Path, offset: i64, expected: &str) -> bool {
    if offset <= 0 {
        return expected.is_empty();
    }
    tail_hex(path, offset).map(|t| t == expected).unwrap_or(false)
}


#[cfg(test)]
#[path = "claude_tests.rs"]
mod tests;
