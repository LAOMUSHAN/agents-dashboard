import { QueryCache, QueryClient } from "@tanstack/react-query";

/**
 * 全局服务端状态缓存。
 *
 * 数据来自本机 SQLite / DSH 索引，不是网络，所以 networkMode 固定 always：
 * 避免 WebView 偶发报 offline 时把本地查询暂停。
 * 其余默认值按桌面应用收紧：不重试、不在窗口聚焦/重连时自动重拉，
 * 刷新节奏完全由 useDashboardQuery 的 refetchInterval 控制。
 */
export const queryClient = new QueryClient({
  // 失败原因同时留在界面上（App 的 loadError）和 console，方便回看查询 key
  queryCache: new QueryCache({
    onError: (error, query) => {
      console.error("查询失败", query.queryKey, error);
    },
  }),
  defaultOptions: {
    queries: {
      networkMode: "always",
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 0,
    },
  },
});
