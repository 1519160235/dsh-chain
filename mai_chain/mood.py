"""当前情绪与工作记忆 —— 移植自 dsh-chain 的 ``lib/mood.js`` 与 ``lib/working.js``。

## 情绪：一块状态牌，不是一本账

上游的关键判断：情绪**不走记忆流水线**。它是唯一性的一块状态牌，
新状态直接覆盖旧的（存在单独的表里，不进 entries）。
理由：「情绪是'我现在'，不是一个可以被想起的历史条目」。

强度按 1 天半衰期衰减 —— 生气不该过夜还满格。

## 工作记忆：还没做完的事

三条硬约束（与上游一致）：

1. **不调用模型** —— 纯正则，每轮都跑
2. **最多 3 条**
3. **3 天没提起自动过期**，说「做好了 / 发过去了」就删相关那条

它存在单独的 ``working`` 表，**不进记忆链** ——
待办不该参与衰减统计，也不该出现在图谱里。
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .pools import parse_ts

logger = logging.getLogger("mai_chain.mood")

#: 情绪强度半衰期（天）。
MOOD_HALF_LIFE_DAYS = 1.0

#: 情绪过期线（天）——超过它就不注入了。
MOOD_ARCHIVE_DAYS = 3.0

#: 低于这个强度就不显示（等于已经平静了）。
MOOD_MIN_STRENGTH = 0.15

#: 工作记忆：最多注入几条。
WORKING_MAX_ITEMS = 3

#: 工作记忆：多久没提起就过期（天）。
WORKING_TTL_DAYS = 3.0

#: 认「还没做完的事」的正则。**刻意只认显式说法** ——
#: 上游承认「可能」「也许」这类抓不到；泛化的收尾话（只说"搞定了"）也可能一条都清不掉。
_WORKING_ADD = re.compile(
    r"(?:记得|待会|待会儿|一会儿|等下|明天|后天|下次|回头|稍后|晚点|我准备|我打算|答应过?|欠你|还欠)"
    r"[^。！？\n]{2,60}"
)

#: 认「已经做完了」的正则 —— 命中就删相关那条。
_WORKING_DONE = re.compile(
    r"(?:做好了|弄好了|搞定了|发过去了|发你了|完成了|弄完了|已经发|已经做|已经搞|交了|给你发)"
)

#: 情绪词 → 强度。粗粒度就够，精细分类没有下游消费者。
_MOOD_WORDS: Sequence[tuple[str, float]] = (
    ("崩溃", 0.95), ("绝望", 0.9), ("焦虑", 0.75), ("担心", 0.6),
    ("烦", 0.7), ("生气", 0.85), ("火大", 0.9), ("恼火", 0.8),
    ("累", 0.6), ("疲惫", 0.65), ("困", 0.5),
    ("开心", 0.8), ("高兴", 0.8), ("踏实", 0.75), ("满足", 0.7),
    ("兴奋", 0.85), ("期待", 0.7), ("好奇", 0.55),
    ("难过", 0.7), ("委屈", 0.75), ("失落", 0.65),
    ("平静", 0.5), ("无聊", 0.4), ("困惑", 0.5),
)


def _now() -> float:
    return datetime.now(timezone.utc).timestamp()


def mood_strength(base: float, age_hours: float) -> float:
    """按半衰期衰减的情绪强度。"""

    if age_hours <= 0:
        return base
    return max(0.0, base * 0.5 ** (age_hours / (MOOD_HALF_LIFE_DAYS * 24.0)))


def detect_mood(text: str) -> Optional[Dict[str, Any]]:
    """从一句话里认情绪。返回 ``{"mood", "strength", "why"}`` 或 None。

    刻意做得**很轻**：只查关键词，不调模型。情绪判错的代价远小于每轮多一次 LLM 调用。
    """

    source = str(text or "")
    if not source:
        return None
    best: Optional[tuple[str, float]] = None
    for word, strength in _MOOD_WORDS:
        if word in source and (best is None or strength > best[1]):
            # 否定式："不累"、"没生气" 不该判成有情绪
            index = source.find(word)
            prefix = source[max(0, index - 2) : index]
            if any(neg in prefix for neg in ("不", "没", "别", "无")):
                continue
            best = (word, strength)
    if best is None:
        return None
    word, strength = best
    # 强度受句子长度轻微调节：短句里的"累"比长段叙述里的"累"更可能是状态。
    if len(source) > 120:
        strength *= 0.8
    return {"mood": word, "strength": round(strength, 2), "why": source.strip()[:120]}


def visible_mood(record: Optional[Mapping[str, Any]], *, now: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """判断存下来的情绪现在还剩多少，够不够显示。

    Returns:
        ``{"mood", "strength", "why", "age_hours"}`` 或 None（过期/太弱）。
    """

    if not record:
        return None
    created = parse_ts(record.get("ts"))
    if created is None:
        return None
    age_hours = max(0.0, ((_now() if now is None else now) - created) / 3600.0)
    if age_hours >= MOOD_ARCHIVE_DAYS * 24:
        return None
    strength = mood_strength(float(record.get("strength") or 0.0), age_hours)
    if strength < MOOD_MIN_STRENGTH:
        return None
    return {
        "mood": str(record.get("mood") or "平静"),
        "strength": strength,
        "why": str(record.get("why") or ""),
        "age_hours": age_hours,
    }


def update_mood(current: Optional[Mapping[str, Any]], text: str, *, force: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """根据一句话决定要不要换状态牌。

    * 认出新情绪 → 覆盖（情绪是状态牌，不是累积账）
    * 认出「做完了」→ 不变
    * 什么都没认出 → 返回 None（保持原牌，让它自己衰减）
    """

    if force:
        return {"mood": force, "strength": 0.7, "why": "", "ts": datetime.now(timezone.utc).isoformat()}
    detected = detect_mood(text)
    if detected is None:
        return None
    existing = visible_mood(current)
    # 已经有更强的同向状态且很新，就不要被一句随口的话冲掉。
    if existing and existing["strength"] > detected["strength"] + 0.2 and existing["age_hours"] < 2:
        return None
    return {**detected, "ts": datetime.now(timezone.utc).isoformat()}


# --------------------------------------------------------------------- 工作记忆


def extract_working(text: str) -> List[Dict[str, Any]]:
    """从一句话里抽出「还没做完的事」。**纯正则，不调模型**。"""

    source = str(text or "")
    if not source:
        return []
    found: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for match in _WORKING_ADD.finditer(source):
        raw = match.group(0).strip()
        if len(raw) < 3 or raw in seen:
            continue
        seen.add(raw)
        # 认一下是哪类：答应过的承诺，还是随手记的待办
        kind = "答应过" if re.search(r"答应|欠|给你|帮你", raw) else "待办"
        found.append(
            {
                "id": uuid.uuid4().hex,
                "text": raw[:120],
                "kind": kind,
                "ts": datetime.now(timezone.utc).isoformat(),
            }
        )
        if len(found) >= WORKING_MAX_ITEMS:
            break
    return found


def is_done_statement(text: str) -> bool:
    """这句话是不是在说「已经做完了」。"""

    return bool(_WORKING_DONE.search(str(text or "")))


def expire_working(
    items: Sequence[Mapping[str, Any]],
    *,
    now: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """剔除过期的待办（3 天没提起就自动过期）。"""

    current = _now() if now is None else now
    kept: List[Dict[str, Any]] = []
    for item in items:
        created = parse_ts(item.get("ts"))
        if created is None:
            continue
        if (current - created) / 86400.0 > WORKING_TTL_DAYS:
            continue
        kept.append(dict(item))
    return kept


def merge_working(
    existing: Sequence[Mapping[str, Any]],
    text: str,
    *,
    now: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """更新工作记忆列表。

    三条规矩（上游一致）：最多 3 条、3 天过期、说「做完了」就删相关那条。
    """

    items = expire_working(existing, now=now)
    if is_done_statement(text):
        # 收尾话：把最像的那条删掉。简单做法 —— 删最近一条（通常是刚做的那件）。
        if items:
            items.pop()
        return items[:WORKING_MAX_ITEMS]
    fresh = extract_working(text)
    if not fresh:
        return items[:WORKING_MAX_ITEMS]
    # 去重：同一件事别记两遍
    existing_texts = {str(item.get("text") or "") for item in items}
    for item in fresh:
        if item["text"] not in existing_texts:
            items.append(item)
            existing_texts.add(item["text"])
    return items[-WORKING_MAX_ITEMS:]