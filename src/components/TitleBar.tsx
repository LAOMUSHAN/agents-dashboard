import { useEffect, useState, type ReactNode } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { appWindow, toggleMaximize } from "@/lib/window";
import { cn } from "@/lib/utils";

/**
 * 内容列顶栏：页面标题 + 业务控件 + 窗口按钮。
 *
 * 它属于右侧内容列，不再横跨整窗——侧栏是独立的全高列（见 Sidebar），
 * 两者顶行同为 48px，共用一条竖分隔线，窗口左侧因此只有一个身份区。
 */
export function TitleBar({
  title,
  hint,
  busy,
  children,
}: {
  title: string;
  hint: string;
  busy?: boolean;
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
    <header className="relative z-40 flex h-12 shrink-0 items-stretch border-b border-border bg-background select-none">
      <div
        data-tauri-drag-region
        className="flex h-full min-w-0 flex-1 items-center gap-2 pl-5 pr-3"
        onDoubleClick={toggleMaximize}
      >
        <span
          data-tauri-drag-region
          className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground"
        >
          {title}
        </span>
        <span
          data-tauri-drag-region
          className="hidden min-w-0 truncate text-[11.5px] text-muted-foreground sm:inline"
        >
          {hint}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 px-3">{children}</div>

      <div className="flex shrink-0 items-center gap-0.5 border-l border-border px-1.5">
        <WinButton label="最小化" onClick={() => act("minimize")}>
          <Minus size={14} />
        </WinButton>
        <WinButton label={maximized ? "还原" : "最大化"} onClick={() => act("maximize")}>
          {maximized ? <Copy size={12} /> : <Square size={11} />}
        </WinButton>
        <WinButton label="关闭到托盘" danger onClick={() => act("close")}>
          <X size={14} />
        </WinButton>
      </div>

      {busy && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
          <div className="h-full w-full animate-pulse bg-clay/55" />
        </div>
      )}
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
        "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors",
        danger ? "hover:bg-danger/15 hover:text-danger" : "hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
