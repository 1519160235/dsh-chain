# NOTICE — 来源与归属

本项目的**记忆模型、算法与设计判断**移植自：

- 项目：**dsh-chain**（`dsh-chain-shared`）
- 作者：**末苍和她的大肥鱼**
- 仓库：https://github.com/canglight/dsh-chain
- 许可证：MIT License，Copyright (c) 2026 末苍和她的大肥鱼
- 移植时的版本：`package.json` 2.4.1（README 标 2.2.0）

原始 MIT 许可证全文见本目录的 [LICENSE](LICENSE)，按 MIT 条款要求完整保留。

## 本次移植改了什么

这不是简单的语言翻译。原项目是给 **DeepSeek​ Harness** 的插件，运行环境、注入机制、
存储介质都与 **MaiBot** 不同，因此下列部分做了重写而非直译。

### 1. 注入位（架构级差异，必须改）

| 项 | 原项目（DSH） | 本项目（MaiBot） |
|---|---|---|
| 注入机制 | `ctx.systemPrompt.section({name, order, text})` 同步回调 | `@HookHandler("maisaka.planner.before_request")` 改写 `items` |
| 注入目标 | 系统提示的固定序号位（order 850） | `items[0]` —— `item_type == "SystemMessageItem"` 的 `parts` 追加 text part |
| 触发频率 | 每次 prompt 组装 | 每轮 Planner 请求 |

MaiBot 的插件能力里**没有** `systemPrompt` 服务，所以必须换到这个 Hook。
代价是 `items` 是**全量替换**语义，且多个 handler 之间覆盖传递 ——
因此注入实现强制遵守四条纪律（深拷贝 / 只追加 / 纯函数 / 失败放行），
详见 `plugin.py` 的模块 docstring 与 `inject_chain` 方法。

### 2. 存储（介质替换）

| 项 | 原项目 | 本项目 |
|---|---|---|
| 介质 | JSONL 追加写 | SQLite（WAL） |
| 理由 | 单进程 CLI：追加 O(1)、一行坏只丢一行、可 grep | 插件跑在 RPC 子进程：需要跨进程事务与索引 |
| 位置 | `~/.dsh/memories/.chain-shared/chains.jsonl` | `<插件数据目录>/chain.db` |

事件溯源模型（`touch` / `recall` / `supersede` / `rebalance` / `retag` + `materialize` 派生）
**完整保留**，这是原项目最有价值的设计之一。

### 3. 检索（依赖替换）

| 项 | 原项目 | 本项目 |
|---|---|---|
| 分词 | `@node-rs/jieba`（可选原生依赖） | Python `jieba`（MaiBot 本身已依赖，`requirements.txt` 有） |
| IDF | 读 `idf.txt`（27 万条）自行解析 | `jieba.analyse.idf_freq` |
| 降级 | jieba 缺失 → 退回滑窗匹配 | jieba 缺失 → 退回字符二元组单路 |

RRF 融合公式、阈值 9、取最高 IDF 而非求和、不乘记忆权重、命中判定用原文子串 ——
这些**全部照原样保留**，因为它们是原项目用评估集实测出来的结论。

### 4. 夜巡（性能改进）

原项目夜巡是 O(n²) 全量配对，作者自己标注「1000 条时约 50 万次比较，没测过耗时」。
本项目改为**关键词倒排索引先筛候选对**（只比较共享 ≥2 个关键词的条目），
把复杂度压到实际可用量级，检测阈值（Jaccard 0.60）保持不变。

### 5. 删去的部分

| 原文件 | 原因 |
|---|---|
| `lib/client.js`（1912 行）3D 星云可视化 | 前端渲染，与记忆能力无关；MaiBot 用 WebUI 体系 |
| `lib/wake.mjs` 自动唤醒 | DSH 特有的 HTTP 投递机制；MaiBot 有原生主动消息能力 |
| `lib/perceive.js` 感知层 | 上游自己标注「只记录、不改变行为」，属于半成品 |
| `lib/import.js` 导入器 | DSH 特定的迁移路径 |

### 6. 修掉的上游问题

移植过程中发现并修正了两处：

1. **「铁律」标签会掉进海马体**。上游 `POOL_RULES` 的 skill 关键词里没有「铁律」二字，
   而 `classifySkill` 只有在 `base_pool_of` 返回 `skill` 之后才会被调用 ——
   于是只写 `tags: ["铁律"]` 的记忆根本走不到分类，静默落进原料缓冲区（永不注入）。
   本项目把「铁律/必须/不许/红线/禁止」直接加进 skill 关键词，并让 `classify_skill`
   同时检查标签与正文。
2. **注入段内的同步写操作**。上游在 `section` 回调里写海马体、写 `working.json`、写感知日志
   （因为它只能拿到那个位置的原话）。本项目改为从 `items` 里读用户消息、
   写操作全部移到工具调用与事件里，让渲染保持真纯函数 —— 否则每轮都会打穿 prompt 缓存前缀。

## 未移植的原创声明

本项目的 Python 实现、MaiBot Hook 适配层、SQLite 存储层、测试套件为原创工作，
同样以 MIT 许可发布。原项目的**设计思想与算法参数**归属原作者。

如果你要二次分发，请保留本文件与 `LICENSE`。