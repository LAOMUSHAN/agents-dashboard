import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 无边框窗口的顶栏：左侧是拖拽区（双击最大化），右侧放业务控件与窗口按钮。
 * 参考 CDS 桌面架构：45–48px 拖拽带、控件区与拖拽区物理隔离。
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
    const w = tauriWindow();
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
    const w = tauriWindow();
    if (!w) return;
    if (kind === "minimize") void w.minimize();
    if (kind === "maximize") void w.toggleMaximize();
    if (kind === "close") void w.close();
  };

  return (
    <header className="relative z-40 flex h-12 shrink-0 items-stretch border-b border-border bg-surface-0 select-none">
      <div
        data-tauri-drag-region
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 px-3"
        onDoubleClick={() => act("maximize")}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-clay-soft text-[11px] font-bold text-clay">
          A
        </span>
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[12px] font-semibold">{title}</span>
          <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">{hint}</span>
        </div>
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

/** 浏览器里跑 Vite 时没有 Tauri 运行时，返回 null 让按钮静默降级 */
function tauriWindow() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  return getCurrentWindow();
}
