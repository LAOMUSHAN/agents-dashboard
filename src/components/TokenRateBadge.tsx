import { useEffect, useRef, useState } from "react";
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
 * 进度由 requestAnimationFrame 直接写 SVG 属性，不经过 React 渲染——早先用
 * 200ms 的 setInterval 改 state，每跳都会重渲染整个悬停卡内容，主线程一忙回调就
 * 迟到，视觉上就是「停住—猛跳」。文字倒计时仍走 state，但只在整 0.1 秒变化时更新。
 *
 * 展示只留数字 + 单位：没有状态点，宽度按「4 位整数 + 1 位小数」自然撑开。
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
  const ringRef = useRef<SVGRectElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [countdown, setCountdown] = useState("—");

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

  // 进度：rAF 直写 DOM，零 React 重渲染；文字每秒级更新一次
  useEffect(() => {
    if (!updatedAt || perimeter <= 0) {
      setCountdown("—");
      return;
    }
    let raf = 0;
    let lastText = "";
    const tick = () => {
      const elapsed = Math.max(0, Date.now() - updatedAt);
      const p = Math.min(1, elapsed / intervalMs);
      const ring = ringRef.current;
      if (ring) {
        ring.setAttribute("stroke-dasharray", `${perimeter * p} ${perimeter}`);
        // 走满 = 已到刷新点、正在等新数据，描边提亮一档表示「刷新中」
        ring.setAttribute("stroke-opacity", p >= 1 ? "0.85" : "0.55");
      }
      const bar = barRef.current;
      if (bar) {
        bar.style.width = `${p * 100}%`;
        bar.style.opacity = p >= 1 ? "0.85" : "0.55";
      }
      const remaining = intervalMs - elapsed;
      const text = remaining > 0 ? `${(remaining / 1000).toFixed(1)}s` : "刷新中…";
      if (text !== lastText) {
        lastText = text;
        setCountdown(text);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [updatedAt, intervalMs, perimeter]);

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
                <RateRow label="下次刷新" value={countdown} />
              </div>
              <div
                aria-hidden
                className="mt-1 h-[2px] w-full overflow-hidden rounded-full bg-border/50"
              >
                <div
                  ref={barRef}
                  className="h-full rounded-full bg-[var(--cds-clay)]"
                  style={{ width: "0%", opacity: 0.55 }}
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

function RateRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-popover-foreground">{value}</span>
    </div>
  );
}
