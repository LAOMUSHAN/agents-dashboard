# UI 全量改造计划：shadcn 设计系统搬运（参考 AITracker 观感）

> 基线：tag `pre-ui-rewrite-baseline`（f22f0bb）。每阶段一个 commit，可独立回退。
> 原则：只动前端视觉层，Rust 后端与 shared/types 零改动；每个交互行为保持等价。

## 技术选型

- **Tailwind CSS v4 + shadcn/ui**：组件产出到 `src/components/ui/`，shadcn CLI 支持 Vite。
- 不换栈：Tauri 2 / React 18 / recharts / lucide-react（已有）全部保留。
- 主题：现有 `theme.ts` 的 auto/light/dark 映射到 shadcn 的 `.dark` class 约定；
  色板采用 AITracker 式中性基调（zinc 系）+ 单一强调色，圆角 xl、细边框、tabular-nums。

## 阶段划分

### P1 基础设施（约半天）
- 安装 tailwind v4、shadcn init、cn() 工具；新增依赖仅前端。
- 主题桥接：`theme.ts` 输出改为 class 切换；全局字体栈、滚动条、焦点环。
- 验收：`tsc` + `vite build` 绿；五个标签页 + mini 全部正常渲染，功能零变化。

### P2 卡片与表格（约 1 天，可见面最大）
- SummaryCards → Card + Badge。
- ProviderTable / ModelTable / RequestLog / LatencyPanel / ToolStatsPanel / ErrorPanel → Table + Badge。
- RequestLog 保留固定列宽、分组行、子代理缩进逻辑，单独小步迁移。
- 验收：逐页与基线截图对照，数据与交互零回归。

### P3 控件（约半天）
- 顶部导航 tabs → Tabs；chip 切换组 → ToggleGroup；Dropdown → Select；
  DateRangePicker 外壳 → Popover + Calendar（内部逻辑不动）；分页器 → Pagination。
- 验收：所有控件交互等价（含 localStorage 持久化行为）。

### P4 图表与热力图（约半天）
- TrendChart / ModelTrendChart / ProviderTrendChart 换 shadcn Chart 容器与 tooltip 皮肤，
  统一 12 色板，深浅主题自适应；ActivityHeatmap 换色。
- 只换容器/皮肤，数据管道不动。

### P5 收尾与回归（约半天）
- mini 置顶胶囊换肤；空态/加载态/徽标统一；清理 `styles.css` 残留；
  `docs/images` 截图更新；`npx tauri build` 出安装包并人工过五页。

## 风险与对策

- Tailwind preflight 与旧 styles.css 冲突 → 渐进迁移：每替换一个组件即删除其旧 CSS 类，避免双系统作用于同一元素。
- recharts 与 shadcn Chart 的 API 差异 → 只包外壳，不重写 series 配置。
- 旧类名被 className 拼接引用 → 迁移前逐文件 grep 确认引用面。

## 回退机制

- 按阶段：`git revert <阶段 commit>`。
- 整体：`git reset --hard pre-ui-rewrite-baseline`。
- 灾备：`zcode-dashbord-backup-20260909.tar.gz`（工作区根目录，1.4MB）。

## 工作量

P1–P5 合计约 2–3 个工作日；每阶段结束跑 `tsc` + `cargo test` + `vite build`，P5 另出安装包。
