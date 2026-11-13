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

## [0.3.0] - 2026-11-10

三维星云视图。

### 新增

- **「思维链星云」自定义页面**（`webui/nebula.html`，canvas 手写 3D 投影）：
  - 八个池各占一处空间位（正八面体 + 上下顶底），池与池之间画骨架线
  - **每颗记忆球绕自己的池心走固定轨道**，不互相追、也不飞出去
  - 球的大小随权重、亮度随新鲜度、透明度随景深；越新越亮
  - 同一次决策的多条判断用橙线串起来（`eventId` 语义）
  - 点一颗球浮出卡片：所属池、权重、几天前、被想起几次、这条池放什么
  - 拖拽旋转 / 滚轮缩放 / 「自转」「轨道」「复位」三个开关
  - 30fps 上限；随宿主主题切换（`maibot:context` 事件）
- `webui_graph` 接口：一次给全节点 + 连线 + 池配色 + 统计，前端本地做投影，
  不再逐帧请求。返回字段刻意用单字母（`t/p/w/a/e/k`），几百个球时能省几十 KB。
- 超过 220 条时按「权重 + 新鲜度」截断，并在 HUD 里明确告知还有多少条没画。

### 变更

- 面板从 3 页变 4 页，星云排在最前（它是主视图）。

### 修复（协议差异，再接一次宿主才暴露）

- **自定义页必须用 `entry` 指向 HTML 文件，不能内联 `document`**：
  服务器版本与本地源码不一致 —— 本地 `CustomPage.document` 是必填内联字段，
  而宿主实际要求 `entry` 为插件内相对 `.html` 路径，`document` 由 loader 读取后注入。
  内联会直接报「custom 页面必须通过 entry 读取 HTML」。
- **`webui.json` 有 128 KiB 上限**（自定义页 HTML 另算 2 MiB）。
  改回 entry 引用后声明文件只有 12 KB。

## [0.3.1] - 2026-11-10

插件标识修正。

### 变更

- 插件 ID 由 `cangqiong666.mai-chain` 改为 **`maibot.mai-chain`**，
  作者署名改为「半句」。旧 ID 沿用了一个不该出现在公开仓库里的字符串。
- 数据目录随之变化：`data/plugins/<新 ID>/`。迁移时把旧的 `chain.db` 与 `patrol/`
  一起移动即可，数据格式没有任何变化。

## [0.4.0] - 2026-11-10

星云视觉全量对齐上游。

上一版我只做了原版的三成，还自己砍掉了几个元素 —— 这次按上游 `client.js` 的视觉清单逐项补齐，
**没有再做取舍**。

### 新增（对齐全 11 项）

- **中央球本体**：原点处一颗玻璃球，每帧跟着投影缩放、呼吸、偏心高光、内圈阴影，
  并与记忆球一起做深度排序，才有正确的前后遮挡。
- **依据微粒**：每条依据画 1–3 颗流动小点，从球沿路径移向池心；依据越多点越多。
- **池心柔光团**：每个池心 46 颗球面均匀分布的粒子（golden spiral）+ 外层 radial 辉光，
  不再是"一个圆点"。
- **跨池的桥**：两个池的记忆共享罕见词就建桥，线宽与流动点随相关强度变化。
  数据由后端 `webui_graph` 的 `bridges` 字段提供（按词的池间共现统计，O(词数)）。
- **微尘**：130 颗屏幕空间静态粒子，缓慢漂移，不参与投影。
- **底雾**：底部 radial 渐变，不用 filter。
- **标签只给权重前 10**：球一密，全挂就糊；池名单独一层。
- **聚焦层**：点一颗球，其余按 `focusT` 渐隐，同事件边高亮加粗，卡片浮出。
- **开场动画**：所有坐标乘 `easeOut` 进度，星云从中心铺开（1.5s）。
- **拖拽惯性**：松手保留角速度并按 0.94 衰减，不再"松手就停"。
- **辉光开关**：可一键关掉所有 radial 渐变，低配机器更顺。

### 变更

- 记忆球改用偏心高光表示体积（光源固定左上），不再是纯色圆点。
- 视图高度改为 `min(72vh, 620px)`，并支持浅色主题配色。

### 验证

- `node --check` 通过；假 DOM 冒烟测试连续 90 帧无异常，
  绘制计数 ~639 arc/帧、11 radial 渐变/帧、18 文字/帧（10 标签 + 8 池名）。
- 宿主协议 2 校验通过（4 页，星云 23663 字符）；真实库算出 6 条跨池桥。

## [0.5.0] - 2026-11-12

星云改为**直接移植上游的 SVG 渲染**，不再自己用 canvas 重画。

### 为什么推倒重来

前两版是我照着描述用 canvas 重写的，参数靠猜，形态和上游差得远（用户评价："跟葡萄似的"）。
上游 `lib/client.js` 是 MIT 开源，正确做法是把它的元素树、数值、CSS、逐帧更新规则搬过来。

### 移植方式

上游是 React + SVG，但每帧都通过 `map['key'].setAttribute(...)` 直接改 DOM。
所以只写一个 20 行的 `h()`（建 SVG 节点、设属性、回调 `ref`）和手写 `tick()`，
其余部分原样保留 —— **布局公式、渐变 stop、CSS、半径与透明度的计算式全部照抄**。

### 对齐后的关键差异（都是我之前做错的）

| 项 | 我原来的 | 上游 |
|---|---|---|
| 结构 | 八个池各成一团 | 一个球 + 每池一条纬度带 |
| 边缘光 | 蓝色 `#9ed4ff` | **暖橙** `#ffb066` / `#ffc78a` |
| 记忆球半径 | 1.6–6 px | `(1.05+1.45*w)*k*(0.30+0.70*openE)` |
| 池心 | 一个大辉光 | 64 颗微粒（斐波那契球面，`cbrt` 递增） |
| 底雾 | 画在屏幕空间 | 跟池心一起投影、每帧跟着转 |
| 微尘 | 无 | `min(900, mem*8)` 颗静态粒子 |
| 连线 | 屏幕空间直线 | 沿球面的短弧（`relationArc`，24 段） |
| 标签 | 默认开 10 个 | **默认关**，按钮切换 |

### 保留的修复

- 开场进度用 `Date.now()` 而不是 rAF 时间戳（无头/后台标签页里 rAF 被节流会让它永远停在 7.5%）
- 面板空态、点击详情卡、拖拽惯性、滚轮缩放

### 验证

- `node --check` 通过；Edge 无头截图逐轮比对（`shot-svg2.png`）
- 宿主协议 2 校验通过（星云 29734 字符）

## [0.6.0] - 2026-11-12

星云改为**直接运行上游 client.js**，不再移植/重画。

### 这次做对了什么

前几版都是我按理解重写：canvas 重画 → 移植 SVG 元素树 → 参数照抄。
不管怎么调，用户看到的就是"不一样"。原因很简单：**上游代码就在仓库里，我却一直在重写它。**

现在 `webui/client.js` 是上游 `lib/client.js` 的**逐字节副本**（100,843 B，未改一个字符），
页面只提供三样东西：

1. **迷你 React**（约 150 行）—— 原件只用到 `useState` / `useRef` / `useEffect` / `createElement`，
   按 hooks 索引实现即可，不需要完整 React。
2. **`window.__ModuleLoader__`** —— 上游用模块加载器包装，补上就能原样执行。
3. **伪造的 `fetch`** —— 把 `/chain-shared/api/graph` 代理到插件的 `webui_graph`。

视觉代码零改动，所以"像不像"不再取决于我的理解。

### 顺带补上缺失的数据层

原版的"好看"有一半来自**密密麻麻的联想连线**。我之前只返回了同事件边，所以画面是空的。
这次把上游 `lib/edges.js` 的 `planEdges` 移植成 Python（`plan_edges`）：

- 标签桥：共享手写标签，**星形连**（一个中心最多连 3 个），不两两全连
- 词桥：共享 df 只有 2~3 的稀有词
- 最近邻：孤立条目找字面最像的一条，弱边 w=0.22
- 度上限 5，按权重裁剪到 200 条

新增接口 `webui_links`，页面声明 `links` 查询。

### 构建方式

`webui/client.js`（上游原件） + `webui/host.html`（React 垫片） → `webui/nebula.html`
由 `python tools/build_nebula.py` 拼装。CSP 不允许外链脚本，所以必须内联；
但源文件保持独立，不会被 JSON 转义搞坏。

### 截图验证的两点说明

- 无头浏览器里 `rAF` 被节流（实测虚拟时间 8 秒只触发 6 帧），预览页把 rAF 换成 `setTimeout` 才能截图。
  真浏览器不受影响。
- `docs/nebula.png` 是 2026-10-30 之前的旧造型（力导向团块）；当前代码是"星球模式"，
  渲染出来是一颗密铺彩色点的球 —— 以上游代码为准，不以旧截图为基准。

## [0.7.0] - 2026-11-12

与框架自带长期记忆（A_Memorix）打通：写入时镜像一份，普通检索也能捞到。

### 背景：框架没有对外写入口

查证结论（不是猜的）：

- 插件 SDK 只允许 `cap.call` 等三个原始方法；服务器 84 项能力里**没有一项写记忆**
- A_Memorix 是核心插件，`plugin.py` 321 行、`@API` 数量 **0**，`api.call` 够不着
- 两者不在同一进程；它的库有 69 张表 + FTS + 向量池 + 单一写入锁，直写会烂

所以补了一条最小能力 `memory.ingest`，转发到宿主的 `MemoryService.ingest_text`。

### 新增

- **`tools/patch_host.py`**：幂等补丁工具，`--check` / `--apply` / `--revert`。
  - 记录原始与打后 sha256、框架版本、备份路径，状态存 `E:/mai/host/patch_state.json`
  - 锚点定位（`knowledge.search` 注册行），上游改了就拒绝盲打并提示看 diff
  - 备份到 `E:/mai/host/patch_backup/registry.py.<版本>.<时间>`
- **联动配置节**（中文界面）：开关、镜像哪些池（默认 `core,skillRule`）、
  来源标记（默认 `chain`）、写入超时（默认 30s）
- **`chain_append` 返回**新增 `memory_synced` / `memory_note`，主写入语义不受影响
- **概览页状态**：「长期记忆联动」一行，状态含 已联通 / 待确认 / 未联通 / 已断开
- manifest 声明 `memory.ingest` 能力

### 排查中踩到的四个坑（都实测过）

1. **`parents[2]` 少一层**：`__file__` 是 `site-packages/src/plugin_runtime/capabilities/registry.py`，
   site-packages 是 `parents[3]`，写错就定位不到 `A_Memorix`
2. **宿主的 logger 不格式化 `%s` 参数**：`logger.info("x=%s", v)` 打出来是裸 `x=%s`，
   补丁里的日志必须用 f-string
3. **空载荷探针会在宿主日志留 ERROR**：虽然参数校验保证不写入，但每次都记一条
   `能力 memory.ingest 执行异常`。改为只读文件检查，首次真实写入再确认状态
4. **宿主进程里 `from src.A_Memorix...` 可能失败**：改为**优先复用进程里已加载的
   `src.services.memory_service`**，绕开导入；再退回导入 + 修 `src.__path__`

### 验证

- `patch_host.py --check`：已打、哈希一致、版本 1.4.2
- 宿主日志：`注册能力实现: memory.ingest` ×N，调用日志显示
  `memory.ingest: plugin=maibot.mai-chain ...`
- 真实链路：能力调用进入 `MemoryService.ingest_text`（空载荷被参数校验拦住，未写入）
- 插件侧：`长期记忆联动：宿主已具备 memory.ingest，等待首次写入确认`

### 升级注意

`uv tool upgrade maibot` 会整目录替换 site-packages，补丁消失。
**跑一次 `python tools/patch_host.py --apply` 再重启**即可恢复（幂等）。
失效期间插件会记一条明确的 warning，面板状态变「未联通」，主功能不受影响。

## [0.7.1] - 2026-11-12

修面板写入报 `ApiError: 插件 API 执行失败`。

### 根因：动作/查询没声明参数

宿主前端组装参数时只看 `binding.parameters`：

```ts
Object.keys(binding.parameters).filter(...).map((name) => [name, values[name]])
```

我上一版只写了 `{"api": "webui_append", "version": "1"}`，一个参数都没声明，
于是前端传了空对象，后端报 `webui_append() missing 1 required positional argument: 'judgement'`。

### 修了三处

- **写入**：声明 `judgement`（必填）/ `conclusion` / `tags`
- **列表筛选**：声明 `pool` / `keyword` / `page` / `page_size`
  （不声明的话筛选条件会被静默丢掉，比报错更难发现）
- **详情**：宿主的 `queries` **不接受 `arguments`**
  （`queries 只接受表单参数，不声明 arguments 或 confirmation`），
  所以拿不到「被点中的那一行」。改为：
  - `rows` 直接带上 `conclusion` / `evidence` / `hesitation`
  - 对话框的文本节点用 `scope: "selection"` 绑定选中行字段

### 顺带

- 「判断」输入框不再预置空串：留空时前端会直接提示缺参数，比后端抛 ValueError 清楚

## [0.7.2] - 2026-11-13

端到端闭环验证完成：**面板写入 → 思维链落库 → 镜像进 A_Memorix 长期记忆**，全链路实测通过。

### 实测结果

一次面板写入的返回：

```json
{"success": true, "result": {
  "success": true, "id": "42ba66ec…", "pool": "skillRule", "pool_label": "铁律",
  "message": "已记住（池: 铁律），并已同步到长期记忆",
  "memory_synced": true, "memory_note": ""
}}
```

两侧数据库同时核对：

| 库 | 写入前 | 写入后 |
|---|---|---|
| `chain.db` entries | 0 | **1** |
| `a-memorix` paragraphs | 2 | **3** |

新增那条段落的字段：`source = "chain"`、
`content = "【判断】…\n【结论】…"`、
`metadata = {"external_id": "mai-chain:42ba66ec…", "origin": "mai-chain", "entry_id": …, "pool": "skillRule"}`。

也就是说：**它不是"调通了"，是数据真的进了框架的长期记忆**，`query_memory` 和启发式召回
从此都能捞到这些判断。

### 新增 `tools/panel_call.py`

调面板接口的调试工具。之前为了打通这条路耗了十几轮试探，全是踩在三个点上：

1. 面板 API 不在 `:8001/api/webui/...`。宿主是多机器人架构，业务请求走
   `/api/host/bots/<bot_id>/proxy/api/webui/...`。
2. 鉴权是**会话 cookie**，不是 `host/webui.json` 里那个 Bearer token；
   拿 `maibot host open-webui` 的 ticket 到 `POST /api/host/session` 换。
3. `/api/host/` 下的非代理操作必须带 `X-Maibot-Host: 1`，否则 403「缺少管理请求标识」。

```bash
python tools/panel_call.py --bot <bot_id> --login-only
python tools/panel_call.py --bot <bot_id> --page memories --query rows
python tools/panel_call.py --bot <bot_id> --page memories --action write \
    --args '{"judgement": "先给结论再解释", "tags": "铁律"}'
```

### 一处观察

刚写入完立刻再调 `queries/rows` 会偶发 502「插件运行时调用失败」，重试即恢复 ——
写入触发的联动 RPC（`memory.ingest`，超时 30s）占着运行时，读请求排在后面。
不是 bug，但如果面板在写入后马上刷新，用户可能看到一次红字。后续可考虑把镜像改成后台任务。
