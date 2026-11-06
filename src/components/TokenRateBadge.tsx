import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SourceFilter, SourceStatus, TokenRate } from "../../shared/types";
import { fmtTimestamp, fmtTokens } from "../format";
import { Hint } from "./ui/hint";
import { cn } from "@/lib/utils";

const PATH_SCALE = 1000;
const CLOSE_DURATION_MS = 120; // 数据到达后补满最后一小段至 100% 的闭环时长

/** 弹窗里的来源顺序与颜色：zcode 灰 / DSH 蓝 / Claude 陶土，与来源徽标保持一致 */
const SOURCE_ORDER = ["zcode", "dsh", "claude"] as const;
const SOURCE_META: Record<string, { label: string; color: string }> = {
  zcode: { label: "zcode", color: "var(--cds-text-muted)" },
  dsh: { label: "DSH", color: "var(--cds-dsh)" },
  claude: { label: "Claude", color: "var(--cds-clay)" },
};

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
  scope = "all",
  sources = [],
  dataUpdatedAt,
  isFetching,
  pending,
}: {
  rate: TokenRate | null;
  /** 采样窗口（秒）= 当前刷新间隔 */
  windowSec: number;
  /** 当前数据源范围：决定弹窗里列出哪些来源 */
  scope?: SourceFilter;
  /** 各来源可用性；未接入的来源显示「未接入」而不是 0 */
  sources?: SourceStatus[];
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
  const stateLabel = pending ? "等待数据" : isFetching ? "采样中" : active ? "活跃" : "空闲";

  // 弹窗按当前数据源范围列出所有来源：没有调用的来源补 0，未接入的显示「未接入」。
  // 顺序固定为 zcode → DSH → Claude，与顶部数据源切换器一致。
  const sourceRows = useMemo(() => {
    const ids = scope === "all" ? SOURCE_ORDER : [scope];
    const rates = new Map((displayRate?.bySource ?? []).map((s) => [s.source, s]));
    const statuses = new Map(sources.map((s) => [s.id, s]));
    return ids.map((id) => {
      const row = rates.get(id);
      const status = statuses.get(id);
      return {
        id,
        label: status?.label ?? SOURCE_META[id]?.label ?? id,
        color: SOURCE_META[id]?.color ?? "var(--cds-text-muted)",
        available: status?.available ?? true,
        contribution: row?.tokensPerSec ?? 0,
      };
    });
  }, [displayRate, scope, sources]);

  // 分项分母用分项之和（= 总速度）；用它算占比，堆叠条永远正好铺满
  const compositionTotal = sourceRows.reduce((sum, s) => sum + s.contribution, 0);
  // 只选一个来源时没有横向比较的必要，来源卡改成一行，避免右侧大片留白
  const singleSource = sourceRows.length === 1;

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
    // 大卡片用不透明底：HintCard 默认的半透明 + 毛玻璃会让底下的图表文字透出来
    <Hint
      className="w-[356px] bg-popover p-4"
      content={
        <div className="text-popover-foreground">
          {/* 标题行：名称 + 采样状态 */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground">
              实时 Token 速度
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  "size-[5px] rounded-full",
                  active ? "bg-[var(--cds-clay)]" : "bg-muted-foreground/40",
                  isFetching && "animate-pulse",
                )}
              />
              {stateLabel}
            </span>
          </div>

          {/* 主数字 + 窗口摘要 */}
          <div className="mt-2.5 flex items-end justify-between gap-3">
            <div className="flex items-baseline gap-1.5">
              <span
                className={cn(
                  "text-[32px] leading-[0.9] font-medium tracking-[-0.03em] tabular-nums",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {value}
              </span>
              <span className="text-[10px] text-muted-foreground">tok/s</span>
            </div>
            {displayRate && (
              <div className="pb-0.5 text-right text-[10px] leading-[1.5] text-muted-foreground">
                <div>最近 {windowSec} 秒</div>
                <div>
                  {displayRate.requests} 请求 · {displayRate.sessions} 会话
                </div>
              </div>
            )}
          </div>

          {displayRate ? (
            <>
              {/* 来源构成：一条堆叠比例条 + 三列等宽来源卡（填满横向空间） */}
              <div className="mt-3.5">
                <div className="flex h-[8px] gap-[2px] overflow-hidden rounded-full bg-[var(--cds-segmented-track)]">
                  {sourceRows.map((s) => {
                    const share = compositionTotal > 0 ? s.contribution / compositionTotal : 0;
                    if (share <= 0) return null;
                    return (
                      <span
                        key={s.id}
                        className="h-full rounded-full transition-[width] duration-500 ease-out"
                        style={{
                          width: `${share * 100}%`,
                          minWidth: 2,
                          background: s.color,
                        }}
                      />
                    );
                  })}
                </div>

                <div
                  className="mt-2 grid overflow-hidden rounded-lg border border-border/50"
                  style={{
                    gridTemplateColumns: `repeat(${sourceRows.length}, minmax(0, 1fr))`,
                  }}
                >
                  {sourceRows.map((s, i) => {
                    const share = compositionTotal > 0 ? s.contribution / compositionTotal : 0;
                    const idle = s.contribution <= 0;
                    const valueText = s.available
                      ? s.contribution > 0
                        ? fmtSpeed(s.contribution)
                        : "0.0"
                      : "—";
                    const shareText = s.available
                      ? share > 0
                        ? `${(share * 100).toFixed(1)}%`
                        : "—"
                      : "未接入";
                    const dot = (
                      <span
                        aria-hidden
                        className="size-[6px] shrink-0 rounded-full"
                        style={{
                          background: idle ? "transparent" : s.color,
                          boxShadow: idle ? `inset 0 0 0 1px ${s.color}` : undefined,
                        }}
                      />
                    );
                    const label = (
                      <span
                        className={cn(
                          "truncate text-[11px] leading-none",
                          idle ? "text-muted-foreground" : "text-foreground/90",
                        )}
                      >
                        {s.label}
                      </span>
                    );
                    return (
                      <div
                        key={s.id}
                        className={cn("min-w-0 px-2.5 py-2", i > 0 && "border-l border-border/50")}
                      >
                        {singleSource ? (
                          <div className="flex items-center gap-2">
                            {dot}
                            {label}
                            <span
                              className={cn(
                                "ml-auto text-[16px] leading-none font-medium tabular-nums",
                                idle ? "text-muted-foreground" : "text-foreground",
                              )}
                            >
                              {valueText}
                            </span>
                            <span className="w-10 text-right text-[10px] leading-none tabular-nums text-muted-foreground">
                              {shareText}
                            </span>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-1.5">
                              {dot}
                              {label}
                            </div>
                            <div
                              className={cn(
                                "mt-1.5 text-[16px] leading-none font-medium tabular-nums",
                                idle ? "text-muted-foreground" : "text-foreground",
                              )}
                            >
                              {valueText}
                            </div>
                            <div className="mt-1 text-[10px] leading-none tabular-nums text-muted-foreground">
                              {shareText}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 辅助指标：一条四列数据带，比 2×2 大格更紧凑 */}
              <div className="mt-3 grid grid-cols-4 divide-x divide-border/50 overflow-hidden rounded-lg border border-border/50">
                <StatCell
                  label="解码速度"
                  value={fmtSpeed(displayRate.decodeTokensPerSec)}
                  unit="tok/s"
                />
                <StatCell
                  label="并发"
                  value={`${displayRate.concurrency.toFixed(2)}×`}
                  sub={`忙碌 ${activeSecs.toFixed(1)}s`}
                />
                <StatCell label="输出" value={fmtTokens(displayRate.outputTokens)} unit="tokens" />
                <StatCell
                  label="输入"
                  value={fmtTokens(displayRate.inputTokens)}
                  sub={`缓存 ${fmtTokens(displayRate.cacheReadTokens)}`}
                />
              </div>

              {/* 刷新进度与采样信息 */}
              <div className="mt-3 border-t border-border/50 pt-2">
                <div className="flex items-baseline justify-between text-[11px] text-muted-foreground">
                  <span>下次刷新</span>
                  <span ref={countdownRef} className="tabular-nums text-popover-foreground">
                    {windowSec}.0s
                  </span>
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
                <div className="mt-1.5 flex items-baseline justify-between text-[10px] text-muted-foreground/80">
                  <span>采样 {fmtTimestamp(displayRate.sampledAt)}</span>
                  <span>窗口 {windowSec}s</span>
                </div>
              </div>

              <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
                分项 = 来源输出 ÷ 全体忙碌并集；合计 = 总速度，输入不计入。
              </p>
            </>
          ) : (
            <p className="mt-2.5 text-[10px] leading-relaxed text-muted-foreground">
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

function StatCell({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0 px-1.5 py-2">
      <div className="text-[11px] leading-none text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-0.5 whitespace-nowrap">
        <span className="text-[12px] leading-none font-medium tabular-nums text-popover-foreground">
          {value}
        </span>
        {unit && <span className="text-[10px] leading-none text-muted-foreground">{unit}</span>}
      </div>
      {sub && <div className="mt-0.5 truncate text-[10px] leading-none text-muted-foreground/70">{sub}</div>}
    </div>
  );
}
