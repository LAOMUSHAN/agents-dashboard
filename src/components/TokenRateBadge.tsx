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
 * 读数拉到万级。输入只作为悬停卡里的参考量。
 *
 * 分母刻意不用整个刷新窗口：5 个对话各跑 10 秒、窗口 120 秒，5000 输出 ÷ 120
 * 会把 500 摊成 41（虚低）。并集只统计真正有调用在跑的墙钟。
 *
 * 展示只留数字 + 单位：没有状态点，宽度按「4 位整数 + 1 位小数」自然撑开，
 * 不预留空白。
 */
export function TokenRateBadge({
  rate,
  windowSec,
  pending,
}: {
  rate: TokenRate | null;
  /** 采样窗口（秒）= 当前刷新间隔 */
  windowSec: number;
  /** 首次取数中；此时还没有任何快照 */
  pending?: boolean;
}) {
  const speed = rate?.activeTokensPerSec ?? 0;
  const active = speed > 0;
  const value = rate ? fmtSpeed(speed) : pending ? "…" : "—";
  const activeSecs = (rate?.activeMs ?? 0) / 1000;

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
        role="status"
        aria-label={`实时 Token 速度 ${rate ? `${fmtSpeed(speed)} tok/s` : "未知"}`}
        className={cn(
          "flex h-7 select-none items-center gap-1 rounded-full px-2.5",
          "bg-[var(--cds-segmented-track)] transition-colors",
        )}
      >
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
