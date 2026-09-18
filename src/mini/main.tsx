import React from "react";
import ReactDOM from "react-dom/client";
import { useEffect, useState } from "react";
import type { Summary } from "../../shared/types";
import { api } from "../api";
import { fmtCostSplit, setUsdCnyRate } from "../format";
import { Maximize2, TriangleAlert, X } from "lucide-react";
import "../tailwind.css";
import "../styles.css";
import "./mini.css";
// 副作用引入:浮窗启动即应用当前主题,并监听主窗口的主题切换
import "../theme";

const REFRESH_MS = 30_000;

/** 与主窗口「今天」范围同口径:当天零点起、不设上界 */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 紧凑数字:胶囊单行空间有限,去掉尾部零(892k / 1.28M) */
function fmtCompact(n: number | null | undefined): string {
  const v = n ?? 0;
  const abs = Math.abs(v);
  const trim = (s: string) => s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (abs >= 1e9) return trim((v / 1e9).toFixed(2)) + "B";
  if (abs >= 1e6) return trim((v / 1e6).toFixed(2)) + "M";
  if (abs >= 1e3) return trim((v / 1e3).toFixed(1)) + "k";
  return String(v);
}

function MiniApp() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 汇率:迷你窗独立入口,同样按配置刷新折算系数(与主窗口保持一致)
  useEffect(() => {
    api.pricing().then(
      (cfg) => setUsdCnyRate(cfg.usdCnyRate),
      () => undefined,
    );
  }, []);

  useEffect(() => {
    let alive = true;
    // 每轮重算零点,跨天后自动切到新的"今日"
    const load = () =>
      api.summary({ from: startOfToday() }).then(
        (s) => {
          if (!alive) return;
          setSummary(s);
          setError(null);
        },
        (e) => {
          if (alive) setError(String(e));
        },
      );
    load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  // 与主窗口汇总卡片同口径:总 tokens = 输入 + 输出(缓存读/写是输入子集,不叠加)
  const total = summary ? summary.inputTokens + summary.outputTokens : null;

  return (
    <div className="mini">
      <span className={"mini-dot" + (error ? " err" : "")} data-tauri-drag-region />
      {error ? (
        <div className="mini-main" data-tauri-drag-region="deep">
          <span className="mini-error" title={error}>
            读取失败,稍后自动重试
          </span>
        </div>
      ) : (
        <div className="mini-main" data-tauri-drag-region="deep" title="今日 tokens 用量与估算费用">
          <span className="mini-strong">{summary ? fmtCompact(total) : "…"}</span>
          <span>入 {fmtCompact(summary?.inputTokens)}</span>
          <span>出 {fmtCompact(summary?.outputTokens)}</span>
          <span>缓存 {fmtCompact(summary ? summary.cacheReadTokens + summary.cacheCreateTokens : null)}</span>
          <span className="mini-cost">{fmtCostSplit(summary?.costUsd, summary?.costCny)}</span>
        </div>
      )}
      {summary && summary.unpricedModels.length > 0 && (
        <span
          className="mini-warn"
          title={`未配置单价:${summary.unpricedModels.join("、")}`}
        >
          <TriangleAlert size={12} />
        </span>
      )}
      <div className="mini-actions">
        <button className="mini-btn" title="打开主窗口" onClick={() => api.showMainWindow()}>
          <Maximize2 size={13} />
        </button>
        <button
          className="mini-btn mini-close"
          title="隐藏胶囊"
          onClick={() => api.setMiniVisible(false)}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

// macOS WKWebView 的双击词选不受 CSS user-select:none 约束,须拦截 selectstart 彻底禁选;
// dblclick 清空选区兜底(按钮点击与 drag-region 拖拽不受影响)
document.addEventListener("selectstart", (e) => e.preventDefault());
document.addEventListener("dblclick", () => document.getSelection()?.removeAllRanges());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MiniApp />
  </React.StrictMode>,
);
