/** 本地日界相关的纯函数；服务端 SQL 也用 'localtime'，两边口径一致 */
export const DAY_MS = 86_400_000;

/** 某一时刻所在本地日期的零点 */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 按本地日历加减天数（跨夏令时也落在零点，不用固定 24h 平移） */
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** 下一个本地零点；用于安排跨天刷新 */
export function nextMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}
