/**
 * 一次异步请求的完整结果：请求描述 + 响应数据，作为一个整体提交。
 *
 * 约定（这是所有数据视图的唯一入口）：
 * - 视图只能从 `request` 推导形状、标签、动画 key；
 * - 不能读当前筛选状态（时间范围、数据源等）。
 *
 * 这样数据未到时不会先画新范围的空壳，也不会出现
 * 「新范围 + 旧数据」或「旧范围 + 新标签」的错位。
 */
export interface Committed<TRequest, TData> {
  request: TRequest;
  data: TData;
}
