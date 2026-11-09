# chain_maibot · 思维链记忆（MaiBot 版）

> **它记的不是「发生了什么」，而是「当时为什么这么定」。**

移植自 [dsh-chain](https://github.com/canglight/dsh-chain)（MIT，作者：末苍和她的大肥鱼）。
原项目是 DeepSeek​ Harness 的插件，这里把记忆模型与算法搬到了 MaiBot。

每条记忆是一句**判断** + **依据** + **犹豫** + **结论**。
结论会过时，理由不会 —— 普通记忆系统存「用户喜欢蓝色」，
它存「当时选了蓝色，因为考虑到配色统一，虽然担心太冷」。

## 和内置 A_Memorix 的关系

**互补，不是替代。**

A_Memorix 是 MaiBot 的核心模块（`src/A_memorix`），走 `host_service` 直连，
**不占任何插件 Hook**，所以两者不抢资源、不会打架。

| | A_Memorix | chain_maibot |
|---|---|---|
| 管什么 | 通用长期记忆：谁说过什么、群里发生过什么 | 决策链：为什么这么定 |
| 生命周期 | 一个全局 `half_life_hours` | 八池分级，各有宽限/半衰期/归档线 |
| 记忆单元 | 段落 + 实体关系 | 判断 + 依据 + 犹豫 + 结论 |
| 检索 | 双向量池 + PPR 图加权 | jieba IDF + 字符二元组 + RRF |

推荐两个都开：A_Memorix 负责「记得住」，本插件负责「想得起来为什么」。

## 八池分级遗忘

不同种类的东西，活该有不同的寿命。

| 池 | 宽限 | 半衰期 | 归档 | 全量注入 |
|---|---|---|---|---|
| 核心（原则/人格） | ∞ | ∞ | ∞ | ∞ |
| 事实（关于用户） | 15d | 365d | 1095d | 365d |
| 铁律（必须/不许） | 120d | 730d | 3650d | ∞ |
| 经验（教训/工具） | 15d | 60d | 365d | 30d |
| 核心日常 | 20d | 60d | 180d | 60d |
| 片面日常 | 5d | 20d | 45d | 30d |
| 情绪 | 3h | 1d | 3d | 只给一行 |
| 海马体（原料） | 0 | 1d | 14d | **永不注入** |

**权重不只是随时间衰减**：被检索命中的次数会拉长半衰期
（`1 + 0.6·log2(1+次数)`，封顶 4 倍）。所以「被想起的东西活得更久，
没人提的慢慢淡出去」才是这套系统真正的遗忘机制。

**标签没命中任何池 → 进海马体，不猜。**
池子决定的是「这条活多久」，猜错的代价不对称 ——
猜成 7 天的片面日常，那条就真没了；猜成海马体，最坏只是躺在缓冲区等一次审查。

**核心池上限 32 条**。满了之后写「原则/人格」会被拒绝并提示改去写 `AGENTS.md`——
核心是不可衰减的那一层，它一旦能被随手追加就会越写越厚，最后变成一份谁都不读的清单。

## 注入按字符装箱

不是「取最近 N 条」，而是**拿字符预算往里装**：

- 候选按权重全局排序逐条装
- 装不下就**跳过这条、继续试下一条**（不是整段停）
- 装不下的条数明写在段标题里：`另有 N 条未展开（chain_recall 可查）` —— **不静默丢**
- 核心段不参与装箱（本来就该全量在）

实测：50 条 → 405 字符，1000 条 → 410 字符。**注入量恒定。**

## 七个工具

| 工具 | 干什么 |
|---|---|
| `chain_append` | 写一条判断（judgement / evidence / hesitation / conclusion / tags / weight） |
| `chain_recall` | 按关键词检索；补带同 `eventId` 的关联判断 |
| `chain_about` | **问「关于 X 我知道什么」**：被想起次数 / 人工确认次数 / 是否被取代 / 多可信 |
| `chain_touch` | 确认（+0.05）/ 推翻（退役）/ 人工定池 |
| `chain_mood` | 写当前情绪（单一状态牌，会自己过期） |
| `chain_patrol` | 手动跑夜巡，出报告 |
| `chain_graph` | 导出 Mermaid 图谱 |
| `chain_triage` | 给海马体片段猜池（只出建议） |
| `chain_stats` | 统计与检索层状态 |

## 安装

```bash
cd ~/mai/plugins
git clone https://github.com/1519160235/dsh-chain.git chain-maibot
```

依赖：**无需额外安装**。分词用 `jieba`，MaiBot 的 `requirements.txt` 已包含；
存储用标准库 `sqlite3`。jieba 不可用时会自动降级为字符二元组单路检索，不报错。

放进 `plugins/` 后重启 MaiBot（插件清单变更不热加载）。

## 配置

在 WebUI 插件页配置，或改 `config.toml`：

```toml
[plugin]
enabled = true          # 总开关（默认关）

[injection]
enabled = true          # 是否每轮注入
max_chars = 24000       # 注入字符上限，约 8k token
include_hippocampus = true   # 「最近她说过的话」小窗
inject_mood = true
inject_working = true

[lifecycle]
core_max = 32           # 核心池上限
auto_recall_mark = true # 被注入命中时记 recall，延长半衰期

[patrol]
enabled = false         # 每天自动跑一次夜巡
hour = 18
auto_rebalance = false  # 自动夜巡是否执行归整（默认只出报告）
```

### 覆盖单个池的参数

```toml
[pools.skillExp]
half_life_days = 90     # 0 表示用默认值
grace_days = 20
```

池 key：`core` / `fact` / `skillRule` / `skillExp` / `dailyCore` / `dailyPartial` / `emotion` / `hippocampus`

## 数据在哪

```
<插件数据目录>/
├─ chain.db          # SQLite：entries / events / edges / meta
└─ patrol/           # 夜巡报告 YYYY-MM-DD.md
```

全本地，不联网、不发遥测、不调用外部 API。

## 注入的四条纪律

`maisaka.planner.before_request` 的 `items` 是**全量替换**语义，
且多个 handler 之间是**覆盖传递**（`kwargs = dict(modified_kwargs)`）。
所以本插件的注入实现严格遵守：

1. **深拷贝 items** —— 不改宿主传进来的对象
2. **只追加 system item 的 `parts`**，绝不重建整个列表
3. **渲染纯函数** —— 同样输入同样输出，否则每轮打穿 prompt 缓存前缀
4. **全程 try/except 返回 continue** —— 注入失败不能影响正常回复

如果你要改注入逻辑，这四条一条都不能少。

## 已知限制

- **换个说法仍可能检索不到**：关键词 + 字符二元组补不了真正的语义鸿沟。
  上游实测换说法查询约一半会漏。需要语义检索得另接 `ctx.llm.embed`。
- **工作记忆只认显式说法**：「记得 / 待会 / 明天 / 答应过」这类，
  「可能」「也许」抓不到；泛化的收尾话（只说了「搞定了」）可能清不掉。
- **情绪判定是关键词级**：粗粒度，不调模型。判错的代价远小于每轮多一次 LLM 调用。
- **核心池满了会拒绝新增**：这是刻意的设计，不是 bug。
- **未在真实 MaiBot 环境跑过**：核心算法有 37 个单测，注入层需要你在实机验证。

## 许可

MIT。原项目版权归 **末苍和她的大肥鱼**，详见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。