# CHANGELOG

本项目遵循语义化版本。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [0.1.0] - 2026-11-09

首个移植版本。从 [dsh-chain](https://github.com/canglight/dsh-chain) 2.4.1 移植到 MaiBot。

### 新增

- **八池分级遗忘**：核心 / 事实 / 铁律 / 经验 / 核心日常 / 片面日常 / 情绪 / 海马体，
  各自有独立的宽限、半衰期、归档线与全量注入窗口。
- **衰减公式**：`w * 0.5 ** (idle / (half_life * stretch))`，
  `stretch = min(4, 1 + 0.6·log2(1+touch_count))`，下限 0.1 保留档案底色。
- **每轮注入**：通过 `maisaka.planner.before_request` 改写 `items[0]`（SystemMessageItem）的 parts。
- **字符预算装箱**：注入量恒定，装不下的条数明写「另有 N 条未展开」。
- **两路 RRF 融合检索**：jieba IDF（阈值 9）+ 字符二元组，`1/(60+rank)` 融合。
- **索引延申**：这句话提到某条记忆里的词，就把那条的细节想起来。
- **事件溯源**：`touch` / `recall` / `supersede` / `rebalance` / `retag` 五类事件，
  状态由 `materialize` 派生。
- **元记忆** `chain_about`：被想起次数 / 人工确认次数 / 是否被取代 / 可信度。
- **情绪状态牌**：单位置覆盖，1 天半衰期，3 天过期。
- **工作记忆**：纯正则识别「还没做完的事」，最多 3 条，3 天过期，说「做完了」自动删。
- **夜巡**：9 项检查产出 Markdown 报告，默认只出建议不执行。
- 9 个工具：`chain_append` / `chain_recall` / `chain_about` / `chain_touch` /
  `chain_mood` / `chain_patrol` / `chain_graph` / `chain_triage` / `chain_stats`。
- 37 个核心算法单测。

### 变更（相对原项目）

- 注入位：`ctx.systemPrompt.section()` → `@HookHandler("maisaka.planner.before_request")`。
- 存储：JSONL → SQLite（WAL），保留事件溯源模型。
- 分词：`@node-rs/jieba` → Python `jieba`（MaiBot 已依赖，无需额外安装）。
- 夜巡复杂度：O(n²) 全量配对 → 关键词倒排索引筛候选对。
- 注入在渲染期**不再做写操作**（原项目在 `section` 回调里写海马体与 working.json）。

### 修复（上游问题）

- **「铁律」标签会掉进海马体**：`POOL_RULES` 的 skill 关键词里缺「铁律」，
  而 `classifySkill` 只有在基础池为 skill 时才被调用 —— 只写 `tags:["铁律"]` 的记忆
  会静默落进原料缓冲区（永不注入）。现已把「铁律/必须/不许/红线/禁止」加入 skill 关键词，
  并让 `classify_skill` 同时检查标签与正文。
- **注入段内同步写操作会打穿 prompt 缓存**：渲染改为真纯函数（同样输入同样输出）。

### 未移植

- 3D 星云可视化（`client.js`，1912 行前端渲染）
- 自动唤醒（`wake.mjs`，DSH 特有 HTTP 投递）
- 感知层（`perceive.js`，上游标注「只记录、不改变行为」的半成品）
- 导入器（`import.js`，DSH 特定迁移路径）

### 已知限制

- 换个说法仍可能检索不到（关键词 + 二元组补不了语义鸿沟）。
- 工作记忆只认显式说法，「可能」「也许」抓不到。
- 情绪判定为关键词级，粗粒度。
- **尚未在真实 MaiBot 环境验证**：核心算法有单测，注入层需实机联调。

## [0.2.0] - 2026-11-10

可视化面板 + 全中文配置。

### 新增

- **WebUI 声明式面板（协议 2）**，三个页面：
  - **思维链概览** —— 总数/生效/被想起/核心池占用四个指标卡，八个池的分布柱状图，
    最近写下的判断表格，以及可折叠的「八个池分别活多久」对照表。
  - **记忆列表** —— 按池筛选 + 关键词搜索，分页表格；点任意一行弹出详情，
    展开可看完整的依据 / 犹豫 / 结论；底部还有「手动写一条」表单。
  - **夜巡报告** —— 一键跑夜巡，展开完整报告；没有报告时显示引导文案而不是报错。
- 6 个 WebUI 数据接口：`webui_overview` / `webui_memories` / `webui_detail` /
  `webui_patrol` / `webui_run_patrol` / `webui_append`。
- 插件图标 `assets/icon.svg`（八池环 + 中心节点）。

### 变更

- **配置项全部改为中文**。`Field(description=...)` 只用于代码内注释，
  界面标题改走 `json_schema_extra={"label": "..."}`，补充 `hint` 说明；
  配置节标题由 `__ui_label__` 提供。

### 修复（WebUI 协议差异）

- **协议版本**：宿主已升级到 WebUI 协议 2，`schema_version` 必须为 `2`，
  否则整个 webui.json 被拒绝（"WebUI 协议已升级为 2"）。
- **下拉选项不能为空字符串**：`select.options[].value` 至少 1 个字符，
  「全部」项的 value 改为 `all`，后端把 `all` 与空串都当成不筛选。
- **条件字段名**：`equals` 用 `expected` 而不是 `value`；节点标题是 `label` 不是 `labels`。
