use super::*;
use serde_json::{json, Value};
use std::io::Write;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "claude-index-test-{tag}-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_lines(path: &Path, lines: &[Value]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let mut text = String::new();
    for line in lines {
        text.push_str(&line.to_string());
        text.push('\n');
    }
    fs::write(path, text).unwrap();
}

fn append_lines(path: &Path, lines: &[Value]) {
    let mut f = fs::OpenOptions::new().append(true).open(path).unwrap();
    for line in lines {
        writeln!(f, "{}", line).unwrap();
    }
}

fn ts(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s)
        .unwrap()
        .timestamp_millis()
}

fn user(ts: &str, session: &str, text: &str) -> Value {
    json!({
        "type": "user", "timestamp": ts, "sessionId": session, "cwd": "C:\\proj",
        "message": { "role": "user", "content": text }
    })
}

fn api(ts: &str, id: &str, session: &str) -> Value {
    json!({
        "type": "api-request", "id": id, "timestamp": ts, "sessionId": session,
        "params": { "model": "claude-sonnet-5" }
    })
}

fn assistant(
    ts: &str,
    session: &str,
    message_id: &str,
    request_id: &str,
    request_ref: &str,
    block: i64,
    content: Value,
    think: Option<i64>,
) -> Value {
    let mut v = json!({
        "type": "assistant", "timestamp": ts, "sessionId": session, "cwd": "C:\\proj",
        "requestId": request_id, "requestRef": request_ref, "apiBlockIndex": block,
        "message": {
            "id": message_id, "model": "claude-sonnet-5", "stop_reason": "tool_use",
            "usage": {
                "input_tokens": 10, "output_tokens": 50,
                "cache_read_input_tokens": 100, "cache_creation_input_tokens": 20,
                "output_tokens_details": { "thinking_tokens": 30 },
                "cache_creation": {
                    "ephemeral_5m_input_tokens": 0,
                    "ephemeral_1h_input_tokens": 20
                }
            },
            "content": content
        }
    });
    if let Some(t) = think {
        v["thinkingDurationMs"] = json!(t);
    }
    v
}

fn tool_result(ts: &str, session: &str, tool_id: &str) -> Value {
    json!({
        "type": "user", "timestamp": ts, "sessionId": session, "cwd": "C:\\proj",
        "message": { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": tool_id, "content": "ok" }
        ] }
    })
}

#[test]
fn parses_timing_tokens_tools_and_title() {
    let dir = temp_dir("parse");
    let root = dir.join("projects");
    let db = dir.join("index.sqlite");
    let path = root.join("proj").join("sess-1.jsonl");
    write_lines(
        &path,
        &[
            user("2026-11-01T18:00:00.000Z", "sess-1", "第一个问题"),
            api("2026-11-01T18:00:00.100Z", "ref-1", "sess-1"),
            assistant(
                "2026-11-01T18:00:01.000Z",
                "sess-1",
                "msg_1",
                "req_1",
                "ref-1",
                0,
                json!([{ "type": "thinking", "thinking": "" }]),
                Some(800),
            ),
            assistant(
                "2026-11-01T18:00:02.000Z",
                "sess-1",
                "msg_1",
                "req_1",
                "ref-1",
                1,
                json!([{ "type": "tool_use", "id": "toolu_1", "name": "Read", "input": {} }]),
                None,
            ),
            tool_result("2026-11-01T18:00:02.050Z", "sess-1", "toolu_1"),
            json!({
                "type": "custom-title", "timestamp": "2026-11-01T18:00:03.000Z",
                "sessionId": "sess-1", "customTitle": "测试会话"
            }),
        ],
    );

    let mut indexer = ClaudeIndexer::new(root.clone(), db.clone());
    let stats = indexer.ensure_fresh(true).unwrap();
    assert_eq!(stats.requests, 1);
    assert_eq!(stats.sessions, 1);
    assert_eq!(stats.tools, 1);

    let conn = Connection::open(&db).unwrap();
    let (started, completed, duration, ttft, input, output, read, write, reasoning, model): (
        i64,
        i64,
        i64,
        Option<i64>,
        i64,
        i64,
        i64,
        i64,
        Option<i64>,
        String,
    ) = conn
        .query_row(
            "SELECT started_at,completed_at,duration_ms,time_to_first_token_ms,
                    input_tokens,output_tokens,cache_read_input_tokens,
                    cache_creation_input_tokens,reasoning_tokens,model_id
             FROM claude_model_usage",
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(started, ts("2026-11-01T18:00:00.100Z"));
    assert_eq!(completed, ts("2026-11-01T18:00:02.000Z"));
    assert_eq!(duration, 1900);
    // 首块 18:00:01，thinking 800ms → 首 token 18:00:00.200，距请求开始 100ms
    assert_eq!(ttft, Some(100));
    assert_eq!(input, 110); // Claude 的 input 不含缓存读，索引层补成含缓存读的总 prompt
    assert_eq!(output, 50);
    assert_eq!(read, 100);
    assert_eq!(write, 20);
    assert_eq!(reasoning, Some(30));
    assert_eq!(model, "claude-sonnet-5");

    let (title, task_type, directory): (String, String, String) = conn
        .query_row(
            "SELECT title,task_type,directory FROM claude_session WHERE id='sess-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(title, "测试会话");
    assert_eq!(task_type, "interactive");
    assert_eq!(directory, "C:\\proj");

    let (tool_status, tool_ms): (String, i64) = conn
        .query_row(
            "SELECT status,duration_ms FROM claude_tool_usage WHERE tool_call_id='toolu_1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(tool_status, "completed");
    assert_eq!(tool_ms, 50);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn dedupes_same_message_across_sessions() {
    let dir = temp_dir("dedupe");
    let root = dir.join("projects");
    let db = dir.join("index.sqlite");
    let line = assistant(
        "2026-11-01T18:00:01.000Z",
        "sess-a",
        "msg_dup",
        "req_dup",
        "ref_dup",
        0,
        json!([{ "type": "text", "text": "hi" }]),
        None,
    );
    write_lines(&root.join("proj").join("sess-a.jsonl"), &[line.clone()]);
    let mut second = line.clone();
    second["sessionId"] = json!("sess-b");
    write_lines(&root.join("proj").join("sess-b.jsonl"), &[second]);

    let mut indexer = ClaudeIndexer::new(root, db.clone());
    indexer.ensure_fresh(true).unwrap();
    let conn = Connection::open(&db).unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM claude_model_usage", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
    let sid: String = conn
        .query_row("SELECT session_id FROM claude_model_usage", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sid, "sess-a");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn incremental_append_reads_only_new_lines() {
    let dir = temp_dir("incremental");
    let root = dir.join("projects");
    let db = dir.join("index.sqlite");
    let path = root.join("proj").join("sess-1.jsonl");
    write_lines(
        &path,
        &[
            user("2026-11-01T18:00:00.000Z", "sess-1", "q1"),
            assistant(
                "2026-11-01T18:00:01.000Z",
                "sess-1",
                "msg_1",
                "req_1",
                "ref_1",
                0,
                json!([{ "type": "text", "text": "a1" }]),
                None,
            ),
        ],
    );
    let mut indexer = ClaudeIndexer::new(root.clone(), db.clone());
    indexer.min_interval = Duration::ZERO;
    indexer.ensure_fresh(true).unwrap();

    append_lines(
        &path,
        &[
            user("2026-11-01T18:01:00.000Z", "sess-1", "q2"),
            assistant(
                "2026-11-01T18:01:01.000Z",
                "sess-1",
                "msg_2",
                "req_2",
                "ref_2",
                0,
                json!([{ "type": "text", "text": "a2" }]),
                None,
            ),
        ],
    );
    let stats = indexer.ensure_fresh(false).unwrap();
    assert_eq!(stats.parsed_files, 1);
    let conn = Connection::open(&db).unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM claude_model_usage", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 2);

    // 再刷新一次：没有新内容，不应重复解析
    let stats = indexer.ensure_fresh(false).unwrap();
    assert_eq!(stats.parsed_files, 0);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn subagent_file_gets_parent_and_agent() {
    let dir = temp_dir("subagent");
    let root = dir.join("projects");
    let db = dir.join("index.sqlite");
    let path = root
        .join("proj")
        .join("sess-parent")
        .join("subagents")
        .join("agent-abc.jsonl");
    let mut line = assistant(
        "2026-11-01T18:00:01.000Z",
        "sess-parent",
        "msg_sub",
        "req_sub",
        "ref_sub",
        0,
        json!([{ "type": "text", "text": "sub" }]),
        None,
    );
    line["agentId"] = json!("abc");
    line["isSidechain"] = json!(true);
    write_lines(&path, &[line]);

    let mut indexer = ClaudeIndexer::new(root, db.clone());
    indexer.ensure_fresh(true).unwrap();
    let conn = Connection::open(&db).unwrap();
    let (parent, task_type, agent): (Option<String>, String, Option<String>) = conn
        .query_row(
            "SELECT parent_id,task_type,agent FROM claude_session WHERE id LIKE '%agent-abc'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(parent.as_deref(), Some("sess-parent"));
    assert_eq!(task_type, "subagent_child");
    assert_eq!(agent.as_deref(), Some("abc"));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn falls_back_to_last_user_event_without_api_request() {
    let dir = temp_dir("fallback");
    let root = dir.join("projects");
    let db = dir.join("index.sqlite");
    let path = root.join("proj").join("sess-1.jsonl");
    write_lines(
        &path,
        &[
            user("2026-11-01T18:00:00.000Z", "sess-1", "q"),
            assistant(
                "2026-11-01T18:00:01.000Z",
                "sess-1",
                "msg_1",
                "req_1",
                "",
                0,
                json!([{ "type": "text", "text": "a" }]),
                None,
            ),
        ],
    );
    let mut indexer = ClaudeIndexer::new(root, db.clone());
    indexer.ensure_fresh(true).unwrap();
    let conn = Connection::open(&db).unwrap();
    let (started, duration, ttft): (i64, i64, Option<i64>) = conn
        .query_row(
            "SELECT started_at,duration_ms,time_to_first_token_ms FROM claude_model_usage",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(started, ts("2026-11-01T18:00:00.000Z"));
    assert_eq!(duration, 1000);
    assert_eq!(ttft, None);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
#[ignore]
fn real_projects_index_smoke() {
    let root = default_projects_root();
    if !root.exists() {
        eprintln!("skip: {} not found", root.display());
        return;
    }
    let dir = temp_dir("real");
    let db = dir.join("index.sqlite");
    let mut indexer = ClaudeIndexer::new(root, db.clone());
    indexer.min_interval = Duration::ZERO;
    let t = std::time::Instant::now();
    let stats = indexer.ensure_fresh(true).unwrap();
    eprintln!("full: {:?} in {:?}", stats, t.elapsed());

    let conn = Connection::open(&db).unwrap();
    let (requests, output, input, read, write, duration, ttft_count, models): (
        i64, i64, i64, i64, i64, i64, i64, i64,
    ) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(output_tokens),0), COALESCE(SUM(input_tokens),0),
                    COALESCE(SUM(cache_read_input_tokens),0), COALESCE(SUM(cache_creation_input_tokens),0),
                    COALESCE(SUM(duration_ms),0), COUNT(time_to_first_token_ms),
                    COUNT(DISTINCT model_id)
             FROM claude_model_usage",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
        )
        .unwrap();
    eprintln!(
        "requests={requests} output={output} input={input} cache_read={read} cache_write={write} duration_ms={duration} with_ttft={ttft_count} models={models}"
    );
    eprintln!(
        "total_speed={:.1} tok/s",
        output as f64 / (duration as f64 / 1000.0)
    );
    let sessions: i64 = conn
        .query_row("SELECT COUNT(*) FROM claude_session", [], |r| r.get(0))
        .unwrap();
    let subagents: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM claude_session WHERE task_type='subagent_child'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let tools: i64 = conn
        .query_row("SELECT COUNT(*) FROM claude_tool_usage", [], |r| r.get(0))
        .unwrap();
    eprintln!("sessions={sessions} subagents={subagents} tools={tools}");

    let t = std::time::Instant::now();
    let stats = indexer.ensure_fresh(false).unwrap();
    eprintln!("incremental: {:?} in {:?}", stats, t.elapsed());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unified_view_includes_claude() {
    let dir = temp_dir("unified");
    let root = dir.join("projects");
    let db = dir.join("index.sqlite");
    let path = root.join("proj").join("sess-1.jsonl");
    write_lines(
        &path,
        &[
            user("2026-11-01T18:00:00.000Z", "sess-1", "q"),
            assistant(
                "2026-11-01T18:00:01.000Z",
                "sess-1",
                "msg_1",
                "req_1",
                "",
                0,
                json!([{ "type": "text", "text": "a" }]),
                None,
            ),
        ],
    );
    let mut indexer = ClaudeIndexer::new(root, db.clone());
    indexer.ensure_fresh(true).unwrap();

    let conn = crate::unified::open_query(
        &db,
        &dir.join("missing-zcode.sqlite"),
        crate::sources::SourceFilter::Claude,
    )
    .unwrap();
    let (source, model, requests): (String, String, i64) = conn
        .query_row(
            "SELECT source, model_id, COUNT(*) FROM model_usage GROUP BY source, model_id",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(source, "claude");
    assert_eq!(model, "claude-sonnet-5");
    assert_eq!(requests, 1);

    let session_source: String = conn
        .query_row("SELECT source FROM session LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(session_source, "claude");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
#[ignore]
fn real_projects_query_smoke() {
    let root = default_projects_root();
    if !root.exists() {
        eprintln!("skip: {} not found", root.display());
        return;
    }
    let dir = temp_dir("real-query");
    let db = dir.join("index.sqlite");
    let pricing_path = dir.join("pricing.json");
    crate::pricing::save(&pricing_path, &crate::pricing::default_config()).unwrap();
    let mut indexer = ClaudeIndexer::new(root, db.clone());
    indexer.min_interval = Duration::ZERO;
    let stats = indexer.ensure_fresh(true).unwrap();
    eprintln!("index: {:?}", stats);

    let conn = crate::unified::open_query(
        &db,
        &dir.join("missing-zcode.sqlite"),
        crate::sources::SourceFilter::Claude,
    )
    .unwrap();
    let range = crate::types::Range::default();
    let summary = crate::queries::get_summary(&conn, &range, &pricing_path).unwrap();
    eprintln!(
        "summary: requests={} sessions={} input={} output={} cache_read={} cache_write={} reasoning={} speed={:?} decode={:?} cost={} unpriced={:?}",
        summary.requests,
        summary.sessions,
        summary.input_tokens,
        summary.output_tokens,
        summary.cache_read_tokens,
        summary.cache_create_tokens,
        summary.reasoning_tokens,
        summary.tokens_per_sec,
        summary.decode_tokens_per_sec,
        summary.cost,
        summary.unpriced_models
    );

    let models = crate::queries::get_model_stats(&conn, &range, &pricing_path).unwrap();
    for m in models.iter().take(8) {
        eprintln!(
            "model {}: req={} out={} speed={:?} decode={:?} cost={}",
            m.model_id, m.requests, m.output_tokens, m.tokens_per_sec, m.decode_tokens_per_sec, m.cost
        );
    }

    let log = crate::queries::get_request_log(&conn, &range, 1, 3, &pricing_path).unwrap();
    eprintln!("log groups={} total={}", log.groups.len(), log.total);
    for g in &log.groups {
        eprintln!(
            "group {} title={:?} project={} rows={}",
            g.session_id,
            g.title,
            g.project,
            g.requests.len()
        );
    }

    let rate = crate::queries::get_token_rate(&conn, 5, crate::queries::now_ms()).unwrap();
    eprintln!(
        "rate: output={} active={:.1} decode={:.1} requests={} concurrency={:.2}",
        rate.output_tokens,
        rate.active_tokens_per_sec,
        rate.decode_tokens_per_sec,
        rate.requests,
        rate.concurrency
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn maps_api_error_to_error_row() {
    let dir = temp_dir("api-error");
    let root = dir.join("projects");
    let db = dir.join("index.sqlite");
    let path = root.join("proj").join("sess-1.jsonl");
    write_lines(
        &path,
        &[
            user("2026-11-01T18:00:00.000Z", "sess-1", "q"),
            api("2026-11-01T18:00:00.100Z", "ref-1", "sess-1"),
            json!({
                "type": "system", "subtype": "api_error", "timestamp": "2026-11-01T18:00:01.000Z",
                "sessionId": "sess-1", "retryAttempt": 1,
                "error": { "message": "Connection error.", "formatted": "Connection dropped",
                           "connection": { "code": "ECONNRESET" } }
            }),
        ],
    );
    let mut indexer = ClaudeIndexer::new(root, db.clone());
    indexer.ensure_fresh(true).unwrap();
    let conn = Connection::open(&db).unwrap();
    let (status, started, completed, retry, code, message, model): (
        String, i64, i64, i64, String, String, String,
    ) = conn
        .query_row(
            "SELECT status,started_at,completed_at,retry_count,error_code,error_message,model_id
             FROM claude_model_usage WHERE status='error'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .unwrap();
    assert_eq!(status, "error");
    assert_eq!(started, ts("2026-11-01T18:00:00.100Z"));
    assert_eq!(completed, ts("2026-11-01T18:00:01.000Z"));
    assert_eq!(retry, 1);
    assert_eq!(code, "ECONNRESET");
    assert_eq!(message, "Connection dropped");
    assert_eq!(model, "claude-sonnet-5");

    let _ = fs::remove_dir_all(&dir);
}
