"""两路 RRF 融合检索 —— 移植自 dsh-chain 的 ``lib/retrieval.js``。

## 为什么不用纯分词匹配

上游实测两个硬伤：

1. 长句切出上百个二字词，「记得」「优先」「今天」都能命中；
2. 按时间取最新 3 条 —— 结果恒等于"最近写的东西"，不是"相关的"。

## 三路信号

1. **IDF 罕见词命中**：jieba 分词 + 通用 IDF，阈值 9。专有名词很准，换个说法就零命中。
2. **字符二元组重合**：补"说法变了但字面沾边"的那部分。
3. **RRF 融合**：``1/(60 + rank)``，**只看名次不看分数** —— 避免某一路的尺度把结果带偏。

实测（14 条查询含 6 条换说法）：单路 IDF Recall@5 29%，两路融合 **64%**。

## 三个反直觉结论（都是上游试错出来的，照抄）

1. **打分取「命中词里最高的 IDF」，不求和**。
   求和会让长句靠一堆虚词累出 22 分，比真命中还高。
2. **不乘记忆权重**。乘了反而更差：「组件甲」从 9.4 掉到 8.5 被阈值挡掉，
   而它本来是真命中。相关性该是纯词面的。
3. **命中判定用原文子串，分词只用来给查询选词**。
   因为 jieba 会把自造专名切成单字，导致查询对不上。

## 与上游的差异

上游用 ``@node-rs/jieba`` 原生模块（可选依赖、装不上就降级）。
MaiBot 本身依赖 ``jieba``（requirements.txt 有），所以这里直接用，
但仍保留**降级路径**：jieba 拿不到就退回字符二元组单路，绝不因此不注入 ——
少一段记忆比多两条噪声更糟。
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

logger = logging.getLogger("mai_chain.retrieval")

#: 不在词典里的词（自造专名）按这个算，等于"非常罕见"。
FALLBACK_IDF = 11.95

#: 判"相关"的最低分。低于它宁可不注入 —— 噪声比没有更糟。
HIT_THRESHOLD = 9.0

#: 注入段里"你这句话让我想起来"最多几条。
HIT_MAX = 3

#: RRF 的平滑常数（与上游一致）。
RRF_K = 60

#: 中文通用虚词。不参与打分，否则「为什么」「可以」会把不相干条目全勾进来。
STOPWORDS: Set[str] = {
    "为什么", "什么", "怎么", "可以", "不是", "这个", "那个", "我们", "你们", "他们",
    "现在", "然后", "因为", "所以", "如果", "但是", "而且", "就是", "还是", "已经",
    "一下", "一些", "这样", "那样", "一个", "没有", "知道", "觉得", "应该", "需要",
    "这里", "那里", "以及", "对于", "关于", "不会", "不能", "不要", "一定", "其实",
    "时候", "地方", "东西", "事情", "问题", "自己", "别人", "帮我", "看看",
    "今天", "明天", "昨天", "多少", "哪里", "是不是", "能不能", "要不要", "有没有",
    "我的", "你的", "他的", "她的", "它们的", "记忆", "判断", "结论", "依据",
}

#: 只保留中文连续段的滑窗。
_CHINESE_RUN = re.compile(r"[\u4e00-\u9fa5]{2,}")

#: jieba 与 IDF 表的运行时就绪状态。首次调用时惰性初始化。
_state: Optional[Dict[str, Any]] = None
_load_error: str = ""


def init_retrieval() -> bool:
    """惰性初始化 jieba 与 IDF 表。

    **失败不抛错**：拿不到就保持未就绪，检索层自动降级到字符二元组单路。
    插件绝不能因为一个可选能力没装好就整个挂掉。

    Returns:
        是否就绪。
    """

    global _state, _load_error
    if _state is not None:
        return True
    try:
        import jieba  # noqa: PLC0415  — 惰性导入，失败要能兜住

        # jieba.analyse 自带 IDF 表（约 27 万条通用语料逆文档频率）。
        from jieba import analyse  # noqa: PLC0415

        # 触发一次加载，确认 IDF 表真的可用；拿不到就走降级。
        probe = analyse.extract_tags("预热", topK=1, withWeight=True)
        if probe is None:
            raise RuntimeError("jieba IDF 表不可用")
        _state = {"jieba": jieba, "analyse": analyse}
        return True
    except Exception as exc:  # noqa: BLE001 — 任何失败都应降级而不是抛
        _load_error = f"{type(exc).__name__}: {exc}"
        logger.warning("jieba 未就绪，检索降级为字符二元组单路: %s", _load_error)
        return False


def retrieval_ready() -> bool:
    """检索层（IDF 路）是否可用。"""

    return _state is not None


def retrieval_error() -> str:
    """上一次初始化失败的原因；就绪后为空串。"""

    return "" if _state is not None else _load_error


def _idf_of(word: str) -> float:
    """取一个词的通用 IDF。不在表里 = 自造专名 = 按中位数算。"""

    if _state is None:
        return FALLBACK_IDF
    try:
        # jieba.analyse 的 idf_freq 是 dict，直接查比 extract_tags 更精确
        value = _state["analyse"].idf_freq.get(word)
        return float(value) if value is not None else FALLBACK_IDF
    except Exception:  # noqa: BLE001
        return FALLBACK_IDF


def query_tokens(text: str) -> List[str]:
    """把查询文本切成候选词。

    只留 ≥2 字、含中文、非纯数字的词，去重。

    **中文子串兜底**（上游实测抓到的 bug）：jieba 会把「机器味重」切成
    「机器 / 味重」，于是查询「机器味」在原词匹配上 0 命中。
    这不是同义词问题，是**切词把词切没了**。
    所以把查询里的中文连续段再补 2–4 字滑窗（长的优先、去重、封顶）。
    """

    text = str(text or "")
    if not text:
        return []

    raw: Iterable[str] = []
    if _state is not None:
        try:
            raw = _state["jieba"].cut(text, cut_all=False)
        except Exception:  # noqa: BLE001
            raw = []

    out: List[str] = []
    seen: Set[str] = set()
    for token in raw:
        word = str(token).strip()
        if len(word) < 2 or word.isdigit() or not _CHINESE_RUN.search(word):
            continue
        if word in seen:
            continue
        seen.add(word)
        out.append(word)

    for run in _CHINESE_RUN.findall(text):
        for length in range(4, 1, -1):
            for index in range(0, len(run) - length + 1):
                sub = run[index : index + length]
                if sub in seen:
                    continue
                seen.add(sub)
                out.append(sub)
                if len(out) >= 48:
                    return out
    return out


def searchable_text_of(entry: Mapping[str, Any], *, max_chars: int = 4000) -> str:
    """一条记忆的可检索正文（原样拼接，**不再分词**）。

    命中判定用原文子串，所以自造专名不必进词典也认得。
    """

    parts: List[str] = []
    for key in ("judgement", "conclusion"):
        value = entry.get(key)
        if isinstance(value, str) and value:
            parts.append(value)
    for key in ("evidence", "hesitation"):
        values = entry.get(key) or []
        if isinstance(values, (list, tuple)):
            parts.extend(str(item) for item in values if isinstance(item, str) and item)
    return " ".join(parts)[:max_chars]


def score_entry(
    entry: Mapping[str, Any],
    tokens: Sequence[str],
    text: Optional[str] = None,
) -> Tuple[float, str, int]:
    """一条记忆和这句话的相关分。

    分数 = **命中词里最高的通用 IDF**，不乘权重、不求和。

    Returns:
        ``(score, best_word, matched_count)``
    """

    if not tokens:
        return 0.0, "", 0
    haystack = text if text is not None else searchable_text_of(entry)
    best = 0.0
    best_word = ""
    matched = 0
    for word in tokens:
        if word not in haystack:
            continue
        matched += 1
        value = _idf_of(word)
        if value > best:
            best = value
            best_word = word
    return best, best_word, matched


def char_bigrams(text: str) -> Set[str]:
    """字符二元组集合（中文不用分词也能比"像不像"）。"""

    clean = re.sub(r"\s+", "", str(text or "")).lower()
    return {clean[i : i + 2] for i in range(0, max(0, len(clean) - 1))}


def rank_entries_rrf(
    entries: Sequence[Mapping[str, Any]],
    user_text: str,
    *,
    max_results: int = 8,
    k: int = RRF_K,
    min_shared: int = 2,
) -> List[Dict[str, Any]]:
    """两路 RRF 融合检索。

    Args:
        entries: 全部记忆（已被取代的会跳过）。
        user_text: 用户当前这句话。
        max_results: 返回条数上限。
        k: RRF 平滑常数。
        min_shared: 二元组重合的最低门槛（IDF 零命中时的补充证据）。

    Returns:
        ``[{"entry", "score", "best_word", "shared"}]``，按融合分降序。
        检索层未就绪且二元组也无证据时返回空列表。
    """

    text = str(user_text or "").strip()
    if not text:
        return []
    tokens = query_tokens(text)
    query_grams = char_bigrams(text)
    if not query_grams and not tokens:
        return []

    candidates: List[Dict[str, Any]] = []
    for entry in entries:
        if entry.get("superseded"):
            continue
        haystack = searchable_text_of(entry)
        score, best_word, matched = score_entry(entry, tokens, haystack)
        grams = char_bigrams(haystack)
        shared = len(query_grams & grams) if query_grams else 0
        # **没有词面证据就不进候选** —— 否则新鲜度会把无关项顶上来
        if score <= 0 and shared < min_shared:
            continue
        candidates.append(
            {
                "entry": entry,
                "score": score,
                "best_word": best_word,
                "shared": shared,
                "matched": matched,
                "weight": float(entry.get("weight") or 0),
                "ts": entry.get("ts") or "",
            }
        )
    if not candidates:
        return []

    by_idf = sorted(candidates, key=lambda c: (c["score"], c["shared"]), reverse=True)
    by_gram = sorted(candidates, key=lambda c: (c["shared"], c["score"]), reverse=True)

    fused: Dict[str, float] = {}
    for ordered in (by_idf, by_gram):
        for index, candidate in enumerate(ordered):
            key = str(candidate["entry"].get("id") or "")
            fused[key] = fused.get(key, 0.0) + 1.0 / (k + index + 1)

    ranked = [
        {
            "entry": candidate["entry"],
            "score": fused.get(str(candidate["entry"].get("id") or ""), 0.0),
            "best_word": candidate["best_word"],
            "shared": candidate["shared"],
        }
        for candidate in candidates
    ]

    def sort_key(item: Mapping[str, Any]) -> Tuple[float, float, float]:
        entry = item["entry"]
        ts = float(pools_ts(entry.get("ts")))
        return (float(item["score"]), ts, float(entry.get("weight") or 0))

    ranked.sort(key=sort_key, reverse=True)
    return ranked[: max(1, max_results)]


def pools_ts(value: Any) -> float:
    """把时间戳转成可排序的 float；失败返回 0。"""

    from .pools import parse_ts  # noqa: PLC0415 — 避免循环导入

    parsed = parse_ts(value)
    return parsed if parsed is not None else 0.0


def rank_entries(
    entries: Sequence[Mapping[str, Any]],
    user_text: str,
    *,
    threshold: float = HIT_THRESHOLD,
    max_results: int = HIT_MAX,
) -> List[Dict[str, Any]]:
    """纯 IDF 阈值检索（上游 ``rankEntries`` 的等价物）。

    用途：需要"高精度、宁缺毋滥"的场合。注入段优先用 :func:`rank_entries_rrf`。
    """

    text = str(user_text or "").strip()
    if not text or _state is None:
        return []
    tokens = query_tokens(text)
    if not tokens:
        return []
    scored: List[Dict[str, Any]] = []
    for entry in entries:
        if entry.get("superseded"):
            continue
        score, best_word, _ = score_entry(entry, tokens)
        if score >= threshold:
            scored.append({"entry": entry, "score": score, "best_word": best_word})
    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored[: max(1, max_results)]


def parse_time_hint(text: str, now: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """把查询里的时间词翻成一个时间窗。

    **为什么必须单独做**：实测「昨天我们改了什么」5 条里只有 1 条相关、
    「刚才那个决定」0 条 —— 因为「昨天」「刚才」被当成普通关键词去匹配正文，
    而正文里当然没有这两个字。用户说时间词时，要的是**按时间筛**，
    不是按"时间"这两个字匹配。
    """

    import time as _time  # noqa: PLC0415

    source = str(text or "")
    current = _time.time() if now is None else now
    midnight = current - (current % 86400)

    def day_start(offset: int) -> float:
        return midnight + offset * 86400

    if "前天" in source:
        return {"from": day_start(-2), "to": day_start(-1), "label": "前天"}
    if "昨天" in source or "昨日" in source:
        return {"from": day_start(-1), "to": day_start(0), "label": "昨天"}
    if "今天" in source or "今日" in source:
        return {"from": day_start(0), "to": current + 1, "label": "今天"}
    if any(word in source for word in ("刚才", "刚刚", "这会儿")):
        return {"from": current - 2 * 3600, "to": current + 1, "label": "刚才"}
    matched = re.search(r"最近\s*(\d+)\s*天", source)
    if matched:
        days = int(matched.group(1))
        return {"from": current - days * 86400, "to": current + 1, "label": f"最近{days}天"}
    if any(word in source for word in ("这周", "本周", "这几天")):
        return {"from": day_start(-6), "to": current + 1, "label": "这几天"}
    return None