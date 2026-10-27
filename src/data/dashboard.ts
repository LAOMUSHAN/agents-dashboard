import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import type { DashboardPayload } from "../../shared/types";
import { api } from "../api";
import type { Committed } from "./committed";
import type { DashboardRequest } from "./requests";

/** 请求与响应一起提交的仪表盘快照；所有总览视图都从这里取数 */
export type DashboardSnapshot = Committed<DashboardRequest, DashboardPayload>;

export const dashboardKeys = {
  all: ["dashboard"] as const,
  /**
   * 查询身份 = 请求描述。范围、自定义日期、数据源、实时速度窗口任何一项变化
   * 都会得到新 key；同一 key 的定时刷新不会触发视图重挂载。
   * rateWindowSec 也在 key 里：改刷新间隔要立刻按新窗口取一次数，
   * 但视图重挂载用的是 dashboardViewKey（不含它），所以不会重播入场动画。
   */
  request: (request: DashboardRequest) =>
    [
      "dashboard",
      request.source,
      request.preset,
      request.range.from ?? null,
      request.range.to ?? null,
      request.customFrom,
      request.customTo,
      request.rateWindowSec,
    ] as const,
};

/**
 * 视图重挂载用的稳定 key（包含数据源，因为「全部」范围的行数也可能随源变化）。
 * 只有范围/数据源变化才变；改刷新间隔、同一请求的后台刷新都不会重播入场动画。
 */
export function dashboardViewKey(request: DashboardRequest): string {
  return JSON.stringify([
    request.source,
    request.preset,
    request.range.from ?? null,
    request.range.to ?? null,
    request.customFrom,
    request.customTo,
  ]);
}

export function dashboardQuery(request: DashboardRequest) {
  return queryOptions({
    queryKey: dashboardKeys.request(request),
    // 关键：响应把请求一起带回来。新 key 加载期间 placeholderData 返回的是
    // 上一个快照（含它自己的 request），视图因此不会拿新范围去套旧数据。
    queryFn: async (): Promise<DashboardSnapshot> => ({
      request,
      data: await api.dashboard(request.range, request.source, request.rateWindowSec),
    }),
    placeholderData: keepPreviousData,
  });
}

export function useDashboardQuery(
  request: DashboardRequest,
  options: { enabled: boolean; refetchInterval: number | false },
) {
  return useQuery({
    ...dashboardQuery(request),
    enabled: options.enabled,
    refetchInterval: options.refetchInterval,
    // 窗口可见但未聚焦（例如放在副屏）时仍按设定刷新；
    // 隐藏到托盘由 enabled/refetchInterval 一起停掉，不会留下后台活动。
    refetchIntervalInBackground: true,
    // 切窗/截图恢复焦点时不要插一次计划外刷新：它会打断倒计时周期，
    // 让进度环在任意位置被重置。
    refetchOnWindowFocus: false,
  });
}
