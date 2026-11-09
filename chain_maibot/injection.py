"""注入段渲染与字符装箱 —— 移植自 dsh-chain 的 ``lib/format.js``。

## 核心思路：注入量恒定

注入不是"取最近 N 条"，而是**拿字符预算往里装**：

* 候选按权重全局排序逐条装；
* 装不下就**跳过这条、继续试下一条**（不是整段停）；
* 装不下的条数明写在段标题里 —— **不静默丢**；
* 核心段永不参与装箱（它本来就该全量在）。

结果是：库里 100 条还是 1000 条，占用的 prompt 都一样。
上游实测 1000 条时封顶 24000 字符，137 条时约 9100 字符。

## 两条铁律（不遵守会出真正的问题）

1. **渲染必须是纯函数**。同样的输入永远同样的输出。
   注入段会因为渲染结果不稳定而破坏系统提示的缓存前缀 —— 那是实打实的钱。
   所以这里不读 ``time.time()`` 之外的外部状态，所有"现在几点"都通过参数传入。
2. **已被取代（superseded）的条目一律不进注入**。
   上游踩过：取代只把权重压到 0.1，正文照样一行一行注入 ——
   于是新旧两条判断同时出现在脑子里，而旧的那条是**错的**。

## 结构

::

    ## 我的思维链（只对我可见）

    我现在：踏实（20 分钟前·强度 0.80）
    因为：……

    核心（32 条 · 不随时间淡）：
    - [11-09] ……
    铁律（8 条）：
    - ……
    你这句话让我想起来：
    - ……
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .pools import POOLS, POOL_ORDER

logger = logging.getLogger("chain_maibot.format")

#: 注入段默认字符上限（约 8k token）。太小会把记忆挤成"外挂硬盘"，太大则每轮都在为旧判断付钱。
INJECT_MAX_CHARS = 24000

#: 下限，防止有人手滑填 1 把整段注入干掉。
INJECT_MIN_CHARS = 2000

#: 注入段标题。用「只对我可见」是刻意的 —— 提示模型这是内部参考，不要在回复里复述。
SECTION_TITLE = "## 我的思维链（只对我可见）"

#: 「你这句话让我想起来」一节最多显示几条。
HIT_DISPLAY_MAX = 3

#: 「最近几条的细节」最多展开几条。
DETAIL_MAX = 2

#: 海马体那扇小窗：只取最近几条、每条 80 字 —— 约 300 字符，是"在场感"的价格。
HIPPOCAMPUS_INJECT_MAX = 4
HIPPOCAMPUS_FRESH_DAYS = 2
HIPPOCAMPUS_CHAR_MAX = 80

#: 「当前状态」块最多几条（只取最新的）。
MOOD_MAX = 1



def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def short_date(value: Any) -> str:
    """把 ISO 时间戳裁成 ``MM-DD``；解析不出来返回 ``??-??``。

    **刻意只到日**：注入段里带完整时间戳会让渲染结果每分钟都变，
    直接把 prompt 缓存前缀打穿。
    """

    from .pools import parse_ts  # noqa: PLC0415

    parsed = parse_ts(value)
    if parsed is None:
        return "??-??"
    moment = datetime.fromtimestamp(parsed)
    return f"{moment.month:02d}-{moment.day:02d}"


def human_age(hours: float) -> str:
    """把小时数说成人话。"""

    if hours < 1:
        return f"{max(0, int(hours * 60))} 分钟前"
    if hours < 24:
        return f"{int(hours)} 小时前"
    return f"{int(hours / 24)} 天前"


def title_of(entry: Mapping[str, Any]) -> str:
    """记录的主标题：优先 judgement，没有就退回 conclusion。"""

    judgement = str(entry.get("judgement") or "").strip()
    if judgement:
        return judgement
    conclusion = str(entry.get("conclusion") or "").strip()
    return conclusion or "(无标题)"


def entry_lines(entry: Mapping[str, Any], *, detailed: bool) -> List[str]:
    """把一条记录渲染成注入用的若干行。"""

    lines = [f"- [{short_date(entry.get('ts'))}] {title_of(entry)}"]
    if detailed:
        evidence = [str(item) for item in (entry.get("evidence") or []) if str(item).strip()]
        if evidence:
            lines.append(f"  依据: {' / '.join(evidence[:3])}")
        hesitation = [str(item) for item in (entry.get("hesitation") or []) if str(item).strip()]
        if hesitation:
            lines.append(f"  犹豫: {' / '.join(hesitation[:2])}")
    conclusion = str(entry.get("conclusion") or "").strip()
    if conclusion:
        lines.append(f"  结论: {conclusion}")
    return lines


def _spec(key: str, label: str, total: int) -> Dict[str, Any]:
    """构造一个注入段的规格。装不下的条数**必须**写在标题里，不许静默丢。"""

    def _title(shown: int) -> str:
        if shown < total:
            return f"{label}（{shown} 条 · 另有 {total - shown} 条未展开（chain_recall 可查））："
        return f"{label}（{shown} 条）："

    return {"key": key, "title": _title}


def _section_text(
    specs: Sequence[Mapping[str, Any]],
    rows: Sequence[Mapping[str, Any]],
) -> str:
    """把已选中的行按段拼起来，**按真实渲染长度计费**（含标题与换行）。"""

    blocks: List[str] = []
    for spec in specs:
        selected = [row for row in rows if row["key"] == spec["key"]]
        if not selected:
            continue
        title = spec["title"](len(selected))
        blocks.append("\n".join([title, *[str(row["text"]) for row in selected]]))
    return "\n\n".join(blocks)


def _place(
    head: List[str],
    specs: Sequence[Mapping[str, Any]],
    candidates: Sequence[Mapping[str, Any]],
    *,
    limit: int,
    commit: bool = True,
) -> List[Mapping[str, Any]]:
    """按字符预算装箱。

    **跳过装不下的继续试下一条**，而不是整段停 —— 这是上游实测后的选择：
    一条超长记录不该把后面的短记录全挤掉。
    """

    selected: List[Mapping[str, Any]] = []
    prefix = "\n".join(head) + "\n\n" if head else ""
    for candidate in candidates:
        trial = [*selected, candidate]
        if len(prefix) + len(_section_text(specs, trial)) <= limit:
            selected.append(candidate)
    if commit and selected:
        block = _section_text(specs, selected)
        if block:
            head.append("")
            head.append(block)
    return selected


def _brief_row(key: str, entry: Mapping[str, Any]) -> Dict[str, Any]:
    return {"key": key, "entry": entry, "text": f"- [{short_date(entry.get('ts'))}] {title_of(entry)}"}


def _fresh_hippocampus(entry: Mapping[str, Any], age: float) -> bool:
    """这条原料够不够新，值得出现在「最近她说过的话」里。

    上游修过的一个坑：头部计数用"过滤后剩几条"，循环体里还有一句 ``if text: continue``。
    两把尺子一旦不一致，就会出现「标题说 4 条、实际只打出 1 行」。
    判据统一挪到这里：**能进这一节，就必须有字可打**。
    """

    if entry.get("superseded"):
        return False
    from .pools import pool_of  # noqa: PLC0415

    if pool_of(entry) != "hippocampus":
        return False
    if age > HIPPOCAMPUS_FRESH_DAYS:
        return False
    text = str(entry.get("judgement") or "").strip()
    return len(text) >= 2


def render_injection(
    entries: Sequence[Mapping[str, Any]],
    *,
    user_text: str = "",
    max_chars: int = INJECT_MAX_CHARS,
    now: Optional[float] = None,
    mood: Optional[Mapping[str, Any]] = None,
    working_block: str = "",
    include_hippocampus: bool = True,
) -> str:
    """渲染注入段正文。没有内容时返回**空串**（调用方据此不注入）。

    Args:
        entries: 全部记忆（不要求有序，内部会排序）。
        user_text: 用户当前这句话。给了它就启用**索引延申**：
            平时只记「判断」一行，被提起时才想起细节 —— 这正是人记东西的方式。
        max_chars: 字符上限。
        now: 当前 epoch 秒（便于测试注入；生产传 None 即取系统时间）。
        mood: 当前情绪 ``{"mood", "strength", "why", "age_hours"}``。
        working_block: 「还没做完的事」块，由调用方渲染好传进来。
        include_hippocampus: 是否给那扇「最近她说过的话」的小窗。

    Returns:
        str: 注入文本；无内容时为空串。
    """

    from .pools import age_days as _age_days
    from .pools import inject_phase, pool_of
    from .retrieval import rank_entries_rrf

    cap = max(INJECT_MIN_CHARS, int(max_chars or INJECT_MAX_CHARS))
    current = _now_iso() if now is None else datetime.fromtimestamp(now, timezone.utc).isoformat()
    _ = current  # 仅用于保证 now 参数被真实消费

    head: List[str] = [SECTION_TITLE]

    # ---- 情绪段：**不依赖记忆有没有内容**。一条记忆都没有的 bot 照样会挫败、会担心。
    if mood:
        strength = float(mood.get("strength") or 0.0)
        age_hours = float(mood.get("age_hours") or 0.0)
        line = f"我现在：{mood.get('mood') or '平静'}（{human_age(age_hours)}·强度 {strength:.2f}）"
        why = str(mood.get("why") or "").strip()
        block = line + (f"\n因为：{why}" if why else "")
        head.append("")
        head.append(block)

    if working_block.strip():
        head.append("")
        head.append(working_block.strip())

    live = [entry for entry in entries if not entry.get("superseded")]
    # ---- 已被取代的一律不进注入。数据仍留在库里可审计，但"能被想起来的"只该是活的。
    if not live:
        return "\n".join(head) if len(head) > 1 else ""

    def age_of(entry: Mapping[str, Any]) -> float:
        return _age_days(entry, now)

    def priority(entry: Mapping[str, Any]) -> Tuple[float, float]:
        """权重优先、新的次之。**只用于排序，不参与相关分**。"""

        from .pools import parse_ts  # noqa: PLC0415

        return (float(entry.get("weight") or 0.0), parse_ts(entry.get("ts")) or 0.0)

    groups: Dict[str, List[Mapping[str, Any]]] = {key: [] for key in POOLS}
    for entry in live:
        declared = str(entry.get("pool") or "")
        key = declared if declared in POOLS else pool_of(entry)
        groups.setdefault(key, []).append(entry)

    # ---- 核心：不参与装箱的竞争，独占优先
    core_rows = [
        {"key": "core", "entry": entry, "text": f"- {title_of(entry)}"}
        for entry in sorted(groups.get("core", []), key=priority, reverse=True)
    ]
    if core_rows:
        _place(head, [_spec("core", "核心", len(core_rows))], core_rows, limit=cap)

    # ---- 铁律：先给一条完整的预留，保证不会被核心挤没
    rules = [
        entry
        for entry in sorted(groups.get("skillRule", []), key=priority, reverse=True)
        if inject_phase(entry, age_of(entry)) != "none"
    ]
    rule_spec = _spec("skillRule", "铁律（失约过才知道）", len(rules))
    rule_rows = [_brief_row("skillRule", entry) for entry in rules]
    if rule_rows:
        _place(head, [rule_spec], rule_rows, limit=cap)

    # ---- 常驻池：按权重全局排序后统一装箱
    labels = {
        "fact": "事实",
        "skillExp": "经验",
        "dailyCore": "核心日常",
        "dailyPartial": "片面日常",
    }
    specs: List[Mapping[str, Any]] = []
    candidates: List[Dict[str, Any]] = []
    for key, label in labels.items():
        eligible = [
            entry
            for entry in sorted(groups.get(key, []), key=priority, reverse=True)
            if inject_phase(entry, age_of(entry)) != "none"
        ]
        specs.append(_spec(key, label, len(eligible)))
        # 经验最多 3 条：上游的教训是"经验先占预算再裁三条"，被裁的条目不释放预算，
        # 白白挤掉其他池。所以要在装箱**之前**限制候选数。
        pool_slice = eligible[:3] if key == "skillExp" else eligible
        candidates.extend(_brief_row(key, entry) for entry in pool_slice)
    candidates.sort(key=lambda row: priority(row["entry"]), reverse=True)
    if candidates:
        _place(head, specs, candidates, limit=cap)

    # ---- 海马体那扇小窗：只给「最近她说过的话」，不是全量账本
    if include_hippocampus:
        recent = [
            entry
            for entry in sorted(groups.get("hippocampus", []), key=priority, reverse=True)
            if _fresh_hippocampus(entry, age_of(entry))
        ][:HIPPOCAMPUS_INJECT_MAX]
        if recent:
            rows = []
            for entry in recent:
                text = str(entry.get("judgement") or "").strip()
                if len(text) > HIPPOCAMPUS_CHAR_MAX:
                    text = text[:HIPPOCAMPUS_CHAR_MAX] + "…"
                rows.append({"key": "raw", "text": f"- {text}"})
            _place(head, [_spec("raw", "最近她说过的话（原文 · 还没加工）", len(rows))], rows, limit=cap)

    # ---- 索引延申：这句话提到了某条记忆里的词，就把那条的细节想起来
    if str(user_text or "").strip():
        candidates_live = [
            entry
            for entry in live
            if pool_of(entry) != "hippocampus" and not entry.get("superseded")
        ]
        hits = rank_entries_rrf(candidates_live, user_text, max_results=HIT_DISPLAY_MAX)
        if hits:
            words: List[str] = []
            rows = []
            for hit in hits:
                entry = hit["entry"]
                label = str(hit.get("best_word") or "").strip()
                if label and label not in words:
                    words.append(label)
                rows.append({"key": "hit", "entry": entry, "text": f"- {title_of(entry)}"})
            shown = " ".join(words[:4])
            title = f"你这句话让我想起来{('（' + shown + '）') if shown else ''}："
            _place(head, [{"key": "hit", "title": lambda _n, _t=title: _t}], rows, limit=cap)

            # 命中条目的细节（依据 + 犹豫 + 结论）—— 这才是"想起"和"看到"的区别
            detail_rows = []
            for hit in hits[:DETAIL_MAX]:
                entry = hit["entry"]
                detail_rows.append({"key": "hitDetail", "entry": entry, "text": "\n".join(entry_lines(entry, detailed=True))})
            if detail_rows:
                _place(head, [{"key": "hitDetail", "title": lambda _n: "其中值得细看的："}], detail_rows, limit=cap)

    if len(head) <= 1:
        return ""
    return "\n".join(head)[:cap]


def render_mermaid(entries: Sequence[Mapping[str, Any]], *, limit: int = 30) -> str:
    """导出 Mermaid 思维导图（给人看轨迹，给 ``chain_graph`` 用）。"""

    live = [entry for entry in entries if not entry.get("superseded")][: max(1, limit)]
    if not live:
        return "mindmap\n  root((空))"
    lines = ["mindmap", "  root((思维链))"]
    by_pool: Dict[str, List[Mapping[str, Any]]] = {}
    for entry in live:
        from .pools import pool_of  # noqa: PLC0415

        key = str(entry.get("pool") or pool_of(entry))
        by_pool.setdefault(key, []).append(entry)
    for key in POOL_ORDER:
        bucket = by_pool.get(key)
        if not bucket:
            continue
        label = POOLS[key].label if key in POOLS else key
        lines.append(f"    {label}")
        for entry in bucket[:6]:
            text = title_of(entry).replace("(", "（").replace(")", "）")[:40]
            lines.append(f"      {text}")
    return "\n".join(lines)


def build_working_block(items: Sequence[Mapping[str, Any]], *, max_items: int = 3) -> str:
    """渲染「还没做完的事」块。

    硬约束（与上游一致）：不调用模型（纯正则）、最多 3 条、3 天没提起自动过期。
    """

    rows = [item for item in items if str(item.get("text") or "").strip()][:max_items]
    if not rows:
        return ""
    lines = ["【还没做完的事】"]
    for item in rows:
        kind = str(item.get("kind") or "待办")
        lines.append(f"- {kind}：{str(item.get('text') or '').strip()}")
    return "\n".join(lines)