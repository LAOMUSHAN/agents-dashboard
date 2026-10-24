import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HintCard } from "./hint";

type HintState = {
  text: string;
  anchor: { left: number; top: number; bottom: number };
};

type Position = {
  left: number;
  top: number;
  placement: "top" | "bottom";
};

const SHOW_DELAY = 350;
const GAP = 6;
const MARGIN = 12;

/**
 * 把应用里所有原生 title 提示升级成统一卡片。
 *
 * 事件委托只注册一次：悬停到 [title] 时先摘掉 title（阻止浏览器原生 tooltip），
 * 350ms 后按统一 HintCard 样式在下方弹出；移出/滚动/点击/ESC 时恢复 title。
 * 截断兜底、状态徽标、图标按钮、图表微型说明都走这里，后续新增 title 也自动生效。
 */
export function TitleHintProvider() {
  const [hint, setHint] = useState<HintState | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const activeRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;

    const clearTimer = () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const restoreActive = () => {
      const el = activeRef.current;
      const text = titleRef.current;
      activeRef.current = null;
      titleRef.current = null;
      if (el && text != null && el.isConnected) el.setAttribute("title", text);
    };

    const hide = () => {
      clearTimer();
      setHint(null);
      setPos(null);
      restoreActive();
    };

    const show = (el: HTMLElement, text: string) => {
      if (disposed || activeRef.current !== el) return;
      const rect = el.getBoundingClientRect();
      setPos(null);
      setHint({ text, anchor: { left: rect.left, top: rect.top, bottom: rect.bottom } });
    };

    const onOver = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // 指针落在 Rich Hint 的触发区时，事件目标可能是外层 td/li；用命中栈兜底，避免双卡。
      const under = document.elementsFromPoint(event.clientX, event.clientY);
      if (under.some((node) => node.closest("[data-hint-ignore]"))) return;
      const el = target.closest<HTMLElement>("[title]");
      if (!el || el.closest("[data-hint-card]") || el.closest("[data-hint-ignore]")) return;
      const text = el.getAttribute("title")?.trim();
      if (!text) return;
      if (activeRef.current === el) return;

      hide();
      activeRef.current = el;
      titleRef.current = text;
      el.removeAttribute("title");
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        show(el, text);
      }, SHOW_DELAY);
    };

    const onOut = (event: PointerEvent) => {
      const el = activeRef.current;
      if (!el) return;
      const related = event.relatedTarget;
      if (related instanceof Node && el.contains(related)) return;
      hide();
    };

    const onScroll = () => {
      if (activeRef.current) hide();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("pointerdown", onScroll, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    document.addEventListener("keydown", onKeyDown);

    // React 重新渲染可能把 title 加回来；悬停期间持续摘掉，避免原生 tooltip 又冒出来。
    const observer = new MutationObserver(() => {
      const el = activeRef.current;
      if (!el) return;
      if (!el.isConnected) {
        hide();
        return;
      }
      if (el.hasAttribute("title")) {
        const text = el.getAttribute("title")?.trim();
        if (text) {
          titleRef.current = text;
          el.removeAttribute("title");
          setHint((current) => (current ? { ...current, text } : current));
        }
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["title"], subtree: true });

    return () => {
      disposed = true;
      clearTimer();
      restoreActive();
      observer.disconnect();
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("pointerdown", onScroll, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useLayoutEffect(() => {
    if (!hint || !cardRef.current) {
      setPos(null);
      return;
    }
    const card = cardRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = hint.anchor.left;
    if (left + card.width > vw - MARGIN) left = vw - MARGIN - card.width;
    left = Math.max(MARGIN, left);

    let top = hint.anchor.bottom + GAP;
    let placement: "top" | "bottom" = "bottom";
    if (top + card.height > vh - MARGIN) {
      const above = hint.anchor.top - GAP - card.height;
      if (above >= MARGIN) {
        top = above;
        placement = "top";
      } else {
        top = Math.max(MARGIN, vh - MARGIN - card.height);
      }
    }
    setPos({ left, top, placement });
  }, [hint]);

  if (!hint) return null;

  return createPortal(
    <div
      ref={cardRef}
      data-title-hint
      className="pointer-events-none fixed z-[80]"
      style={{
        left: pos?.left ?? hint.anchor.left,
        top: pos?.top ?? hint.anchor.bottom + GAP,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div
        className="heat-tip-in"
        style={{ transformOrigin: pos?.placement === "top" ? "bottom center" : "top center" }}
      >
        <HintCard className="max-w-[340px] min-w-[140px]">
          <div className="whitespace-pre-line break-words text-[11px] leading-relaxed text-popover-foreground">
            {hint.text}
          </div>
        </HintCard>
      </div>
    </div>,
    document.body,
  );
}
