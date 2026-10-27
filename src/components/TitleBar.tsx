import { useEffect, useState, type ReactNode } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { appWindow, toggleMaximize } from "@/lib/window";
import { cn } from "@/lib/utils";

/**
 * 内容列顶栏：页面标题 + 业务控件 + 窗口按钮。
 *
 * 与侧栏共用同一块底色，默认没有分隔线；只有内容滚动后，底部才浮出一条
 * 两端淡出的发丝线，让顶栏在静止时彻底融进画布，滚动时又有清晰的边界。
 * 顶行 44px，与侧栏身份区同高；窗口左侧只有侧栏一个身份区。
 */
export function TitleBar({
  title,
  hint,
  busy,
  scrolled,
  children,
}: {
  title: string;
  hint: string;
  busy?: boolean;
  /** 内容列是否已离开顶部；由 App 的滚动容器给出 */
  scrolled?: boolean;
  children?: ReactNode;
}) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const w = appWindow();
    if (!w) return;
    let unlisten: (() => void) | undefined;
    w.isMaximized()
      .then(setMaximized)
      .catch(() => undefined);
    w.onResized(() => {
      w.isMaximized()
        .then(setMaximized)
        .catch(() => undefined);
    })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const act = (kind: "minimize" | "maximize" | "close") => {
    const w = appWindow();
    if (!w) return;
    if (kind === "minimize") void w.minimize();
    if (kind === "maximize") void w.toggleMaximize();
    if (kind === "close") void w.close();
  };

  return (
    <header
      data-scrolled={scrolled ? "true" : "false"}
      className="relative z-40 flex h-11 shrink-0 items-stretch bg-background select-none"
    >
      <div
        data-tauri-drag-region
        className="flex h-full min-w-0 flex-1 items-center gap-2 pl-5 pr-3"
        onDoubleClick={toggleMaximize}
      >
        <span
          key={title}
          data-tauri-drag-region
          className="title-swap truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground"
        >
          {title}
        </span>
        <span
          key={hint}
          data-tauri-drag-region
          className="title-swap hidden min-w-0 truncate text-[11px] text-muted-foreground sm:inline"
        >
          {hint}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1 pr-2">{children}</div>

      <div className="flex shrink-0 items-center gap-0.5 px-1.5">
        <span aria-hidden className="mx-1 h-3.5 w-px bg-border/70" />
        <WinButton label="最小化" onClick={() => act("minimize")}>
          <Minus size={13} />
        </WinButton>
        <WinButton label={maximized ? "还原" : "最大化"} onClick={() => act("maximize")}>
          {maximized ? <Copy size={11} /> : <Square size={10} />}
        </WinButton>
        <WinButton label="关闭到托盘" danger onClick={() => act("close")}>
          <X size={13} />
        </WinButton>
      </div>

      <span aria-hidden className="header-hairline" />
      {busy && <span aria-hidden className="header-busy" />}
    </header>
  );
}

function WinButton({
  children,
  label,
  onClick,
  danger,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "inline-flex size-[30px] items-center justify-center rounded-[7px] text-muted-foreground transition-colors",
        danger
          ? "hover:bg-danger/15 hover:text-danger"
          : "hover:bg-[var(--cds-alpha-1)] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
