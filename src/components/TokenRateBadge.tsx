import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { TokenRate } from "../../shared/types";
import { fmtNumber, fmtTimestamp } from "../format";
import { Hint, HintText } from "./ui/hint";
import { cn } from "@/lib/utils";

/**
 * 顶栏实时 Token 速度（总速度口径）。
 *
 * 主数字 = 窗口内**输出**摊分到解码段后 ÷ 「窗口内有调用在跑的墙钟并集」。
 * 与总览「总速度」（输出 ÷ LLM 耗时）同口径：单请求约 100 tok/s，N 个对话真正
 * 同时跑就是约 N × 100；窗口内没有调用在跑就是 0。
 *
 * 分子刻意不含输入：DSH 一次调用输入 60k–180k（94%–99% 是缓存读），算进去会把
 * 读数拉到万级。分母刻意不用整个刷新窗口：5 个对话各跑 10 秒、窗口 120 秒，
 * 5000 输出 ÷ 120 会把 500 摊成 41（虚低）。
 *
 * 描边是一圈**正向**倒计时进度：起点在上边中点、顺时针增长、刷新归零。
 * 进度由 **CSS 动画**驱动（`rate-ring-fill`），走合成线程：早先试过 200ms 的
 * setInterval 改 state（每次跳都重渲染整个悬停卡）和 requestAnimationFrame 直写
 * 属性（窗口被遮挡时 rAF 被 WebView2 节流到 1fps 甚至暂停），两者都会让进度
 * 「停住—猛跳」。CSS 动画不受主线程与 rAF 节流影响，刷新时靠 key 重挂载重启动画。
 *
 * 文字倒计时用 ref 直写 textContent，同样不触发 React 渲染。
 */
export function TokenRateBadge({
  rate,
  windowSec,
  updatedAt,
  pending,
}: {
  rate: TokenRate | null;
  /** 采样窗口（秒）= 当前刷新间隔 */
  windowSec: number;
  /** 最近一次成功取数的时间（epoch ms）；0/缺省时不画倒计时 */
  updatedAt?: number;
  /** 首次取数中；此时还没有任何快照 */
  pending?: boolean;
}) {
  const speed = rate?.activeTokensPerSec ?? 0;
  const active = speed > 0;
  const value = rate ? fmtSpeed(speed) : pending ? "…" : "—";
  const activeSecs = (rate?.activeMs ?? 0) / 1000;
  const intervalMs = Math.max(1, windowSec) * 1000;

  const trackRef = useRef<HTMLDivElement>(null);
  const countdownRef = useRef<HTMLSpanElement>(null);
  const ringRef = useRef<SVGRectElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [countdown, setCountdown] = useState("—");

  // 真实刷新周期 = 间隔 + 请求耗时。dataUpdatedAt 是「请求完成」时刻，而
  // refetchInterval 从完成时刻开始计下一轮，所以两次 updatedAt 的差就是完整周期。
  // 进度条只按 interval 走的话，走满后必然空等那几秒请求时间——这就是「卡在刷新前」。
  // 这里用相邻两次的实测间隔作为动画时长，走满时正好是新数据到达。
  const [periodMs, setPeriodMs] = useState(intervalMs);
  const prevUpdated = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!updatedAt) return;
    const prev = prevUpdated.current;
    prevUpdated.current = updatedAt;
    if (prev === undefined || updatedAt <= prev) return;
    const gap = updatedAt - prev;
    // 只接受合理区间，避免暂停/改间隔时把异常值当成周期
    if (gap >= intervalMs * 0.6 && gap <= intervalMs * 3) {
      setPeriodMs(gap);
    }
  }, [updatedAt, intervalMs]);
  useEffect(() => {
    setPeriodMs(intervalMs);
    prevUpdated.current = undefined;
  }, [intervalMs]);
  const periodSec = Math.max(1, periodMs / 1000);

  // 胶囊宽度随数字变化：量一次，之后跟 ResizeObserver
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 圆角矩形周长：两段直边 + 两个半圆。路径起点在顶边左端（左上圆角结束处），
  // 把 dash 模式向前推「半个顶边」就能让进度从顶部中点开始顺时针生长。
  const stroke = 1;
  const r = Math.max(0, (size.h - stroke) / 2);
  const straightTop = Math.max(0, size.w - stroke - 2 * r);
  const topMid = straightTop / 2;
  const perimeter =
    size.w > 0
      ? 2 * straightTop + 2 * (size.h - stroke - 2 * r) + 2 * Math.PI * r
      : 0;

  // 倒计时文字 + 恢复同步。
  //
  // 页面被遮挡/最小化时 Chromium 会把定时器节流到分钟级、并停止提交合成帧：
  // 文字停住、画面冻结在最后一帧，而 CSS 动画的时间线仍在后台推进。恢复可见后
  // 浏览器不会主动补帧，要等到下一次 React 重渲染才跳过去——表现就是「进度卡住，
  // 刷新时突然归零」。这里在三种信号上主动 resync：定时器间隔异常（被节流过）、
  // window focus、visibilitychange；resync 把动画 currentTime 拽到真实位置，
  // 并立刻刷一次文字。
  useEffect(() => {
    if (!updatedAt) {
      setCountdown("—");
      if (countdownRef.current) countdownRef.current.textContent = "—";
      return;
    }
    const text = () => {
      const remaining = periodMs - (Date.now() - updatedAt);
      const s = remaining > 0 ? `${(remaining / 1000).toFixed(1)}s` : "刷新中…";
      if (countdownRef.current && countdownRef.current.textContent !== s) {
        countdownRef.current.textContent = s;
      }
      setCountdown((prev) => (prev === s ? prev : s));
    };
    const resync = () => {
      const elapsed = Math.min(periodMs, Math.max(0, Date.now() - updatedAt));
      const ring = ringRef.current;
      const anim = ring?.getAnimations?.()[0];
      if (anim && typeof anim.currentTime === "number") {
        if (anim.playState === "finished") anim.play();
        anim.currentTime = elapsed;
        // 光设置 currentTime 不一定能让冻结过的合成器出一帧，微调透明度逼它重绘，
        // 下一帧再改回来（值本身没有视觉差异）。
        ring!.style.strokeOpacity = "0.56";
        requestAnimationFrame(() => {
          if (ring) ring.style.strokeOpacity = "";
        });
      }
      text();
    };

    text();
    let last = Date.now();
    const id = window.setInterval(() => {
      const now = Date.now();
      // 间隔明显超过 200ms，说明这段被节流过，画面大概率停在旧帧上
      if (now - last > 1000) resync();
      last = now;
      text();
    }, 200);

    // rAF 帧间隔检测：页面被遮挡时合成器停止出帧，rAF 也随之停摆；
    // 恢复后的第一帧间隔会远大于 16ms，这是「画面刚解冻」最可靠的信号。
    // 阈值取 2s，避开后台 1fps 的正常降频。
    let raf = 0;
    let lastFrame = 0;
    const watch = (ts: number) => {
      if (lastFrame && ts - lastFrame > 800) resync();
      lastFrame = ts;
      raf = requestAnimationFrame(watch);
    };
    raf = requestAnimationFrame(watch);

    window.addEventListener("focus", resync);
    document.addEventListener("visibilitychange", resync);
    return () => {
      window.clearInterval(id);
      cancelAnimationFrame(raf);
      window.removeEventListener("focus", resync);
      document.removeEventListener("visibilitychange", resync);
    };
  }, [updatedAt, periodMs]);

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

          {rate ? (
            <>
              <div className="mt-2.5 space-y-1 border-t border-border/60 pt-2">
                <RateRow label="总速度" value={`${fmtSpeed(rate.activeTokensPerSec)} tok/s`} />
                <RateRow
                  label="解码速度"
                  value={`${fmtSpeed(rate.decodeTokensPerSec)} tok/s`}
                />
                <RateRow
                  label="并发"
                  value={`${rate.concurrency.toFixed(2)}× · 忙碌 ${activeSecs.toFixed(1)}s`}
                />
                <RateRow label="输出" value={`${fmtNumber(rate.outputTokens)} tokens`} />
                <RateRow
                  label="输入"
                  value={`${fmtNumber(rate.inputTokens)}（缓存读 ${fmtNumber(rate.cacheReadTokens)}）`}
                />
                <RateRow
                  label="完成"
                  value={`${rate.requests} 个请求 · ${rate.sessions} 个会话`}
                />
                <RateRow label="采样" value={fmtTimestamp(rate.sampledAt)} />
                <RateRow
                  label="下次刷新"
                  value={countdown}
                  valueRef={countdownRef}
                />
              </div>
              <div
                aria-hidden
                className="mt-1 h-[2px] w-full overflow-hidden rounded-full bg-border/50"
              >
                {updatedAt ? (
                  <div
                    key={`${updatedAt}-${periodMs}`}
                    className="h-full rounded-full bg-[var(--cds-clay)]/70"
                    style={{
                      width: "0%",
                      animation: `rate-bar-fill ${periodSec}s linear forwards`,
                    }}
                  />
                ) : null}
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
        aria-label={`实时 Token 速度 ${rate ? `${fmtSpeed(speed)} tok/s` : "未知"}${
          updatedAt ? `，${countdown} 后刷新` : ""
        }`}
        className={cn(
          "relative flex h-7 select-none items-center gap-1 rounded-full px-2.5",
          "bg-[var(--cds-segmented-track)] transition-colors",
        )}
      >
        {perimeter > 0 && (updatedAt ?? 0) > 0 && (
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0"
            width={size.w}
            height={size.h}
          >
            <rect
              x={stroke / 2}
              y={stroke / 2}
              width={size.w - stroke}
              height={size.h - stroke}
              rx={r}
              fill="none"
              stroke="var(--cds-border)"
              strokeOpacity={0.45}
              strokeWidth={stroke}
            />
            <rect
              // 刷新一次就换 key，让 CSS 动画从头播放
              key={`${updatedAt}-${Math.round(perimeter)}-${periodMs}`}
              ref={ringRef}
              x={stroke / 2}
              y={stroke / 2}
              width={size.w - stroke}
              height={size.h - stroke}
              rx={r}
              fill="none"
              stroke="var(--cds-clay)"
              strokeOpacity={0.55}
              strokeWidth={stroke}
              strokeDasharray={`0 ${perimeter}`}
              strokeDashoffset={-topMid}
              style={
                {
                  "--rate-ring-p": perimeter,
                  animation: `rate-ring-fill ${periodSec}s linear forwards`,
                } as CSSProperties
              }
            />
          </svg>
        )}
        <span
          className={cn(
            "text-[12px] leading-none font-medium tabular-nums",
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




