import type { ReactElement, ReactNode } from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * 统一的小提示卡外观。
 *
 * 与活跃时段的悬停卡同一套壳：圆角、popover 背景、细边框、阴影、毛玻璃。
 * 需要富内容（模型用量等）时直接往里放；纯文字提示用 <Hint> 即可。
 */
export function HintCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-hint-card
      className={cn(
        "rounded-xl border border-border/70 bg-popover/95 p-3 text-popover-foreground shadow-popover backdrop-blur-md",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * 统一的 hover 提示。默认向下弹出，空间不足时由 Radix 自动翻转/避让。
 *
 * 用法：把唯一的触发元素作为 children（必须能接收 ref），标题/说明放进 content。
 * 触发元素上不要再写 title，避免原生 tooltip 和卡片同时出现。
 */
export function Hint({
  content,
  children,
  side = "bottom",
  align = "start",
  openDelay = 260,
  closeDelay = 150,
  className,
}: {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  openDelay?: number;
  closeDelay?: number;
  /** 卡片宽度等，例如 "w-[280px]" */
  className?: string;
}) {
  return (
    <HoverCardPrimitive.Root openDelay={openDelay} closeDelay={closeDelay}>
      <HoverCardPrimitive.Trigger asChild>{children}</HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className="z-[70] outline-none"
        >
          <div
            className="heat-tip-in"
            style={{ transformOrigin: side === "top" ? "bottom center" : "top center" }}
          >
            <HintCard className={className}>{content}</HintCard>
          </div>
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  );
}

/** 纯文字提示的统一排版：小标题 + 正文 */
export function HintText({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div>
      {title && (
        <div className="text-[10px] font-medium tracking-[0.04em] text-muted-foreground">{title}</div>
      )}
      <div className={cn("text-[11px] leading-relaxed text-popover-foreground", title && "mt-1")}>
        {children}
      </div>
    </div>
  );
}
