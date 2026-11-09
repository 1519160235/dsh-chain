"""八池分级衰减 —— 移植自 dsh-chain 的 ``lib/pools.js``。

## 为什么要分池

统一期限对核心太短、对一次性进展又太长：

* 「不许提换会话」要是按 80 天删，两个月后就忘了；
* 「今天清了两条污染」撑 200 天纯属占地方。

分池之后，**宽限 / 半衰期 / 归档线 / 全量注入窗口**全部由"这条属于什么"决定。

## 与上游的差异

1. 上游把 `skill` 拆成 `skillRule` / `skillExp` 是运行时派生（``classify_skill``）。
   这里保持一致，但把正则提到模块级常量，便于测试。
2. 上游的池参数可被设置页覆盖（``poolOverride``）。这里改成纯 dataclass，
   由插件配置在启动时注入，避免模块级可变全局（RPC 子进程里多插件共用进程）。
3. 池的判定全部保持**纯函数**：同样的 entry 永远得到同样的池。
   这既是缓存安全的前提，也让「改分类规则」可以整体生效而不必迁移数据。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

INF = float("inf")

#: 被想起多少次就够从"片面日常"升进"核心日常"。
#: 上游取 2 而不是 3：一条日常两天里被想到两次已经说明它不是一次性的，
#: 门槛越高，速朽的东西越容易在升级前就被删掉。
RECALL_PROMOTE = 2

#: 核心层上限。核心是不可衰减的那一层，代表"我是谁"；
#: 它一旦能被随手追加就会越写越厚，最后变成一份谁都不读的清单。
CORE_MAX = 32

#: 没命中任何池规则时打的标注标签（夜巡靠它把这类挑出来）。
UNCLASSIFIED_TAG = "未归类"


@dataclass(frozen=True)
class PoolDef:
    """单个池的生命周期参数。``inf`` 表示永不衰减 / 永不归档。"""

    key: str
    label: str
    desc: str
    grace_days: float
    half_life_days: float
    archive_days: float
    #: 全量注入窗口。``-1`` 表示"从不给全文"（海马体专用）。
    inject_full_days: float


#: 八个池的定义。顺序即注入顺序：核心在最前，最速朽的在最后。
POOLS: Mapping[str, PoolDef] = {
    "core": PoolDef(
        key="core",
        label="核心",
        desc="原则 / 人格 / 边界 —— 你是谁",
        grace_days=INF,
        half_life_days=INF,
        archive_days=INF,
        inject_full_days=INF,
    ),
    "fact": PoolDef(
        key="fact",
        label="事实",
        desc="关于用户的设定 —— 会变，但慢",
        grace_days=15,
        half_life_days=365,
        archive_days=1095,
        inject_full_days=365,
    ),
    "skillRule": PoolDef(
        key="skillRule",
        label="铁律",
        desc="必须 / 不许 / 绝不 —— 漏一条就是失约",
        grace_days=120,
        half_life_days=730,
        archive_days=3650,
        inject_full_days=INF,
    ),
    "skillExp": PoolDef(
        key="skillExp",
        label="经验",
        desc="排障 / 工具 / 教训 —— 用得上才拉出来",
        grace_days=15,
        half_life_days=60,
        archive_days=365,
        inject_full_days=30,
    ),
    "dailyCore": PoolDef(
        key="dailyCore",
        label="核心日常",
        desc="被反复提起的日常 —— 值得留，不必永久",
        grace_days=20,
        half_life_days=60,
        archive_days=180,
        inject_full_days=60,
    ),
    "dailyPartial": PoolDef(
        key="dailyPartial",
        label="片面日常",
        desc="一次性进展 / 元讨论 —— 速朽",
        grace_days=5,
        half_life_days=20,
        archive_days=45,
        inject_full_days=30,
    ),
    "emotion": PoolDef(
        key="emotion",
        label="情绪",
        desc="当前状态 —— 一块牌，不是一本账",
        grace_days=3 / 24,
        half_life_days=1,
        archive_days=3,
        inject_full_days=0,
    ),
    "hippocampus": PoolDef(
        key="hippocampus",
        label="海马体",
        desc="最近几天的原始片段 —— 尚未成条，等夜巡整理",
        grace_days=0,
        half_life_days=1,
        archive_days=14,
        # 原料不是记忆，永不进注入（用 -1 表示，配合 inject_phase 特判）。
        inject_full_days=-1,
    ),
}

#: 注入顺序。海马体永不注入，所以不在这个列表里。
POOL_ORDER: Tuple[str, ...] = (
    "core",
    "fact",
    "skillRule",
    "skillExp",
    "dailyCore",
    "dailyPartial",
    "emotion",
)

#: 没命中规则时的兜底池。
#:
#: **这是全系统最重要的一条不对称判断**：池子决定"这条活多久"，
#: 猜成 7 天的 dailyPartial，那条就真没了；猜成海马体，最坏也只是躺在缓冲区等一次审查。
#: 所以**不猜**。
FALLBACK_POOL = "hippocampus"

#: 标签 → 池，按顺序匹配，先命中先得。
#: 情绪与海马体必须在最前：它们靠标签一票决定，不该被别的标签抢走。
POOL_RULES: Sequence[Tuple[str, Tuple[str, ...]]] = (
    ("emotion", ("情绪",)),
    ("hippocampus", ("海马体",)),
    # core 只认真正不会变的东西。上游的教训：原来 core 还认 `行为` / `判据` / `诚实`，
    # 结果 6 条工程教训被当成核心 —— 它们的标签里恰好都有 `行为`。
    ("core", ("原则", "人格")),
    # 相处规矩排在 fact 之前：带了「关系/对她/相处」就归这里，
    # 哪怕同时带「用户」标签 —— 它讲的不是"她是谁"，是"该怎么对她"。
    ("dailyCore", ("对她", "相处", "关系")),
    ("fact", ("用户", "角色")),
    (
        "skill",
        (
            "教训", "工具", "排障", "出图", "训练", "协作", "验证", "查证",
            "算账", "对照", "清理", "侦察", "认错", "工程", "架构", "判据",
            "诚实", "顶嘴", "行为", "遗忘机制",
            # 「铁律」是池概念本身，必须能被标签直接命中。
            # 上游靠 classify_skill 从 skill 派生，但如果用户只写 ["铁律"]，
            # base_pool_of 根本走不到 classify_skill —— 会静默掉进海马体。
            "铁律", "必须", "不许", "绝不", "红线", "禁止", "千万",
        ),
    ),
    (
        "dailyPartial",
        ("记忆", "设计", "插件", "风险", "决策", "日常"),
    ),
)

#: 硬约束口气 → 铁律。判据纯正则，**不调模型**：漏掉一条铁律的代价远大于多一条经验。
RULE_SIGNAL = (
    "必须", "不许", "绝不", "永远", "红线", "禁止", "千万",
    "一定要", "铁律", "只能", "不能", "别把", "别再",
)


def _now_ts() -> float:
    return datetime.now(timezone.utc).timestamp()


def parse_ts(value: Any) -> Optional[float]:
    """把 ISO 时间串 / datetime / epoch 秒统一成 epoch 秒；失败返回 None。"""

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, datetime):
        return value.timestamp()
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    # Python 3.11+ 的 fromisoformat 能吃掉 Z 后缀，但为了 3.10 兼容手动换掉。
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def age_days(entry: Mapping[str, Any], now: Optional[float] = None) -> float:
    """距最后一次被碰过了多少天。

    优先 ``last_touched``（会被 recall / touch 刷新），退回 ``ts``。
    解析不出来时返回 0 —— 宁可按"刚刚写过"处理，也不要让一条时间坏数据被立刻归档。
    """

    reference = parse_ts(entry.get("last_touched")) or parse_ts(entry.get("ts"))
    if reference is None:
        return 0.0
    return max(0.0, ((_now_ts() if now is None else now) - reference) / 86400.0)


def has_pool_rule(tags: Iterable[Any]) -> bool:
    """这组标签有没有命中任何池规则。空标签或全不命中返回 False。"""

    tag_list = [str(tag) for tag in tags] if tags else []
    if not tag_list:
        return False
    for _, words in POOL_RULES:
        for tag in tag_list:
            if any(word in tag for word in words):
                return True
    return False


def base_pool_of(entry: Mapping[str, Any]) -> str:
    """只看标签的**基础**池（不考虑被想起次数）。

    人工定池优先：夜巡报告里标了「需人工定池」之后，``chain_touch`` 的 set-pool
    会写一条 retag 事件；人已经拍板的事不该再被标签推导盖过去。
    """

    manual = str(entry.get("pool_override") or "").strip()
    if manual and manual in POOLS:
        return manual
    tags = entry.get("tags") or []
    for pool, words in POOL_RULES:
        for tag in tags:
            if any(word in str(tag) for word in words):
                return "skill" if pool == "skill" else pool
    return FALLBACK_POOL


def classify_skill(entry: Mapping[str, Any]) -> str:
    """技能再分类：铁律 / 经验。

    判据是文本里有没有"硬约束"口气。带这种口气的是"答应过不再犯"的那类，
    漏掉代价最大，必须常驻；其余都是可以按需翻出来的经验。

    三个判据按强度排：标签明确写了「铁律」→ 标签里带硬约束词 → 正文带硬约束口气。
    上游只看前两个里的第一个和正文，导致「标签写了红线、正文很平淡」被判成经验 ——
    而"红线"本身就是硬约束，不该靠正文兜底。
    """

    tags = entry.get("tags") or []
    tag_text = " ".join(str(tag) for tag in tags)
    if "铁律" in tag_text:
        return "skillRule"
    # 标签里的硬约束词同样作数
    if any(signal in tag_text for signal in RULE_SIGNAL):
        return "skillRule"
    text = f"{entry.get('judgement') or ''} {entry.get('conclusion') or ''}"
    return "skillRule" if any(signal in text for signal in RULE_SIGNAL) else "skillExp"


def pool_of(entry: Mapping[str, Any]) -> str:
    """一条记忆**实际**属于哪个池：基础池 + 「被多次提起就升级」。

    纯派生，不写盘、不需要额外事件 —— 它只依赖 ``touch_count``，
    而那个已经由命中记账在维护。升级自动发生，不需要谁批准。
    """

    base = base_pool_of(entry)
    if base == "skill":
        return classify_skill(entry)
    if base != "dailyPartial":
        return base
    touched = int(entry.get("touch_count") or 0)
    return "dailyCore" if touched >= RECALL_PROMOTE else "dailyPartial"


def pool_def(key: str, overrides: Optional[Mapping[str, Mapping[str, Any]]] = None) -> PoolDef:
    """取池参数；``overrides`` 里改过的天数/半衰期优先。未知 key 退回兜底池。"""

    base = POOLS.get(key) or POOLS[FALLBACK_POOL]
    if not overrides or key not in overrides:
        return base
    patch = overrides[key] or {}
    clean = {k: v for k, v in patch.items() if k in {"grace_days", "half_life_days", "archive_days", "inject_full_days"}}
    return replace(base, **clean) if clean else base


def inject_phase(
    entry: Mapping[str, Any],
    age: float,
    overrides: Optional[Mapping[str, Mapping[str, Any]]] = None,
) -> str:
    """这条记忆此刻该以什么粒度进注入。

    Returns:
        ``"full"``（判断+依据+犹豫）| ``"brief"``（只一行）| ``"none"``（不进注入）。
    """

    definition = pool_def(pool_of(entry), overrides)
    # 海马体是原料不是记忆 —— **无条件不进注入**，哪怕刚写下来一秒。
    if definition.inject_full_days < 0:
        return "none"
    # 情绪走单独的「我现在」段，不混进记忆列表里。
    if definition.key == "emotion":
        return "none"
    if age >= definition.archive_days:
        return "none"
    return "full" if age <= definition.inject_full_days else "brief"


def decayed_weight(
    weight: float,
    last_active_ts: Any,
    pool_key: str,
    touch_count: int = 0,
    *,
    now: Optional[float] = None,
    overrides: Optional[Mapping[str, Mapping[str, Any]]] = None,
) -> float:
    """按池衰减后的权重。

    公式（与上游一致）::

        idle   = max(0, age - grace)
        stretch = min(4, 1 + 0.6 * log2(1 + touch_count))
        weight * 0.5 ** (idle / (half_life * stretch))

    两个刻意的细节：

    1. ``stretch`` 用 ``log2`` —— 第一次被想起最值钱，之后边际递减。
       一条被反复确认的原则性结论，不该和"只提过一次的细节"同一个半衰期。
    2. 下限 ``0.1`` 保留"档案底色"：**忘掉不等于凭空删掉**。
    """

    definition = pool_def(pool_key, overrides)
    if not math.isfinite(definition.half_life_days):
        return weight
    active = parse_ts(last_active_ts)
    if active is None:
        return weight
    idle = ((_now_ts() if now is None else now) - active) / 86400.0 - definition.grace_days
    if idle <= 0:
        return weight
    stuck = min(4.0, 1.0 + 0.6 * math.log2(1 + max(0, touch_count)))
    return max(0.1, weight * 0.5 ** (idle / (definition.half_life_days * stuck)))


def core_count(entries: Iterable[Mapping[str, Any]]) -> int:
    """数出还活着的 core 条目（原则/人格）。"""

    return sum(
        1
        for entry in entries
        if not entry.get("superseded") and base_pool_of(entry) == "core"
    )


def core_is_full(
    entries: Sequence[Mapping[str, Any]],
    max_entries: int = CORE_MAX,
) -> Tuple[bool, int, int]:
    """核心层满了没有。

    Returns:
        ``(是否已满, 当前条数, 上限)``
    """

    count = core_count(entries)
    limit = max_entries if isinstance(max_entries, int) and max_entries > 0 else CORE_MAX
    return count >= limit, count, limit


def recent_emotions(
    entries: Iterable[Mapping[str, Any]],
    now: Optional[float] = None,
    limit: int = 2,
) -> List[Dict[str, Any]]:
    """取最近还"有余温"的情绪条目（给注入「我现在」那一行用）。"""

    definition = POOLS["emotion"]
    rows: List[Dict[str, Any]] = []
    for entry in entries:
        if entry.get("superseded"):
            continue
        pool = entry.get("pool") or base_pool_of(entry)
        if pool != "emotion":
            continue
        reference = parse_ts(entry.get("last_touched")) or parse_ts(entry.get("ts"))
        age = float("inf") if reference is None else (((_now_ts() if now is None else now) - reference) / 86400.0)
        if age >= definition.archive_days:
            continue
        rows.append({"entry": entry, "ageDays": max(0.0, age)})
    rows.sort(key=lambda row: row["ageDays"])
    return rows[: max(1, limit)]