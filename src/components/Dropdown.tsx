import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type DropdownOption<T extends string | number> = {
  value: T;
  label: string;
  icon?: ComponentType<{ size?: number | string }>;
  /** 选中后不收起菜单(如"自定义"需继续操作附加区域) */
  keepOpen?: boolean;
};

type DropdownProps<T extends string | number> = {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  /** 触发器左侧图标,与选项内图标区分开 */
  icon?: ComponentType<{ size?: number | string }>;
  /** 附加区域:渲染在选项列表下方,点击不会收起菜单;函数形式可拿到 close 主动收起 */
  extra?: ReactNode | ((api: { close: () => void }) => ReactNode);
  /** 菜单向上展开(控件位于界面底部时用) */
  dropUp?: boolean;
  title?: string;
};

/** 胶囊样式自定义下拉:替代原生 <select>,统一刷新间隔与主题选择的外观 */
export function Dropdown<T extends string | number>({
  value,
  options,
  onChange,
  icon: LeadIcon,
  extra,
  dropUp,
  title,
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);
  // 函数形式的 extra 先求值:内容为空时不渲染容器,避免留下孤立的分隔线
  const extraNode = !extra
    ? null
    : typeof extra === "function"
      ? extra({ close: () => setOpen(false) })
      : extra;

  useEffect(() => {
    if (!open) return;
    setHighlight(Math.max(0, options.findIndex((o) => o.value === value)));
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, options, value]);

  // 焦点始终留在触发器上,方向键移动高亮、回车提交
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((h) => ((h + step) % options.length + options.length) % options.length);
    } else if ((e.key === "Enter" || e.key === " ") && open && highlight >= 0) {
      e.preventDefault();
      onChange(options[highlight].value);
      if (!options[highlight].keepOpen) setOpen(false);
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        {LeadIcon && <LeadIcon size={13} />}
        <span>{selected?.label}</span>
        <ChevronDown size={13} className="opacity-70 transition-transform" style={{ transform: open ? "rotate(180deg)" : undefined }} />
      </button>
      {open && (
        <div
          className={
            "cds-pop absolute right-0 z-50 min-w-36 rounded-panel bg-popover p-1 shadow-popover " +
            (dropUp ? "bottom-full mb-1 origin-bottom" : "mt-1 origin-top")
          }
        >
          <div role="listbox">
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-foreground transition-colors",
                  i === highlight && "bg-accent",
                  o.value === value && "font-medium text-clay",
                )}
                onPointerEnter={() => setHighlight(i)}
                onClick={() => {
                  onChange(o.value);
                  if (!o.keepOpen) setOpen(false);
                }}
              >
                {o.icon && <o.icon size={13} />}
                {o.label}
                {o.value === value && <Check size={13} className="ml-auto text-clay" />}
              </button>
            ))}
          </div>
          {extraNode && <div className="mt-1 border-t border-border pt-1">{extraNode}</div>}
        </div>
      )}
    </div>
  );
}
