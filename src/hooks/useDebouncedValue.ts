import { useEffect, useState } from "react";

/**
 * value 稳定 delayMs 后才更新返回值。
 * value 必须是稳定引用（对象用 useMemo），否则每次渲染都会重置计时器。
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (Object.is(debounced, value)) return;
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs, debounced]);

  return debounced;
}
