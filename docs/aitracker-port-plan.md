# AITracker 特色功能移植计划（已批准,2026-09-09）

基线：P1–P4 UI 迁移完成后。每阶段独立 commit 可回退。

## A. 导航左置布局
固定左侧 `<aside>`（展开 180px / 收起 64px，底部切换钮，<1120px 自动收起），品牌区 + 垂直导航 5 项 + 底部钉住收起按钮；内容区 paddingLeft 让位；顶栏保留日期/刷新/主题控件。

## B. 洞察卡 + 缓存节省 KPI + 浪费指数排行（纯前端）
- InsightCard：规则文案轮播（最活跃模型/缓存命中率提醒/费用摘要/解码最快/代理多样性），右侧 缓存命中率 + 节省金额（savings = Σ cacheReadTokens×(price.input−price.cache_read)/1e6）
- WasteRankPanel：指数 = 100×(1−缓存命中率)×输出占比；项目/模型/供应商三视图，指数条形+分项+建议文案

## C. Agent 对比 + 上下文构成
- 后端 `get_agent_stats`（GROUP BY agent，含 DECODE_SUMS 与 AVG ttft）→ `AgentStat`
- AgentStatsPanel：代理对比表+调用量条形
- ContextComposition：token 构成（输入/输出/推理）+ 工具调用分类（Shell/文件/MCP/Skill/Web/代理协作，按 tool_name 前缀归类，数据源 tools[]）

## D. 12 个月日历 + 月粒度趋势
- 后端 `get_activity_daily`（按天聚合全状态）与 `get_monthly_trend`（月分桶+费用折算+速度）
- YearCalendar：GitHub 风格 12 个月日历格子
- TrendChart 加 粒度切换（时/日/月），月视图图例行带 峰值月份 与 MoM

## P5 收尾
mini 换肤；清理 styles.css 无引用旧类（保留 mini 与日历浮层引用）；cargo test + tsc + vite build + tauri build 验收。

## 不做
Skill 蒸馏/记忆库/安全扫描/简报；按会话聚合浪费指数；skill 名称解析（part 表另立项）。
