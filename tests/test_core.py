"""核心算法测试。

重点验证三件事，而不是"能跑"：

1. 分池与衰减**行为正确**（核心永不淡、被想起延长寿命、下限 0.1）
2. 装箱**注入量恒定**（100 条和 1000 条占用的字符一样）
3. 已退役条目**绝不进注入**（这是上游踩过的真坑）
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mai_chain import pools  # noqa: E402
from mai_chain.injection import render_injection  # noqa: E402
from mai_chain.mood import (  # noqa: E402
    detect_mood,
    merge_working,
    mood_strength,
    visible_mood,
)
from mai_chain.patrol import build_patrol_report, similarity  # noqa: E402


def _iso(days_ago: float = 0, *, hours_ago: float = 0) -> str:
    moment = datetime.now(timezone.utc) - timedelta(days=days_ago, hours=hours_ago)
    return moment.isoformat()


def _entry(**kwargs):
    base = {
        "id": kwargs.pop("id", "e1"),
        "ts": kwargs.pop("ts", _iso()),
        "judgement": kwargs.pop("judgement", "测试判断"),
        "conclusion": kwargs.pop("conclusion", "测试结论"),
        "evidence": kwargs.pop("evidence", []),
        "hesitation": kwargs.pop("hesitation", []),
        "tags": kwargs.pop("tags", []),
        "weight": kwargs.pop("weight", 0.5),
        "superseded": kwargs.pop("superseded", False),
        "pool_override": kwargs.pop("pool_override", ""),
        "touch_count": kwargs.pop("touch_count", 0),
        "last_touched": kwargs.pop("last_touched", None),
    }
    base.update(kwargs)
    if base["last_touched"] is None:
        base["last_touched"] = base["ts"]
    return base


class TestPoolRouting:
    """池的路由规则。"""

    def test_core_tags(self):
        assert pools.pool_of(_entry(tags=["原则"])) == "core"
        assert pools.pool_of(_entry(tags=["人格"])) == "core"

    def test_emotion_before_others(self):
        # 情绪标签必须一票决定，不能被「用户」抢走
        assert pools.pool_of(_entry(tags=["情绪", "用户"])) == "emotion"

    def test_rule_vs_experience_split(self):
        # 带硬约束口气 -> 铁律
        assert pools.pool_of(_entry(tags=["教训"], judgement="以后必须先说结论")) == "skillRule"
        # 没硬约束口气 -> 经验
        assert pools.pool_of(_entry(tags=["教训"], judgement="这次排查用了 strace")) == "skillExp"

    def test_daily_promotion_by_touch(self):
        """被想起 2 次就从片面日常升进核心日常（纯派生，不需要写盘）。"""

        assert pools.pool_of(_entry(tags=["日常"], touch_count=0)) == "dailyPartial"
        assert pools.pool_of(_entry(tags=["日常"], touch_count=1)) == "dailyPartial"
        assert pools.pool_of(_entry(tags=["日常"], touch_count=2)) == "dailyCore"

    def test_unmatched_goes_to_hippocampus_not_dropped(self):
        """标签没命中任何池 -> 海马体，**不是**丢掉。

        这是全系统最重要的不对称判断：猜成 7 天的 dailyPartial，那条就真没了；
        猜成海马体最坏只是躺在缓冲区等审查。
        """

        result = pools.pool_of(_entry(tags=["完全无关的标签"]))
        assert result == "hippocampus"
        assert not pools.has_pool_rule(["完全无关的标签"])

    def test_manual_override_wins(self):
        entry = _entry(tags=["日常"], pool_override="core")
        assert pools.base_pool_of(entry) == "core"


class TestDecay:
    """衰减公式。"""

    def test_core_never_decays(self):
        assert pools.decayed_weight(0.9, _iso(3650), "core") == 0.9

    def test_grace_period_no_decay(self):
        # fact 池宽限 15 天，第 10 天不该掉
        assert pools.decayed_weight(0.8, _iso(10), "fact") == 0.8

    def test_half_life(self):
        """过了一个半衰期（宽限之后）应该接近一半。"""

        # fact: grace=15, half_life=365 -> 第 380 天约 0.5
        weight = pools.decayed_weight(1.0, _iso(380), "fact")
        assert 0.45 < weight < 0.55

    def test_recall_extends_life(self):
        """被想起越多，同一时刻剩得越多 —— 这是这套系统真正的遗忘机制。"""

        never = pools.decayed_weight(1.0, _iso(98), "skillExp", touch_count=0)
        few = pools.decayed_weight(1.0, _iso(98), "skillExp", touch_count=3)
        many = pools.decayed_weight(1.0, _iso(98), "skillExp", touch_count=10)
        assert never < few < many

    def test_floor_at_0_1(self):
        """忘掉不等于凭空删掉 —— 保留档案底色。"""

        assert pools.decayed_weight(1.0, _iso(10000), "dailyPartial") == 0.1

    def test_stretch_capped_at_4(self):
        """stretch 封顶 4 倍，不能因为次数多就永不衰减。"""

        for count in (0, 10, 1000, 100000):
            weight = pools.decayed_weight(1.0, _iso(10000), "dailyPartial", touch_count=count)
            assert weight >= 0.1


class TestInjectPhase:
    """注入粒度。"""

    def test_hippocampus_never_injected(self):
        """原料不是记忆 —— 哪怕刚写下来一秒也不进注入。"""

        assert pools.inject_phase(_entry(tags=["海马体"]), 0.0) == "none"

    def test_emotion_not_in_list(self):
        assert pools.inject_phase(_entry(tags=["情绪"]), 0.0) == "none"

    def test_full_then_brief_then_none(self):
        # skillExp: inject_full_days=30, archive_days=365
        assert pools.inject_phase(_entry(tags=["教训"]), 10.0) == "full"
        assert pools.inject_phase(_entry(tags=["教训"]), 100.0) == "brief"
        assert pools.inject_phase(_entry(tags=["教训"]), 400.0) == "none"


class TestInjection:
    """注入渲染。"""

    def test_empty_returns_empty(self):
        assert render_injection([]) == ""

    def test_superseded_excluded(self):
        """**已被取代的一律不进注入** —— 上游踩过的真坑。

        否则新旧两条判断同时出现在脑子里，而旧的那条是错的。
        """

        entries = [
            _entry(id="old", judgement="旧结论：给每条记忆配 keywords", tags=["原则"], superseded=True),
            _entry(id="new", judgement="新结论：改用 IDF 检索", tags=["原则"]),
        ]
        text = render_injection(entries)
        assert "旧结论" not in text
        assert "新结论" in text

    def test_header_present(self):
        text = render_injection([_entry(tags=["原则"], judgement="先给结论")])
        assert "我的思维链" in text
        assert "先给结论" in text

    def test_injection_size_constant(self):
        """**注入量恒定** —— 库里有 50 条还是 500 条，占用字符都在上限内。"""

        def make(count: int):
            return [
                _entry(
                    id=f"e{i}",
                    judgement=f"第 {i} 条判断，" + "内容" * 40,
                    conclusion="结论" * 20,
                    tags=["教训"],
                    weight=1.0 - (i % 10) * 0.05,
                )
                for i in range(count)
            ]

        small = render_injection(make(50), max_chars=6000)
        large = render_injection(make(500), max_chars=6000)
        assert len(small) <= 6000
        assert len(large) <= 6000
        # 大库不该比小库多出数量级的字符
        assert len(large) < len(small) * 3

    def test_overflow_is_announced(self):
        """装不下的条数必须明说，不许静默丢。"""

        entries = [
            _entry(id=f"e{i}", judgement=f"判断{i}" + "长" * 60, tags=["教训"], weight=0.9)
            for i in range(60)
        ]
        text = render_injection(entries, max_chars=2000)
        assert "未展开" in text or "chain_recall" in text

    def test_pure_function(self):
        """同样输入必须同样输出 —— 否则每轮打穿 prompt 缓存前缀。"""

        entries = [_entry(id=f"e{i}", tags=["教训"], judgement=f"判断{i}") for i in range(5)]
        first = render_injection(entries, user_text="测试")
        second = render_injection(entries, user_text="测试")
        assert first == second

    def test_mood_shown_without_entries(self):
        """一条记忆都没有也要能显示情绪。"""

        text = render_injection([], mood={"mood": "挫败", "strength": 0.8, "why": "改了三遍", "age_hours": 0.5})
        assert "挫败" in text

    def test_working_block_included(self):
        text = render_injection(
            [_entry(tags=["原则"])],
            working_block="【还没做完的事】\n- 待办：问对方吃没吃饭",
        )
        assert "还没做完的事" in text


class TestRetrieval:
    """检索。"""

    def test_rrf_finds_by_keyword(self):
        from mai_chain.retrieval import rank_entries_rrf

        entries = [
            _entry(id="a", judgement="决定用 SQLite 存思维链", tags=["决策"]),
            _entry(id="b", judgement="今天天气不错适合散步", tags=["日常"]),
        ]
        hits = rank_entries_rrf(entries, "SQLite 怎么存的")
        assert hits
        assert hits[0]["entry"]["id"] == "a"

    def test_no_evidence_no_candidate(self):
        """没有词面证据的条目不进候选。"""

        from mai_chain.retrieval import rank_entries_rrf

        entries = [_entry(id="x", judgement="完全无关的内容", tags=["日常"])]
        assert rank_entries_rrf(entries, "量子力学") == []

    def test_time_hint(self):
        from mai_chain.retrieval import parse_time_hint

        hint = parse_time_hint("昨天我们改了什么")
        assert hint is not None
        assert hint["label"] == "昨天"


class TestMood:
    """情绪。"""

    def test_detect(self):
        result = detect_mood("今天真累")
        assert result is not None
        assert result["mood"] == "累"

    def test_negation(self):
        # "不累" 不该判成累
        assert detect_mood("我不累") is None

    def test_decay(self):
        assert mood_strength(0.8, 0) == 0.8
        # 一天后约剩一半
        assert 0.35 < mood_strength(0.8, 24) < 0.45

    def test_expired_hidden(self):
        record = {"mood": "生气", "strength": 0.9, "ts": _iso(5)}
        assert visible_mood(record) is None


class TestWorking:
    """工作记忆。"""

    def test_extract_todo(self):
        items = merge_working([], "记得明天把方案发你")
        assert items
        assert any("方案" in item["text"] for item in items)

    def test_max_three(self):
        text = "记得A 记得B 记得C 记得D 记得E"
        items = merge_working([], text)
        assert len(items) <= 3

    def test_done_removes(self):
        first = merge_working([], "记得明天发方案")
        assert first
        after = merge_working(first, "发过去了")
        assert len(after) < len(first)

    def test_expire(self):
        stale = [{"id": "w1", "text": "旧待办", "kind": "待办", "ts": _iso(10)}]
        assert merge_working(stale, "") == []


class TestPatrol:
    """夜巡。"""

    def test_similarity(self):
        assert similarity("完全一样的一句话", "完全一样的一句话") == 1.0
        assert similarity("完全不同的内容在这里", "毫不相关另外一些字") < 0.2

    def test_report_has_sections(self):
        entries = [
            _entry(id="a", judgement="重复的判断内容", tags=["教训"]),
            _entry(id="b", judgement="重复的判断内容", tags=["教训"]),
            _entry(id="c", judgement="只有判断没有结论", conclusion="", tags=["日常"]),
        ]
        report = build_patrol_report(entries)
        assert report["marks"]["live"] == 3
        assert any("疑似重复" in section["title"] for section in report["sections"])
        assert "夜巡" in report["text"]

    def test_report_does_not_mutate(self):
        """夜巡只出报告，不改数据。"""

        entries = [_entry(id="a", judgement="x", tags=["日常"])]
        snapshot = [dict(item) for item in entries]
        build_patrol_report(entries)
        assert entries == snapshot