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

## [0.1.1] - 2026-11-09

实机适配修正。在 MaiBot 1.4.2 + SDK 2.21.0（Windows / uv 安装）上真实跑通。

### 修复

- **`HookMode` 导入路径错误**：它不在 `maibot_sdk` 顶层，而在 `maibot_sdk.types`。
  写错会在导入阶段直接 `ImportError`，插件根本加载不起来。
- **`import mai_chain` 找不到模块**：宿主插件加载器只用
  `spec_from_file_location` 加载 `plugin.py`，临时加进 `sys.path` 的是
  `plugins/`（`plugin_dir.parent`）而**不是插件自己的目录**。
  子包导入必然失败。已在 `plugin.py` 顶部把自身目录 append 进 `sys.path`。
- **manifest 字段被宿主拒绝**：`_manifest.json` 的 Pydantic schema 用
  `extra="forbid"` 严格校验，`files` / `keywords` / `changelog` 均不在白名单，
  会导致「插件注册失败」。已裁剪为白名单内的 14 个字段。
- **缺 `plugin.config_version`**：宿主要求配置节必须带版本号，否则只加载配置管理页面、
  不激活功能（「当前版本策略不再兼容无版本配置」）。已在 `PluginSection` 补上。

### 新增

- 插件图标 `assets/icon.svg`：八池环 + 中心节点，深色圆角底，manifest 指向它。
- 插件改名为「思维链记忆」，ID `cangqiong666.mai-chain`，Python 包 `mai_chain`
  （去掉 dsh 前缀，避免在 MaiBot 里造成名不副实）。

### 实机验证结果

- 宿主加载：`已加载=7`（含 `cangqiong666.mai-chain`），`失败=0`
- 组件注册：9 个 TOOL + 1 个 HOOK_HANDLER
- 端到端：写入 → 检索 → 元记忆 → 统计 → 注入 Hook 全通
- 注入实测：system item 追加 1 个 text part，253 字符，**原 items 对象未被污染**
- 存储：数据目录已生成 `chain.db`（WAL 模式）
