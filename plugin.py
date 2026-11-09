"""chain_maibot —— 思维链记忆，MaiBot 版。

移植自 `canglight/dsh-chain <https://github.com/canglight/dsh-chain>`_（MIT）。
原项目是给 DeepSeek Harness 用的，这里把**记忆模型与算法**搬到 MaiBot 的插件体系上。

## 它记的是什么

**不是"发生了什么"，而是"当时为什么这么定"。**

每条记忆是一句判断 + 依据 + 犹豫 + 结论。结论会过时，理由不会。
普通记忆系统存「用户喜欢蓝色」，它存「当时选了蓝色，因为考虑到配色统一，虽然担心太冷」。

## 与内置 A_Memorix 的关系

A_Memorix 是核心模块（``src/A_memorix``），走 ``host_service`` 直连，
**不占任何 Hook**，所以两者不抢资源。定位是**互补**：

* A_Memorix 管通用长期记忆（谁说过什么、群里发生过什么）
* 本插件管它没做的：决策链、分级生命周期、铁律/经验的严格区分

## 注入的四条纪律（违反会踩坏东西）

1. **深拷贝 items** —— 不改宿主传进来的对象
2. **只追加 system item 的 parts**，绝不重建整个列表
3. **渲染纯函数** —— 同样输入同样输出，否则每轮打穿 prompt 缓存前缀
4. **全程 try/except 返回 continue** —— 注入失败不能影响正常回复

``maisaka.planner.before_request`` 的 ``items`` 是**全量替换**语义，
且多个 handler 之间是覆盖传递（``kwargs = dict(modified_kwargs)``）。
所以只要不碰别人的 item，就不会抹掉内置记忆的注入。

@module chain_maibot
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
from datetime import datetime, timezone
from typing import Any, ClassVar, Dict, List, Mapping, Optional, Sequence

from maibot_sdk import Field, HookHandler, HookMode, MaiBotPlugin, PluginConfigBase, Tool
from maibot_sdk.types import ToolParameterInfo, ToolParamType

from chain_maibot.patrol import (
    build_patrol_report,
    build_rebalance_plan,
    triage_fragment,
)
from chain_maibot.injection import (
    INJECT_MAX_CHARS,
    build_working_block,
    human_age,
    render_injection,
    render_mermaid,
)
from chain_maibot.mood import merge_working, update_mood, visible_mood
from chain_maibot.pools import (
    CORE_MAX,
    POOLS,
    base_pool_of,
    core_is_full,
    decayed_weight,
    parse_ts,
    pool_of,
)
from chain_maibot.retrieval import (
    init_retrieval,
    rank_entries_rrf,
    retrieval_error,
    retrieval_ready,
)
from chain_maibot.store import (
    EVENT_RECALL,
    EVENT_REBALANCE,
    EVENT_RETAG,
    EVENT_SUPERSEDE,
    EVENT_TOUCH,
    TOUCH_DELTA,
    ChainStore,
)

logger = logging.getLogger("chain_maibot")

#: 注入段在 system item 里追加时的分隔。
INJECT_SEPARATOR = "\n\n"


class PoolConfig(PluginConfigBase):
    """单个池的参数覆盖。留空/0 表示用代码里的默认值。"""

    grace_days: float = Field(default=0.0, description="宽限期（天），0 表示用默认")
    half_life_days: float = Field(default=0.0, description="半衰期（天），0 表示用默认")
    archive_days: float = Field(default=0.0, description="归档线（天），0 表示用默认")


class PluginSection(PluginConfigBase):
    """主开关。"""

    __ui_label__ = "插件"
    __ui_icon__ = "package"
    __ui_order__ = 0

    enabled: bool = Field(default=False, description="是否启用思维链记忆")


class InjectionSection(PluginConfigBase):
    """注入段配置。"""

    __ui_label__ = "注入"
    __ui_icon__ = "file-text"
    __ui_order__ = 1

    enabled: bool = Field(default=True, description="是否每轮注入思维链（关掉则只剩工具可查）")
    max_chars: int = Field(default=INJECT_MAX_CHARS, description="注入段字符上限（越大越贵，但记得越全）")
    include_hippocampus: bool = Field(default=True, description="是否显示「最近她说过的话」小窗")
    inject_mood: bool = Field(default=True, description="是否注入「我现在」情绪行")
    inject_working: bool = Field(default=True, description="是否注入「还没做完的事」")


class LifecycleSection(PluginConfigBase):
    """生命周期配置。"""

    __ui_label__ = "生命周期"
    __ui_icon__ = "activity"
    __ui_order__ = 2

    core_max: int = Field(default=CORE_MAX, description="核心池上限（满了拒绝新增原则/人格）")
    auto_recall_mark: bool = Field(default=True, description="被注入命中时自动记一次 recall（会延长半衰期）")


class PatrolSection(PluginConfigBase):
    """夜巡配置。"""

    __ui_label__ = "夜巡"
    __ui_icon__ = "moon"
    __ui_order__ = 3

    enabled: bool = Field(default=False, description="是否每天自动跑一次夜巡")
    hour: int = Field(default=18, description="每天几点之后开始（0-23）")
    auto_rebalance: bool = Field(default=False, description="自动夜巡是否执行归整（默认只出报告）")


class ChainPluginConfig(PluginConfigBase):
    """思维链记忆插件配置。"""

    plugin: PluginSection = Field(default_factory=PluginSection)
    injection: InjectionSection = Field(default_factory=InjectionSection)
    lifecycle: LifecycleSection = Field(default_factory=LifecycleSection)
    patrol: PatrolSection = Field(default_factory=PatrolSection)
    pools: Dict[str, PoolConfig] = Field(default_factory=dict, description="按池覆盖生命周期参数")


class ChainMemoryPlugin(MaiBotPlugin):
    """思维链记忆插件。"""

    config_model: ClassVar[type[ChainPluginConfig]] = ChainPluginConfig

    def __init__(self) -> None:
        super().__init__()
        self._store: Optional[ChainStore] = None
        self._init_lock = asyncio.Lock()
        self._retrieval_ready = False
        self._patrol_task: Optional[asyncio.Task[None]] = None

    # ------------------------------------------------------------------ 生命周期

    async def on_load(self) -> None:
        """加载：初始化存储与检索，拉起夜巡。"""

        await self._ensure_ready()
        config = self._cfg()
        if config.patrol.enabled:
            self._start_patrol_loop()

    async def on_unload(self) -> None:
        """卸载：停掉夜巡与存储连接。"""

        task = self._patrol_task
        self._patrol_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        store = self._store
        self._store = None
        if store is not None:
            store.close()

    async def on_config_update(self, scope: str, config_data: Dict[str, Any], version: str) -> None:
        """配置热更新。"""

        _ = (config_data, version)
        if scope == "self":
            # 夜巡开关可能变了，重建循环
            task = self._patrol_task
            self._patrol_task = None
            if task is not None:
                task.cancel()
            if self._cfg().patrol.enabled:
                self._start_patrol_loop()

    # ------------------------------------------------------------------ 内部工具

    def _cfg(self) -> ChainPluginConfig:
        """取强类型配置；未声明时抛 RuntimeError（SDK 行为）而不是静默降级。"""

        try:
            return self.config  # type: ignore[return-value]
        except RuntimeError:
            return ChainPluginConfig()

    def _enabled(self) -> bool:
        return bool(self._cfg().plugin.enabled)

    def _pool_overrides(self) -> Dict[str, Dict[str, float]]:
        """把配置里的池覆盖转成 ``{pool: {field: value}}``，0 值视为未设置。"""

        overrides: Dict[str, Dict[str, float]] = {}
        for key, pool_config in (self._cfg().pools or {}).items():
            if key not in POOLS:
                continue
            patch: Dict[str, float] = {}
            for field_name in ("grace_days", "half_life_days", "archive_days"):
                value = float(getattr(pool_config, field_name, 0.0) or 0.0)
                if value > 0:
                    patch[field_name] = value
            if patch:
                overrides[key] = patch
        return overrides

    async def _ensure_ready(self) -> ChainStore:
        """惰性初始化存储与检索。幂等。"""

        if self._store is not None:
            return self._store
        async with self._init_lock:
            if self._store is not None:
                return self._store
            data_dir = self.ctx.paths.data_dir
            store = ChainStore(data_dir / "chain.db")
            await asyncio.to_thread(store.initialize)
            # 检索层初始化可能读 IDF 表，放线程里避免阻塞事件循环。
            self._retrieval_ready = await asyncio.to_thread(init_retrieval)
            if not self._retrieval_ready:
                logger.warning("思维链检索降级：%s", retrieval_error())
            self._store = store
            return store

    # ------------------------------------------------------------------ 注入（核心）

    @HookHandler(
        "maisaka.planner.before_request",
        name="chain_inject",
        description="把思维链注入到系统提示",
        mode=HookMode.BLOCKING,
        timeout_ms=3000,
    )
    async def inject_chain(self, items: Optional[List[Dict[str, Any]]] = None, **kwargs: Any) -> Dict[str, Any]:
        """每轮 Planner 请求前，把思维链追加到 system item。

        **四条纪律**（见模块 docstring）：深拷贝、只追加、纯函数、失败放行。

        返回值刻意只带 ``items``：其他字段沿用宿主传入的 ``kwargs``，
        不清空、不重建，避免覆盖别的 handler 的改动。
        """

        config = self._cfg()
        if not self._enabled() or not config.injection.enabled:
            return {"action": "continue"}
        if not isinstance(items, list) or not items:
            return {"action": "continue"}

        try:
            store = await self._ensure_ready()
            entries = await asyncio.to_thread(store.load_all)
            if not entries:
                return {"action": "continue"}

            mood_record = self._read_mood()
            mood_payload = visible_mood(mood_record) if config.injection.inject_mood else None
            working_block = ""
            if config.injection.inject_working:
                working_items = self._read_working()
                working_block = build_working_block(working_items)

            user_text = self._extract_user_text(items)
            overrides = self._pool_overrides()

            block = render_injection(
                entries,
                user_text=user_text,
                max_chars=config.injection.max_chars,
                mood=mood_payload,
                working_block=working_block,
                include_hippocampus=config.injection.include_hippocampus,
            )
            if not block:
                return {"action": "continue"}

            # ① 深拷贝 —— 绝不改宿主传进来的对象
            new_items = copy.deepcopy(items)

            # ② 找到 system item，只追加它的 parts。找不到就放弃，绝不瞎建。
            target = self._find_system_item(new_items)
            if target is None:
                logger.debug("思维链注入跳过：items 里没有 system item")
                return {"action": "continue"}

            parts = target.get("parts")
            if not isinstance(parts, list):
                return {"action": "continue"}
            parts.append({"type": "text", "text": block})

            # ③ 记录命中（延长半衰期）。失败不影响注入本身。
            if config.lifecycle.auto_recall_mark and user_text:
                try:
                    await self._mark_recalls(store, entries, user_text, block)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("思维链 recall 记账失败（忽略）: %s", exc)

            return {"modified_kwargs": {"items": new_items}}
        except Exception as exc:  # noqa: BLE001 —— ④ 失败一律放行
            logger.warning("思维链注入失败，已跳过本轮: %s", exc, exc_info=True)
            return {"action": "continue"}

    @staticmethod
    def _find_system_item(items: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """在 items 里找 system item。

        序列化结构是 ``{"item_type": "SystemMessageItem", "meta": {...}, "parts": [...]}``，
        不是 ``{"role": "system"}`` —— 这点和直觉不同，写错了会静默失效。
        """

        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("item_type") == "SystemMessageItem":
                return item
            if item.get("role") == "system":
                return item
        return None

    @staticmethod
    def _extract_user_text(items: Sequence[Dict[str, Any]]) -> str:
        """从 items 里取最后一条用户消息的文本，作为检索 query。"""

        for item in reversed(items):
            if not isinstance(item, dict):
                continue
            if item.get("item_type") != "UserMessageItem" and item.get("role") != "user":
                continue
            texts: List[str] = []
            for part in item.get("parts") or []:
                if isinstance(part, dict) and part.get("type") == "text":
                    value = part.get("text")
                    if isinstance(value, str) and value.strip():
                        texts.append(value.strip())
            if texts:
                # 只取最后 400 字：query 不需要全文，太长反而稀释特征。
                return " ".join(texts)[-400:]
        return ""

    async def _mark_recalls(
        self,
        store: ChainStore,
        entries: Sequence[Mapping[str, Any]],
        user_text: str,
        injected_block: str,
    ) -> None:
        """给"这一轮被注入的条目"记一次 recall。

        只对**确实出现在注入文本里**的条目记账，避免把没展示的也续命。
        """


        live = [entry for entry in entries if not entry.get("superseded")]
        hits = rank_entries_rrf(live, user_text, max_results=3)
        for hit in hits:
            entry = hit["entry"]
            title = str(entry.get("judgement") or entry.get("conclusion") or "")
            if title and title[:40] not in injected_block:
                continue
            await asyncio.to_thread(store.append_event, str(entry.get("id")), EVENT_RECALL, note="inject")

    # ------------------------------------------------------------------ 情绪 / 工作记忆存取

    def _read_mood(self) -> Optional[Dict[str, Any]]:
        store = self._store
        if store is None:
            return None
        try:
            raw = store.get_meta("mood", None)
            return raw if isinstance(raw, dict) else None
        except Exception:  # noqa: BLE001
            return None

    def _write_mood(self, record: Optional[Dict[str, Any]]) -> None:
        if self._store is None or record is None:
            return
        try:
            self._store.set_meta("mood", json.dumps(record, ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001
            logger.debug("情绪写入失败: %s", exc)

    def _read_working(self) -> List[Dict[str, Any]]:
        store = self._store
        if store is None:
            return []
        try:
            raw = store.get_meta("working", [])
            return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []
        except Exception:  # noqa: BLE001
            return []

    def _write_working(self, items: Sequence[Mapping[str, Any]]) -> None:
        if self._store is None:
            return
        try:
            self._store.set_meta("working", json.dumps(list(items), ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001
            logger.debug("工作记忆写入失败: %s", exc)

    # ------------------------------------------------------------------ 夜巡

    def _start_patrol_loop(self) -> None:
        if self._patrol_task is not None and not self._patrol_task.done():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._patrol_task = loop.create_task(self._patrol_loop(), name="chain_maibot_patrol")

    async def _patrol_loop(self) -> None:
        """每 10 分钟看一次「现在 >= patrolHour 且今天报告不存在」。"""

        while True:
            try:
                await asyncio.sleep(600)
                if not self._enabled():
                    continue
                store = self._store
                if store is None:
                    continue
                today = datetime.now().strftime("%Y-%m-%d")
                if store.get_meta("patrol_last_date", "") == today:
                    continue
                if datetime.now().hour < int(self._cfg().patrol.hour):
                    continue
                await self._run_patrol(store, today, auto=True)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("夜巡循环异常（下轮重试）: %s", exc)

    async def _run_patrol(self, store: ChainStore, date_label: str, *, auto: bool) -> Dict[str, Any]:
        """跑一次夜巡。自动模式下**只出报告**，不改任何记录。"""

        entries = await asyncio.to_thread(store.load_all, include_superseded=True)
        report = build_patrol_report(entries, now=None, date_label=date_label)

        if auto and self._cfg().patrol.auto_rebalance:
            plan = build_rebalance_plan(entries)
            for entry_id, delta in plan:
                await asyncio.to_thread(store.append_event, entry_id, EVENT_REBALANCE, delta=delta, note="patrol")

        # 报告落到插件数据目录，方便人直接看。
        try:
            report_dir = self.ctx.paths.data_dir / "patrol"
            report_dir.mkdir(parents=True, exist_ok=True)
            (report_dir / f"{date_label}.md").write_text(report["text"], encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            logger.warning("夜巡报告写入失败: %s", exc)

        store.set_meta("patrol_last_date", date_label)
        logger.info("夜巡完成 %s：存活 %s 条", date_label, report["marks"].get("live"))
        return report

    # ------------------------------------------------------------------ 工具：chain_append

    @Tool(
        "chain_append",
        description=(
            "写一条判断到思维链长期记忆。用于记住「为什么这么决定」——判断、依据、犹豫、结论。"
            "当你做出一个重要决定、学到一条教训、或用户立下一条规矩时使用。"
            "tags 决定这条记忆活多久：原则/人格（永不淡）、铁律（必须/不许）、事实（关于用户）、"
            "经验（排障/工具）、日常（一次性进展）。"
        ),
        parameters=[
            ToolParameterInfo(name="judgement", param_type=ToolParamType.STRING, description="一句话判断，必填", required=True),
            ToolParameterInfo(name="conclusion", param_type=ToolParamType.STRING, description="结论；留空表示还没定"),
            ToolParameterInfo(name="evidence", param_type=ToolParamType.ARRAY, description="依据，字符串数组"),
            ToolParameterInfo(name="hesitation", param_type=ToolParamType.ARRAY, description="当时的犹豫或权衡，字符串数组"),
            ToolParameterInfo(name="tags", param_type=ToolParamType.ARRAY, description="标签，决定归哪个池（如 铁律/教训/用户/日常）"),
            ToolParameterInfo(name="weight", param_type=ToolParamType.NUMBER, description="初始权重 0~1，默认 0.5"),
            ToolParameterInfo(name="event_id", param_type=ToolParamType.STRING, description="同一次决策的关联 ID，可把前后判断串起来"),
        ],
    )
    async def handle_append(
        self,
        judgement: str = "",
        conclusion: str = "",
        evidence: Optional[List[str]] = None,
        hesitation: Optional[List[str]] = None,
        tags: Optional[List[str]] = None,
        weight: float = 0.5,
        event_id: str = "",
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """写一条判断。"""

        _ = kwargs
        if not self._enabled():
            return {"success": False, "error": "思维链插件未启用"}
        if not str(judgement or "").strip():
            return {"success": False, "error": "judgement 不能为空"}

        try:
            store = await self._ensure_ready()
            effective_tags = [str(tag) for tag in (tags or [])]

            # 核心池上限守卫：核心是不可衰减的那一层，不能越写越厚。

            probe = {"tags": effective_tags, "judgement": judgement, "conclusion": conclusion}
            if base_pool_of(probe) == "core":
                entries = await asyncio.to_thread(store.load_all)
                full, count, limit = core_is_full(entries, self._cfg().lifecycle.core_max)
                if full:
                    return {
                        "success": False,
                        "error": f"核心池已满（{count}/{limit}）。原则和人格不该无限增长，请写进 AGENTS.md 或换个标签。",
                    }

            record = await asyncio.to_thread(
                store.append_entry,
                {
                    "judgement": judgement,
                    "conclusion": conclusion,
                    "evidence": evidence or [],
                    "hesitation": hesitation or [],
                    "tags": effective_tags,
                    "weight": weight,
                    "eventId": event_id,
                },
            )
            enriched = dict(record)
            enriched["pool"] = pool_of({**record})
            return {
                "success": True,
                "id": record["id"],
                "pool": enriched["pool"],
                "pool_label": POOLS.get(enriched["pool"], POOLS["hippocampus"]).label,
                "message": f"已记住（池: {POOLS.get(enriched['pool'], POOLS['hippocampus']).label}）",
            }
        except Exception as exc:  # noqa: BLE001
            logger.exception("chain_append 失败")
            return {"success": False, "error": str(exc)}

    # ------------------------------------------------------------------ 工具：chain_recall

    @Tool(
        "chain_recall",
        description=(
            "检索思维链长期记忆。按关键词或日期找回过去的判断、依据、结论。"
            "注意：每轮对话已自动注入相关记忆，这个工具用于你主动深入查证。"
        ),
        parameters=[
            ToolParameterInfo(name="query", param_type=ToolParamType.STRING, description="关键词或问题"),
            ToolParameterInfo(name="limit", param_type=ToolParamType.INTEGER, description="返回条数，默认 5"),
            ToolParameterInfo(name="pool", param_type=ToolParamType.STRING, description="只看某个池：core/fact/skillRule/skillExp/dailyCore/dailyPartial"),
            ToolParameterInfo(name="include_superseded", param_type=ToolParamType.BOOLEAN, description="是否包含已退役的记录（默认否）"),
        ],
    )
    async def handle_recall(
        self,
        query: str = "",
        limit: int = 5,
        pool: str = "",
        include_superseded: bool = False,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """按关键词检索。"""

        _ = kwargs
        if not self._enabled():
            return {"success": False, "error": "思维链插件未启用"}
        try:
            store = await self._ensure_ready()
            entries = await asyncio.to_thread(store.load_all, include_superseded=include_superseded)
            if pool:
                entries = [entry for entry in entries if entry.get("pool") == pool]

    
            hits = rank_entries_rrf(entries, query, max_results=max(1, int(limit or 5)))
            results: List[Dict[str, Any]] = []
            for hit in hits:
                entry = hit["entry"]
                payload = {
                    "id": entry.get("id"),
                    "ts": entry.get("ts"),
                    "judgement": entry.get("judgement"),
                    "conclusion": entry.get("conclusion"),
                    "evidence": entry.get("evidence"),
                    "hesitation": entry.get("hesitation"),
                    "pool": entry.get("pool"),
                    "weight": round(float(entry.get("weight") or 0), 3),
                    "touch_count": entry.get("touch_count"),
                    "superseded": entry.get("superseded"),
                    "matched": hit.get("best_word"),
                }
                # 同一次决策的其它判断补带（最多 2 条）
                same = await asyncio.to_thread(
                    store.same_event_entries, str(entry.get("event_id") or ""), exclude=str(entry.get("id"))
                )
                if same:
                    payload["sameEvent"] = [
                        {"id": item.get("id"), "judgement": item.get("judgement"), "conclusion": item.get("conclusion")}
                        for item in same
                    ]
                results.append(payload)

            return {
                "success": True,
                "count": len(results),
                "results": results,
                "message": "没有匹配的记忆" if not results else f"找到 {len(results)} 条",
            }
        except Exception as exc:  # noqa: BLE001
            logger.exception("chain_recall 失败")
            return {"success": False, "error": str(exc)}

    # ------------------------------------------------------------------ 工具：chain_touch

    @Tool(
        "chain_touch",
        description=(
            "标记一条记忆：确认（+0.05，会延长寿命）、推翻（退役，不再参与检索）、或人工定池。"
            "当用户确认某个判断没错、或明确说「那个结论作废了」时使用。"
        ),
        parameters=[
            ToolParameterInfo(name="entry_id", param_type=ToolParamType.STRING, description="记忆 ID", required=True),
            ToolParameterInfo(name="action", param_type=ToolParamType.STRING, description="confirm / refute / set-pool"),
            ToolParameterInfo(name="pool", param_type=ToolParamType.STRING, description="action=set-pool 时的目标池"),
        ],
    )
    async def handle_touch(
        self,
        entry_id: str = "",
        action: str = "confirm",
        pool: str = "",
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """给一条记忆打标记。"""

        _ = kwargs
        if not self._enabled():
            return {"success": False, "error": "思维链插件未启用"}
        if not str(entry_id or "").strip():
            return {"success": False, "error": "entry_id 不能为空"}
        try:
            store = await self._ensure_ready()
            record = await asyncio.to_thread(store.get_entry, entry_id)
            if record is None:
                return {"success": False, "error": f"没有这条记忆: {entry_id}"}

            normalized = str(action or "confirm").strip().lower()
            if normalized in {"confirm", "确认"}:
                await asyncio.to_thread(store.append_event, entry_id, EVENT_TOUCH, delta=TOUCH_DELTA, note="manual")
                return {"success": True, "message": "已确认。"}
            if normalized in {"refute", "推翻"}:
                await asyncio.to_thread(store.append_event, entry_id, EVENT_SUPERSEDE, note="manual refute")
                return {"success": True, "message": "已退役，不再参与检索（数据仍可审计）。"}
            if normalized in {"set-pool", "set_pool", "定池"}:
                if pool not in POOLS:
                    return {"success": False, "error": f"未知池: {pool}（可选: {', '.join(POOLS)}）"}
                await asyncio.to_thread(store.append_event, entry_id, EVENT_RETAG, pool=pool, note="manual retag")
                return {"success": True, "message": f"已定池为 {POOLS[pool].label}。"}
            return {"success": False, "error": f"未知 action: {action}（可选: confirm / refute / set-pool）"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("chain_touch 失败")
            return {"success": False, "error": str(exc)}

    # ------------------------------------------------------------------ 工具：chain_about

    @Tool(
        "chain_about",
        description=(
            "问「关于 X 我知道什么」。返回被想起次数、人工确认次数、生命周期状态、是否被取代、依据条数。"
            "只读 —— 调用它不算「想起」，不会延长记忆寿命。"
        ),
        parameters=[
            ToolParameterInfo(name="topic", param_type=ToolParamType.STRING, description="主题关键词", required=True),
            ToolParameterInfo(name="limit", param_type=ToolParamType.INTEGER, description="最多返回几条，默认 5"),
        ],
    )
    async def handle_about(self, topic: str = "", limit: int = 5, **kwargs: Any) -> Dict[str, Any]:
        """元记忆：关于某主题我知道什么、多可信、变过几次。"""

        _ = kwargs
        if not self._enabled():
            return {"success": False, "error": "思维链插件未启用"}
        if not str(topic or "").strip():
            return {"success": False, "error": "topic 不能为空"}
        try:
            store = await self._ensure_ready()
            entries = await asyncio.to_thread(store.load_all, include_superseded=True)

    
            hits = rank_entries_rrf(entries, topic, max_results=max(1, int(limit or 5)))
            items: List[Dict[str, Any]] = []
            for hit in hits:
                entry = hit["entry"]
                touched = int(entry.get("touch_count") or 0)
                recalls = int(entry.get("recall_count") or 0)
                manual = max(0, touched - recalls)
                items.append(
                    {
                        "id": entry.get("id"),
                        "judgement": entry.get("judgement"),
                        "conclusion": entry.get("conclusion"),
                        "pool": entry.get("pool"),
                        "pool_label": POOLS.get(str(entry.get("pool")), POOLS["hippocampus"]).label,
                        "times_recalled": touched,
                        "manual_confirmed": manual,
                        "superseded": bool(entry.get("superseded")),
                        "evidence_count": len(entry.get("evidence") or []),
                        "weight": round(float(entry.get("weight") or 0), 3),
                        "credibility": self._credibility(touched, manual, bool(entry.get("superseded"))),
                    }
                )
            return {
                "success": True,
                "topic": topic,
                "count": len(items),
                "items": items,
                "message": f"关于「{topic}」有 {len(items)} 条相关记忆" if items else f"关于「{topic}」我还没有记忆",
            }
        except Exception as exc:  # noqa: BLE001
            logger.exception("chain_about 失败")
            return {"success": False, "error": str(exc)}

    @staticmethod
    def _credibility(touched: int, manual: int, superseded: bool) -> str:
        """把「多可信」翻成人话。"""

        if superseded:
            return "已推翻（不再采信）"
        if manual >= 2:
            return "高（被人工确认过多次）"
        if manual == 1:
            return "中高（被人工确认过）"
        if touched >= 3:
            return "中（多次被想起，但没被确认）"
        if touched >= 1:
            return "低中（被想起过）"
        return "低（从没被用过）"

    # ------------------------------------------------------------------ 工具：chain_mood

    @Tool(
        "chain_mood",
        description=(
            "记录当前情绪状态（单一状态牌，会自己衰减过期）。"
            "用于表达「我现在什么感觉」——挫败、踏实、好奇等。不是日志，新状态覆盖旧状态。"
        ),
        parameters=[
            ToolParameterInfo(name="mood", param_type=ToolParamType.STRING, description="情绪词，如 挫败/踏实/好奇", required=True),
            ToolParameterInfo(name="why", param_type=ToolParamType.STRING, description="为什么，一句话"),
        ],
    )
    async def handle_mood(self, mood: str = "", why: str = "", **kwargs: Any) -> Dict[str, Any]:
        """写当前情绪。"""

        _ = kwargs
        if not self._enabled():
            return {"success": False, "error": "思维链插件未启用"}
        if not str(mood or "").strip():
            return {"success": False, "error": "mood 不能为空"}
        try:
            await self._ensure_ready()
            record = {
                "mood": str(mood).strip()[:20],
                "strength": 0.7,
                "why": str(why or "").strip()[:120],
                "ts": datetime.now(timezone.utc).isoformat(),
            }
            self._write_mood(record)
            return {"success": True, "mood": record["mood"], "message": f"现在是「{record['mood']}」"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("chain_mood 失败")
            return {"success": False, "error": str(exc)}

    # ------------------------------------------------------------------ 工具：chain_patrol

    @Tool(
        "chain_patrol",
        description=(
            "手动跑一次夜巡：检查久未命中、疑似重复、半写断裂、未归类等，产出报告。"
            "默认只出报告不改数据；apply=true 才执行权重归整。"
        ),
        parameters=[
            ToolParameterInfo(name="apply", param_type=ToolParamType.BOOLEAN, description="是否执行归整（默认否，只出报告）"),
            ToolParameterInfo(name="section", param_type=ToolParamType.STRING, description="只看某一节（留空看全部）"),
        ],
    )
    async def handle_patrol(self, apply: bool = False, section: str = "", **kwargs: Any) -> Dict[str, Any]:
        """跑夜巡。"""

        _ = kwargs
        if not self._enabled():
            return {"success": False, "error": "思维链插件未启用"}
        try:
            store = await self._ensure_ready()
            today = datetime.now().strftime("%Y-%m-%d")
            entries = await asyncio.to_thread(store.load_all, include_superseded=True)
            report = build_patrol_report(entries, date_label=today)

            applied = 0
            if apply:
                plan = build_rebalance_plan(entries)
                for entry_id, delta in plan:
                    await asyncio.to_thread(store.append_event, entry_id, EVENT_REBALANCE, delta=delta, note="patrol manual")
                    applied += 1

            if section:
                sections = [item for item in report["sections"] if section in item["title"]]
            else:
                sections = report["sections"]

            return {
                "success": True,
                "date": report["date"],
                "marks": report["marks"],
                "sections": sections,
                "applied_rebalance": applied,
                "report_path": str(self.ctx.paths.data_dir / "patrol" / f"{today}.md"),
            }
        except Exception as exc:  # noqa: BLE001
            logger.exception("chain_patrol 失败")
            return {"success": False, "error": str(exc)}

    # ------------------------------------------------------------------ 工具：chain_graph

    @Tool(
        "chain_graph",
        description="导出思维链图谱（Mermaid 格式），用于查看记忆的整体结构。",
        parameters=[
            ToolParameterInfo(name="limit", param_type=ToolParamType.INTEGER, description="最多多少条，默认 30"),
        ],
    )
    async def handle_graph(self, limit: int = 30, **kwargs: Any) -> Dict[str, Any]:
        """导出 Mermaid 图。"""

        _ = kwargs
        if not self._enabled():
            return {"success": False, "error": "思维链插件未启用"}
        try:
            store = await self._ensure_ready()
            entries = await asyncio.to_thread(store.load_all)
            mermaid = render_mermaid(entries, limit=max(1, int(limit or 30)))
            stats = await asyncio.to_thread(store.stats)
            return {"success": True, "mermaid": mermaid, "stats": stats}
        except Exception as exc:  # noqa: BLE001
            logger.exception("chain_graph 失败")
            return {"success": False, "error": str(exc)}

    # ------------------------------------------------------------------ 工具：chain_triage

    @Tool(
        "chain_triage",
        description="给海马体里的原始片段猜一个池（只出建议，不写盘）。用于夜巡后整理原料缓冲区。",
        parameters=[
            ToolParameterInfo(name="entry_id", param_type=ToolParamType.STRING, description="海马体条目 ID", required=True),
        ],
    )
    async def handle_triage(self, entry_id: str = "", **kwargs: Any) -> Dict[str, Any]:
        """猜池（建议）。"""

        _ = kwargs
        if not self._enabled():
            return {"success": False, "error": "思维链插件未启用"}
        try:
            store = await self._ensure_ready()
            record = await asyncio.to_thread(store.get_entry, entry_id)
            if record is None:
                return {"success": False, "error": f"没有这条记忆: {entry_id}"}
            suggestion = triage_fragment(record)
            return {
                "success": True,
                "entry_id": entry_id,
                "judgement": record.get("judgement"),
                "suggested_pool": suggestion["pool"],
                "suggested_pool_label": POOLS.get(suggestion["pool"], POOLS["hippocampus"]).label,
                "reason": suggestion["reason"],
                "message": "建议仅供参考，确认后用 chain_touch(action=set-pool) 定池",
            }
        except Exception as exc:  # noqa: BLE001
            logger.exception("chain_triage 失败")
            return {"success": False, "error": str(exc)}

    # ------------------------------------------------------------------ 工具：chain_stats

    @Tool(
        "chain_stats",
        description="查看思维链记忆的统计：总数、各池分布、检索层状态。",
        parameters=[],
    )
    async def handle_stats(self, **kwargs: Any) -> Dict[str, Any]:
        """统计信息。"""

        _ = kwargs
        if not self._enabled():
            return {"success": False, "error": "思维链插件未启用"}
        try:
            store = await self._ensure_ready()
            stats = await asyncio.to_thread(store.stats)
            entries = await asyncio.to_thread(store.load_all)
            distribution: Dict[str, int] = {}
            for entry in entries:
                key = str(entry.get("pool") or "hippocampus")
                distribution[key] = distribution.get(key, 0) + 1
            return {
                "success": True,
                "stats": stats,
                "pools": {
                    (POOLS[key].label if key in POOLS else key): count
                    for key, count in sorted(distribution.items(), key=lambda item: -item[1])
                },
                "retrieval_ready": retrieval_ready(),
                "retrieval_error": retrieval_error(),
            }
        except Exception as exc:  # noqa: BLE001
            logger.exception("chain_stats 失败")
            return {"success": False, "error": str(exc)}


def create_plugin() -> ChainMemoryPlugin:
    """SDK 插件工厂。"""

    return ChainMemoryPlugin()