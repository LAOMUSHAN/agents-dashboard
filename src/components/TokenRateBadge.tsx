import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TokenRate } from "../../shared/types";
import { fmtNumber, fmtTimestamp } from "../format";
import { Hint, HintText } from "./ui/hint";
import { cn } from "@/lib/utils";

const PATH_SCALE = 1000;
const CLOSE_DURATION_MS = 120; // 数据到达后补满最后一小段至 100% 的闭环时长

/**
 * 顶栏实时 Token 速度（总速度口径）+ 描边倒计时进度环。
 *
 * 主数字 = 窗口内**输出**摊分到解码段后 ÷ 「窗口内有调用在跑的墙钟并集」。
 * 与总览「总速度」（输出 ÷ LLM 耗时）同口径：单请求约 100 tok/s，N 个对话真正
 * 同时跑就是约 N × 100；窗口内没有调用在跑就是 0。
 *
 * 分子刻意不含输入：DSH 一次调用输入 60k–180k（94%–99% 是缓存读），算进去会把
 * 读数拉到万级。分母刻意不用整个刷新窗口：5 个对话各跑 10 秒、窗口 120 秒，
 * 5000 输出 ÷ 120 会把 500 摊成 41（虚低）。
 *
 * ## 进度环：闭环状态机，不预测周期
 *
 * 早先七版都在用单一标量 `periodMs` 去线性映射一个带抖动的异步事件
 * （`p = min(1, elapsed / periodMs)`）。这条路数学上不可能收敛：
 * 本轮真实周期 < periodMs 时，进度走到 91% 就被新一轮清零（顶部中点留缺口）；
 * 本轮真实周期 > periodMs 时，`elapsed` 撞上钳制，描边在满圈硬停 0.6–1.5 秒。
 *
 * 现在改成三段式，由请求状态驱动，不再预测任何时长：
 *   1. **推进期**：从上一轮完成起，`intervalMs` 内匀速走到 92%；
 *   2. **等待期**（超过 interval 或请求在途）：从 92% 指数渐近 99.2%，
 *      永远在顺时针微动，既不停死也绝不提前撞到 100% 空等；
 *   3. **闭环期**（`dataUpdatedAt` 更新的瞬间）：用 120ms 把剩余段平滑推满到 100%，
 *      在抵达 1.000 的下一帧同步换上新的速度数字并归零。**每轮必定满圈闭合**。
 *
 * 路径用起点就在顶部中点的 `<path pathLength={1000}>`，不再算周长、不再用
 * `strokeDashoffset` 偏移起点；数字区锁 `min-w-[5ch]`，胶囊宽度不再随位数抖动，
 * `d` 属性在运行期恒定。
 *
 * 驱动是 `setInterval(33)` + 直接写 SVG 属性，全程零 React 重渲染
 * （只有闭环结束那一帧 setDisplayRate 一次）。
 */
export function TokenRateBadge({
  rate,
  windowSec,
  dataUpdatedAt,
  isFetching,
  pending,
}: {
  rate: TokenRate | null;
  /** 采样窗口（秒）= 当前刷新间隔 */
  windowSec: number;
  /** 最近一次数据成功刷新的时间戳（epoch ms） */
  dataUpdatedAt?: number;
  /** 当前是否有请求正在执行 */
  isFetching?: boolean;
  /** 首次取数中；此时还没有任何快照 */
  pending?: boolean;
}) {
  // 显示快照与环归零严格同步：在 120ms 闭环动画走满 100% 的那一刻才切换显示的数字
  const [displayRate, setDisplayRate] = useState<TokenRate | null>(rate);
  const latestRateRef = useRef<TokenRate | null>(rate);
  latestRateRef.current = rate;

  useEffect(() => {
    if (!displayRate && rate) {
      setDisplayRate(rate);
    }
  }, [rate, displayRate]);

  const speed = displayRate?.activeTokensPerSec ?? 0;
  const active = speed > 0;
  const value = displayRate ? fmtSpeed(displayRate.activeTokensPerSec) : pending ? "…" : "—";
  const activeSecs = (displayRate?.activeMs ?? 0) / 1000;
  const intervalMs = Math.max(1, windowSec) * 1000;

  const trackRef = useRef<HTMLDivElement>(null);
  const countdownRef = useRef<HTMLSpanElement>(null);
  const ringRef = useRef<SVGPathElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // 动画状态机（全部存于 ref，不触发 React 重渲染）
  const stateRef = useRef<{
    phase: "running" | "closing";
    cycleStartMs: number;
    closeStartMs: number;
    closeFromP: number;
    currentP: number;
    lastUpdatedAt: number;
  }>({
    phase: "running",
    cycleStartMs: Date.now(),
    closeStartMs: 0,
    closeFromP: 0,
    currentP: 0,
    lastUpdatedAt: dataUpdatedAt ?? 0,
  });

  const isFetchingRef = useRef(Boolean(isFetching));
  isFetchingRef.current = Boolean(isFetching);

  // 切换刷新间隔时立即重置周期
  useEffect(() => {
    const st = stateRef.current;
    st.phase = "running";
    st.cycleStartMs = Date.now();
    st.currentP = 0;
  }, [intervalMs]);

  // 监听数据到达：触发 closing 阶段，确保必定先走满 100% 再归零并同步更新数字
  useEffect(() => {
    if (!dataUpdatedAt) return;
    const st = stateRef.current;
    if (st.lastUpdatedAt === 0) {
      st.lastUpdatedAt = dataUpdatedAt;
      st.cycleStartMs = Date.now();
      setDisplayRate(latestRateRef.current);
      return;
    }
    if (dataUpdatedAt !== st.lastUpdatedAt) {
      st.lastUpdatedAt = dataUpdatedAt;
      st.phase = "closing";
      st.closeStartMs = Date.now();
      st.closeFromP = st.currentP;
    }
  }, [dataUpdatedAt]);

  // 测量胶囊尺寸
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 主驱动循环（33ms ≈ 30fps，纯 DOM 直写，零 React 重渲染）
  useEffect(() => {
    if (!dataUpdatedAt) {
      if (countdownRef.current) countdownRef.current.textContent = "—";
      return;
    }

    const applyVisual = (p: number, cdText: string) => {
      const clamped = Math.max(0, Math.min(1, p));
      const ring = ringRef.current;
      if (ring) {
        ring.setAttribute(
          "stroke-dasharray",
          `${(clamped * PATH_SCALE).toFixed(2)} ${PATH_SCALE}`,
        );
        ring.setAttribute("data-p", clamped.toFixed(4));
      }
      const bar = barRef.current;
      if (bar) {
        bar.style.width = `${(clamped * 100).toFixed(2)}%`;
      }
      if (countdownRef.current && countdownRef.current.textContent !== cdText) {
        countdownRef.current.textContent = cdText;
      }
      if (trackRef.current) {
        trackRef.current.setAttribute("data-p", clamped.toFixed(4));
        trackRef.current.setAttribute("data-phase", stateRef.current.phase);
      }
    };

    const tick = () => {
      const now = Date.now();
      const st = stateRef.current;

      if (st.phase === "closing") {
        const dt = now - st.closeStartMs;
        if (dt < CLOSE_DURATION_MS) {
          // 线性补满最后一段至 1.000
          const t = Math.max(0, Math.min(1, dt / CLOSE_DURATION_MS));
          const p = st.closeFromP + (1 - st.closeFromP) * t;
          st.currentP = p;
          applyVisual(p, "0.0s");
          return;
        }
        // 已确保渲染出 100% 满圈（至少 1 帧），同步更新文字并立即归零进入下一轮
        if (st.currentP < 1) {
          st.currentP = 1;
          applyVisual(1, "0.0s");
          return;
        }
        setDisplayRate(latestRateRef.current);
        st.phase = "running";
        st.cycleStartMs = now;
        st.currentP = 0;
        applyVisual(0, `${(intervalMs / 1000).toFixed(1)}s`);
        return;
      }

      // running 阶段：
      // 0 -> intervalMs 内匀速推到 0.92；之后（请求在途等待期）指数渐近趋向 0.992，永不停顿
      const elapsed = Math.max(0, now - st.cycleStartMs);
      const kneeP = 0.92;
      let p: number;
      if (elapsed <= intervalMs) {
        p = (elapsed / intervalMs) * kneeP;
      } else {
        const overtime = elapsed - intervalMs;
        const tau = Math.max(600, intervalMs * 0.15);
        p = kneeP + (0.992 - kneeP) * (1 - Math.exp(-overtime / tau));
      }
      st.currentP = p;

      const remainingMs = Math.max(0, intervalMs - elapsed);
      const cdText =
        remainingMs > 0 && !isFetchingRef.current
          ? `${(remainingMs / 1000).toFixed(1)}s`
          : "0.1s";

      applyVisual(p, cdText);
    };

    tick();
    const id = window.setInterval(tick, 33);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [dataUpdatedAt, intervalMs, size.w, size.h]);

  const d = buildTopMidPillPath(size.w, size.h, 1);

  return (
    <Hint
      className="w-[318px]"
      content={
        <div>
          <HintText title="实时 Token 速度">
            最近 <span className="font-medium text-foreground">{windowSec} 秒</span>
            内完成调用的输出，按解码段摊分后 ÷ 有调用在跑的墙钟时间（含预填充）；
            多会话并行时叠加，没人跑就是 0。
          </HintText>

          {displayRate ? (
            <>
              <div className="mt-2.5 space-y-1 border-t border-border/60 pt-2">
                <RateRow
                  label="总速度"
                  value={`${fmtSpeed(displayRate.activeTokensPerSec)} tok/s`}
                />
                <RateRow
                  label="解码速度"
                  value={`${fmtSpeed(displayRate.decodeTokensPerSec)} tok/s`}
                />
                <RateRow
                  label="并发"
                  value={`${displayRate.concurrency.toFixed(2)}× · 忙碌 ${activeSecs.toFixed(1)}s`}
                />
                <RateRow label="输出" value={`${fmtNumber(displayRate.outputTokens)} tokens`} />
                <RateRow
                  label="输入"
                  value={`${fmtNumber(displayRate.inputTokens)}（缓存读 ${fmtNumber(displayRate.cacheReadTokens)}）`}
                />
                <RateRow
                  label="完成"
                  value={`${displayRate.requests} 个请求 · ${displayRate.sessions} 个会话`}
                />
                <RateRow label="采样" value={fmtTimestamp(displayRate.sampledAt)} />
                <RateRow label="下次刷新" value={`${windowSec}.0s`} valueRef={countdownRef} />
              </div>
              <div
                aria-hidden
                className="mt-1 h-[2px] w-full overflow-hidden rounded-full bg-border/50"
              >
                <div
                  ref={barRef}
                  className="h-full rounded-full bg-[var(--cds-clay)]/70"
                  style={{ width: "0%" }}
                />
              </div>
              <p className="mt-2 border-t border-border/60 pt-2 text-[10.5px] leading-relaxed text-muted-foreground">
                总速度 = 输出 ÷ 忙碌墙钟，与总览「总速度」同口径；解码速度 = 输出 ÷
                解码时长（DSH 底栏同口径）；并发 = Σ耗时 ÷ 忙碌并集。输入不计入主数字。
              </p>
            </>
          ) : (
            <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground">
              等待第一份快照。
            </p>
          )}
        </div>
      }
    >
      <div
        ref={trackRef}
        role="status"
        aria-label={`实时 Token 速度 ${displayRate ? `${fmtSpeed(speed)} tok/s` : "未知"}`}
        className={cn(
          "relative flex h-7 select-none items-center gap-1 rounded-full px-2.5",
          "bg-[var(--cds-segmented-track)] transition-colors",
        )}
      >
        {d && (dataUpdatedAt ?? 0) > 0 && (
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0"
            width={size.w}
            height={size.h}
          >
            <path
              d={d}
              fill="none"
              stroke="var(--cds-border)"
              strokeOpacity={0.45}
              strokeWidth={1}
            />
            <path
              ref={ringRef}
              d={d}
              pathLength={PATH_SCALE}
              fill="none"
              stroke="var(--cds-clay)"
              strokeOpacity={0.65}
              strokeWidth={1}
              strokeDasharray={`0 ${PATH_SCALE}`}
            />
          </svg>
        )}
        <span
          className={cn(
            "inline-block min-w-[5ch] text-right text-[12px] leading-none font-medium tabular-nums",
            active ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {value}
        </span>
        <span className="text-[10px] leading-none text-muted-foreground">tok/s</span>
      </div>
    </Hint>
  );
}

/**
 * 构造以「顶部中点」为原生起点、顺时针闭合的胶囊路径。
 * 配合 pathLength=1000，无需计算周长与 strokeDashoffset，p=1 时在顶部中点 100% 严密闭合。
 */
function buildTopMidPillPath(w: number, h: number, stroke: number): string {
  if (w <= 0 || h <= 0) return "";
  const half = stroke / 2;
  const r = Math.max(0, (h - stroke) / 2);
  const left = half + r;
  const right = Math.max(left, w - half - r);
  const top = half;
  const bottom = h - half;
  const midX = w / 2;

  return [
    `M ${midX} ${top}`,
    `H ${right}`,
    `A ${r} ${r} 0 0 1 ${right} ${bottom}`,
    `H ${left}`,
    `A ${r} ${r} 0 0 1 ${left} ${top}`,
    `Z`,
  ].join(" ");
}

/** 速率：纯数字 + 1 位小数（4 位整数 + 小数点 + 1 位，正好 5 个数字位；不带千分位逗号） */
const fmtSpeed = (n: number) => n.toFixed(1);

function RateRow({
  label,
  value,
  valueRef,
}: {
  label: string;
  value: string;
  valueRef?: React.RefObject<HTMLSpanElement>;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span ref={valueRef} className="tabular-nums text-popover-foreground">
        {value}
      </span>
    </div>
  );
}
