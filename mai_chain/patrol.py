"""夜巡：把记忆维护变成可审计的报告 —— 移植自 dsh-chain 的 ``lib/patrol.js``。

## 最重要的设计取舍

**自动夜巡只写报告，不写归整或退役事件。**
手动 ``chain_patrol(apply=True)`` 才显式执行归整。

这是刻意的克制：让"建议"和"执行"分离。记忆系统自己决定删什么，
出问题时你无从追查；而报告躺在那里，人看过再说。

## 检查项（上游 10 节，这里保留 9 节）

1. 久未命中 —— 三个月没被想起的
2. 疑似重复 —— 字符 3-gram Jaccard ≥ 0.60
3. 共享关键词但没连线 —— 该有联想边却没建
4. 矛盾候选 —— 同池同关键词、结论相反的
5. 半写断裂 —— 有 judgement 无 conclusion 的
6. 海马体待整理 —— 缓冲区堆积
7. 自动归整建议 —— 可回收/可降权的
8. 未归类待审 —— 标签没命中任何池的
9. 池分布概览

## 与上游的差异

上游是 O(n²)（自己承认 1000 条时约 50 万次配对、没测过耗时）。
这里改成**倒排索引先筛候选对**：只比较共享 ≥2 个关键词的条目，
把复杂度压到实际可用的量级。
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from .pools import POOLS, UNCLASSIFIED_TAG, age_days, has_pool_rule, parse_ts, pool_of
from .retrieval import STOPWORDS, query_tokens, searchable_text_of

logger = logging.getLogger("mai_chain.patrol")

#: 判"疑似重复"的阈值。低于它不动手 —— 让重复检测宁缺毋滥。
DUPLICATE_SIM = 0.60

#: 被想起这么多次，就该把之前压下去的分还回来。
RECOVER_TOUCH = 3

#: 多久没被想起算"久未命中"（天）。
STALE_DAYS = 90

#: 每个检查项最多列几条（报告不该变成第二份数据库）。
MAX_PER_SECTION = 12


def _title(entry: Mapping[str, Any]) -> str:
    judgement = str(entry.get("judgement") or "").strip()
    if judgement:
        return judgement[:80]
    conclusion = str(entry.get("conclusion") or "").strip()
    return (conclusion or "(无标题)")[:80]


def _grams(text: str, n: int = 3) -> Set[str]:
    """字符 n-gram 集合。"""

    clean = "".join(str(text or "").split())
    return {clean[i : i + n] for i in range(0, max(0, len(clean) - n + 1))}


def similarity(a: str, b: str) -> float:
    """字符 3-gram 的 Jaccard 相似度 —— 判"两句话是不是在说同一件事"。"""

    ga = _grams(a)
    gb = _grams(b)
    if not ga or not gb:
        return 0.0
    intersection = len(ga & gb)
    return intersection / (len(ga) + len(gb) - intersection)


def _keywords(entry: Mapping[str, Any], limit: int = 24) -> List[str]:
    """抽取用于搭倒排索引的关键词（去虚词）。"""

    tokens = query_tokens(searchable_text_of(entry))
    out: List[str] = []
    seen: Set[str] = set()
    for token in tokens:
        if token in STOPWORDS or len(token) < 2 or token in seen:
            continue
        seen.add(token)
        out.append(token)
        if len(out) >= limit:
            break
    return out


def _candidate_pairs(entries: Sequence[Mapping[str, Any]]) -> List[Tuple[Mapping[str, Any], Mapping[str, Any]]]:
    """用倒排索引找"共享 ≥2 个关键词"的候选对。

    这一步是相对上游的主要改进：O(n²) 全量配对在 1000 条时是 50 万次比较，
    而实际可能重复的条目几乎总有共享关键词。
    """

    index: Dict[str, List[int]] = defaultdict(list)
    keywords: List[List[str]] = []
    for position, entry in enumerate(entries):
        words = _keywords(entry)
        keywords.append(words)
        for word in words:
            index[word].append(position)

    pair_counts: Dict[Tuple[int, int], int] = defaultdict(int)
    for positions in index.values():
        if len(positions) < 2 or len(positions) > 200:
            # 单个词命中过多说明它没有区分度（也可能是脏数据），跳过。
            continue
        for i in range(len(positions)):
            for j in range(i + 1, len(positions)):
                pair_counts[(positions[i], positions[j])] += 1

    pairs: List[Tuple[Mapping[str, Any], Mapping[str, Any]]] = []
    for (left, right), shared in sorted(pair_counts.items(), key=lambda item: -item[1]):
        if shared < 2:
            continue
        pairs.append((entries[left], entries[right]))
        if len(pairs) >= 200:
            break
    return pairs


def build_patrol_report(
    entries: Sequence[Mapping[str, Any]],
    *,
    edges: Sequence[Mapping[str, Any]] = (),
    now: Optional[float] = None,
    date_label: str = "",
) -> Dict[str, Any]:
    """生成夜巡报告。

    Args:
        entries: 全部记忆（含 superseded）。
        edges: 现有联想边 ``[{"src","dst","kind","weight"}]``。
        now: 当前 epoch 秒。
        date_label: 日期标签，留空则取今天。

    Returns:
        ``{"date", "marks": {...}, "sections": [...], "text": "..."}``
    """

    live = [entry for entry in entries if not entry.get("superseded")]
    label = date_label or datetime.now().strftime("%Y-%m-%d")
    marks: Dict[str, Any] = {"total": len(entries), "live": len(live), "date": label}
    sections: List[Dict[str, Any]] = []

    def add(title: str, rows: List[str], empty_note: str = "无") -> None:
        sections.append({"title": title, "rows": rows[:MAX_PER_SECTION], "total": len(rows), "note": empty_note if not rows else ""})

    # ---- ① 久未命中
    stale: List[Tuple[Mapping[str, Any], float]] = []
    for entry in live:
        age = age_days(entry, now)
        touched = int(entry.get("touch_count") or 0)
        if age >= STALE_DAYS and touched == 0:
            stale.append((entry, age))
    stale.sort(key=lambda item: -item[1])
    add(
        "① 久未命中（≥90 天且从未被想起）",
        [f"- [{int(age)} 天] {_title(entry)}（池: {pool_of(entry)}）" for entry, age in stale],
    )
    marks["stale"] = len(stale)

    # ---- ② 疑似重复（倒排筛候选 + Jaccard 复核）
    duplicates: List[Tuple[Mapping[str, Any], Mapping[str, Any], float]] = []
    for left, right in _candidate_pairs(live):
        score = similarity(
            f"{left.get('judgement') or ''} {left.get('conclusion') or ''}",
            f"{right.get('judgement') or ''} {right.get('conclusion') or ''}",
        )
        if score >= DUPLICATE_SIM:
            duplicates.append((left, right, score))
    duplicates.sort(key=lambda item: -item[2])
    add(
        "② 疑似重复（建议合并成一条判断）",
        [f"- {score:.2f}  「{_title(left)}」 ↔ 「{_title(right)}」" for left, right, score in duplicates],
    )
    marks["duplicates"] = len(duplicates)

    # ---- ③ 共享关键词但没连线
    linked: Set[Tuple[str, str]] = set()
    for edge in edges:
        src, dst = str(edge.get("src") or ""), str(edge.get("dst") or "")
        linked.add((src, dst))
        linked.add((dst, src))
    unlinked: List[Tuple[Mapping[str, Any], Mapping[str, Any], int]] = []
    seen_pairs: Set[Tuple[str, str]] = set()
    keyword_map: Dict[str, List[int]] = defaultdict(list)
    for position, entry in enumerate(live):
        for word in _keywords(entry):
            keyword_map[word].append(position)
    for positions in keyword_map.values():
        if len(positions) < 2 or len(positions) > 100:
            continue
        for i in range(len(positions)):
            for j in range(i + 1, len(positions)):
                left, right = live[positions[i]], live[positions[j]]
                key = tuple(sorted((str(left.get("id")), str(right.get("id")))))
                if key in seen_pairs or (key[0], key[1]) in linked:
                    continue
                seen_pairs.add(key)
                unlinked.append((left, right, 1))
    add(
        "③ 共享关键词但没连线（可考虑建联想边）",
        [f"- 「{_title(left)}」 ↔ 「{_title(right)}」" for left, right, _ in unlinked],
    )
    marks["unlinked"] = len(unlinked)

    # ---- ④ 半写断裂
    broken = [
        entry
        for entry in live
        if str(entry.get("judgement") or "").strip() and not str(entry.get("conclusion") or "").strip()
    ]
    add("④ 半写断裂（有判断、没结论）", [f"- {_title(entry)}" for entry in broken])
    marks["broken"] = len(broken)

    # ---- ⑤ 海马体待整理
    buffer_entries = [entry for entry in live if pool_of(entry) == "hippocampus"]
    buffer_entries.sort(key=lambda entry: parse_ts(entry.get("ts")) or 0, reverse=True)
    add(
        "⑤ 海马体待整理（合并成一条判断会自动退役原料）",
        [f"- [{int(age_days(entry, now))} 天] {_title(entry)}" for entry in buffer_entries],
    )
    marks["hippocampus"] = len(buffer_entries)

    # ---- ⑥ 未归类待审
    unclassified = [
        entry
        for entry in live
        if not has_pool_rule(entry.get("tags") or []) and not entry.get("pool_override")
    ]
    add("⑥ 未归类待审（标签没命中任何池）", [f"- {_title(entry)}" for entry in unclassified])
    marks["unclassified"] = len(unclassified)

    # ---- ⑦ 自动归整建议
    recover: List[Mapping[str, Any]] = []
    weaken: List[Mapping[str, Any]] = []
    for entry in live:
        touched = int(entry.get("touch_count") or 0)
        weight = float(entry.get("weight") or 0)
        if touched >= RECOVER_TOUCH and weight < 0.4:
            recover.append(entry)
        elif touched == 0 and age_days(entry, now) >= 60 and weight < 0.2:
            weaken.append(entry)
    add(
        "⑦ 自动归整建议（需 chain_patrol apply=true 才执行）",
        [f"- 可回收(+0.05): {_title(entry)}" for entry in recover]
        + [f"- 可降权(-0.05): {_title(entry)}" for entry in weaken],
    )
    marks["recover"] = len(recover)
    marks["weaken"] = len(weaken)

    # ---- ⑧ 池分布
    distribution: Dict[str, int] = defaultdict(int)
    for entry in live:
        distribution[pool_of(entry)] += 1
    add(
        "⑧ 池分布",
        [
            f"- {POOLS[key].label if key in POOLS else key}: {count} 条"
            for key, count in sorted(distribution.items(), key=lambda item: -item[1])
        ],
    )
    marks["pools"] = dict(distribution)

    # ---- 渲染成 Markdown
    lines = [f"# 思维链夜巡报告 · {label}", "", f"总计 {marks['total']} 条，存活 {marks['live']} 条。", ""]
    for section in sections:
        lines.append(f"## {section['title']}")
        if section["total"] > len(section["rows"]):
            lines.append(f"_共 {section['total']} 条，只列前 {len(section['rows'])} 条_")
        lines.extend(section["rows"] or [f"- {section['note']}"])
        lines.append("")

    return {"date": label, "marks": marks, "sections": sections, "text": "\n".join(lines)}


def build_rebalance_plan(
    entries: Sequence[Mapping[str, Any]],
    *,
    now: Optional[float] = None,
) -> List[Tuple[str, float]]:
    """生成归整计划（不执行）。返回 ``[(entry_id, delta)]``。"""

    plan: List[Tuple[str, float]] = []
    for entry in entries:
        if entry.get("superseded"):
            continue
        touched = int(entry.get("touch_count") or 0)
        weight = float(entry.get("weight") or 0)
        if touched >= RECOVER_TOUCH and weight < 0.4:
            plan.append((str(entry.get("id")), 0.05))
        elif touched == 0 and age_days(entry, now) >= 60 and weight < 0.2:
            plan.append((str(entry.get("id")), -0.05))
    return plan


def triage_fragment(entry: Mapping[str, Any]) -> Dict[str, Any]:
    """给海马体片段猜一个池（**只出建议，不写盘**）。

    为什么用词面信号而不是调模型：海马体里绝大多数片段本来就没价值（"重启了"、"哈哈哈"），
    只为一小部分去调模型不划算。**宁可漏掉，也不要拿噪声去污染长记忆。**
    """

    text = f"{entry.get('judgement') or ''} {' '.join(str(x) for x in (entry.get('evidence') or []))}"
    rules: Sequence[Tuple[str, Tuple[str, ...]]] = (
        ("skillRule", ("必须", "不许", "绝不", "禁止", "红线")),
        ("skillExp", ("报错", "修复", "踩坑", "排障", "教训", "配置", "工具")),
        ("fact", ("喜欢", "讨厌", "习惯", "生日", "住", "养")),
        ("dailyCore", ("一起", "上次", "总是", "每次")),
    )
    for pool, words in rules:
        if any(word in text for word in words):
            return {"pool": pool, "reason": f"命中关键词: {next(w for w in words if w in text)}"}
    return {"pool": "dailyPartial", "reason": "无明显信号，按一次性内容处理"}