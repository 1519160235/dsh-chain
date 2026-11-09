"""存储层：SQLite 三表 + 事件溯源 —— 移植自 dsh-chain 的 ``lib/store.js``。

## 为什么改成 SQLite

上游用 JSONL 的三条理由（追加 O(1)、一行坏只丢一行、可 grep）都成立，
但那是**单进程 CLI 工具**的取舍。插件运行在 RPC 子进程里，且要跨重启保留状态：

* SQLite 有真正的跨进程事务（WAL 模式），不怕宿主的并发读；
* 索引让 ``superseded=0`` 这类高频过滤不必全表扫描（上游自己也承认
  "真到几万条时再加尾部索引"，这里一步到位）；
* ``(pool, last_touched)`` 复合索引直接支撑注入装箱的排序。

## 事件溯源保持不变

记录不直接改，而是**追加事件 + 派生状态**。这是上游最值得抄的设计之一：

* ``touch``    人工确认，``delta>0``
* ``recall``   自动命中，``delta=0`` —— **不算人工确认**
* ``supersede`` 退役，权重压到 0.1
* ``rebalance`` 权重归整，**只动权重、不碰正文、不算被想起**
* ``retag``    人工定池

派生规则记在 :func:`materialize`，与上游一模一样。
一个专门修过的坑：**判"人工确认"只能用 ``delta>0``**。
上游原来任何 touch 都写 ``lastManualTouched``，导致自动命中也被算成"被验证过"，
元记忆的「多可信」就失真了。
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Tuple

logger = logging.getLogger("chain_maibot.store")

#: 单字段长度上限。超出截断而不是拒绝 —— 丢内容比丢整条记录更可接受。
FIELD_MAX = 2000

#: 列表型字段（evidence / hesitation / tags）最多保留几项。
LIST_MAX = 16

#: 事件类型。
EVENT_TOUCH = "touch"
EVENT_RECALL = "recall"
EVENT_SUPERSEDE = "supersede"
EVENT_REBALANCE = "rebalance"
EVENT_RETAG = "retag"
EVENT_TYPES = frozenset({EVENT_TOUCH, EVENT_RECALL, EVENT_SUPERSEDE, EVENT_REBALANCE, EVENT_RETAG})

#: 人工确认的加分（与上游一致）。
TOUCH_DELTA = 0.05

#: 被取代后的权重上限。
SUPERSEDED_WEIGHT = 0.1

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    id            TEXT PRIMARY KEY,
    ts            TEXT NOT NULL,
    judgement     TEXT NOT NULL DEFAULT '',
    conclusion    TEXT NOT NULL DEFAULT '',
    evidence      TEXT NOT NULL DEFAULT '[]',
    hesitation    TEXT NOT NULL DEFAULT '[]',
    tags          TEXT NOT NULL DEFAULT '[]',
    weight        REAL NOT NULL DEFAULT 0.5,
    superseded    INTEGER NOT NULL DEFAULT 0,
    pool_override TEXT NOT NULL DEFAULT '',
    event_id      TEXT NOT NULL DEFAULT '',
    created_at    REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_entries_live
    ON entries (superseded, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_event
    ON entries (event_id) WHERE event_id <> '';

CREATE TABLE IF NOT EXISTS events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT NOT NULL,
    type       TEXT NOT NULL,
    ts         TEXT NOT NULL,
    delta      REAL NOT NULL DEFAULT 0,
    pool       TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_events_id ON events (id, seq);

CREATE TABLE IF NOT EXISTS edges (
    src     TEXT NOT NULL,
    dst     TEXT NOT NULL,
    kind    TEXT NOT NULL DEFAULT 'related',
    weight  REAL NOT NULL DEFAULT 0.5,
    created_at REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (src, dst, kind)
);

CREATE INDEX IF NOT EXISTS idx_edges_src ON edges (src, weight DESC);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges (dst, weight DESC);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_text(value: Any, *, limit: int = FIELD_MAX) -> str:
    """规范化单行文本：压掉多余空白、截断超长。"""

    text = " ".join(str(value or "").split())
    return text[:limit]


def clean_list(value: Any, *, limit: int = LIST_MAX) -> List[str]:
    """规范化列表字段：去空、去重、保序、截断。"""

    if isinstance(value, str):
        items: Iterable[Any] = [value]
    elif isinstance(value, (list, tuple, set)):
        items = value
    else:
        return []
    out: List[str] = []
    seen: set[str] = set()
    for item in items:
        text = clean_text(item, limit=FIELD_MAX // 2)
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
        if len(out) >= limit:
            break
    return out


def clamp_weight(value: Any, default: float = 0.5) -> float:
    """把权重夹进 0~1；非法值退回默认。"""

    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:  # NaN
        return default
    return min(1.0, max(0.0, number))


class ChainStore:
    """SQLite 存储。线程安全（每线程独立连接 + WAL）。"""

    def __init__(self, db_path: Path) -> None:
        self._path = Path(db_path)
        self._local = threading.local()
        self._init_lock = threading.Lock()
        self._initialized = False

    # ------------------------------------------------------------------ 连接

    @property
    def path(self) -> Path:
        return self._path

    def _connect(self) -> sqlite3.Connection:
        cached: Optional[sqlite3.Connection] = getattr(self._local, "conn", None)
        if cached is not None:
            return cached
        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self._path, timeout=10.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        # WAL：宿主与插件子进程并发读时不互相阻塞。
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        self._local.conn = conn
        return conn

    def initialize(self) -> None:
        """建表。幂等，可在每次 on_load 调用。"""

        with self._init_lock:
            if self._initialized:
                return
            conn = self._connect()
            conn.executescript(SCHEMA)
            self._initialized = True

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        """显式事务。autocommit 模式下用 BEGIN IMMEDIATE 拿写锁。"""

        conn = self._connect()
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except Exception:
            conn.execute("ROLLBACK")
            raise
        else:
            conn.execute("COMMIT")

    def close(self) -> None:
        cached: Optional[sqlite3.Connection] = getattr(self._local, "conn", None)
        if cached is not None:
            try:
                cached.close()
            finally:
                self._local.conn = None

    # ------------------------------------------------------------------ 写入

    def append_entry(self, payload: Mapping[str, Any]) -> Dict[str, Any]:
        """追加一条判断。返回落库后的记录。"""

        self.initialize()
        entry_id = str(payload.get("id") or uuid.uuid4().hex)
        record = {
            "id": entry_id,
            "ts": str(payload.get("ts") or _utc_now_iso()),
            "judgement": clean_text(payload.get("judgement")),
            "conclusion": clean_text(payload.get("conclusion")),
            "evidence": clean_list(payload.get("evidence")),
            "hesitation": clean_list(payload.get("hesitation")),
            "tags": clean_list(payload.get("tags")),
            "weight": clamp_weight(payload.get("weight")),
            "superseded": 0,
            "pool_override": "",
            "event_id": clean_text(payload.get("eventId") or payload.get("event_id"), limit=128),
            "created_at": datetime.now(timezone.utc).timestamp(),
        }
        with self._tx() as conn:
            conn.execute(
                """
                INSERT INTO entries
                    (id, ts, judgement, conclusion, evidence, hesitation,
                     tags, weight, superseded, pool_override, event_id, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    record["id"], record["ts"], record["judgement"], record["conclusion"],
                    json.dumps(record["evidence"], ensure_ascii=False),
                    json.dumps(record["hesitation"], ensure_ascii=False),
                    json.dumps(record["tags"], ensure_ascii=False),
                    record["weight"], record["superseded"], record["pool_override"],
                    record["event_id"], record["created_at"],
                ),
            )
        return record

    def append_event(
        self,
        entry_id: str,
        event_type: str,
        *,
        delta: float = 0.0,
        pool: str = "",
        note: str = "",
        ts: Optional[str] = None,
    ) -> None:
        """追加一条生命周期事件。"""

        if event_type not in EVENT_TYPES:
            raise ValueError(f"未知事件类型: {event_type}")
        self.initialize()
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO events (id, type, ts, delta, pool, note) VALUES (?,?,?,?,?,?)",
                (str(entry_id), event_type, ts or _utc_now_iso(), float(delta), str(pool), clean_text(note, limit=500)),
            )
            # supersede 需要同步落一个冗余位，否则"活着的条目"查询要连表。
            if event_type == EVENT_SUPERSEDE:
                conn.execute("UPDATE entries SET superseded = 1 WHERE id = ?", (str(entry_id),))
            elif event_type == EVENT_RETAG and pool:
                conn.execute("UPDATE entries SET pool_override = ? WHERE id = ?", (str(pool), str(entry_id)))

    def add_edge(self, src: str, dst: str, *, kind: str = "related", weight: float = 0.5) -> None:
        """加一条联想边（无向，存双向两条）。"""

        self.initialize()
        now = datetime.now(timezone.utc).timestamp()
        pairs = [(str(src), str(dst)), (str(dst), str(src))]
        with self._tx() as conn:
            for left, right in pairs:
                conn.execute(
                    """
                    INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?,?,?,?,?)
                    ON CONFLICT(src, dst, kind) DO UPDATE SET weight = max(edges.weight, excluded.weight)
                    """,
                    (left, right, str(kind), clamp_weight(weight), now),
                )

    # ------------------------------------------------------------------ 读取

    def _row_to_entry(self, row: sqlite3.Row) -> Dict[str, Any]:
        def _loads(raw: str) -> List[str]:
            try:
                parsed = json.loads(raw or "[]")
            except (ValueError, TypeError):
                return []
            return [str(item) for item in parsed] if isinstance(parsed, list) else []

        return {
            "id": row["id"],
            "ts": row["ts"],
            "judgement": row["judgement"],
            "conclusion": row["conclusion"],
            "evidence": _loads(row["evidence"]),
            "hesitation": _loads(row["hesitation"]),
            "tags": _loads(row["tags"]),
            "weight": float(row["weight"]),
            "superseded": bool(row["superseded"]),
            "pool_override": row["pool_override"],
            "event_id": row["event_id"],
            "created_at": float(row["created_at"]),
        }

    def load_all(self, *, include_superseded: bool = False) -> List[Dict[str, Any]]:
        """读全部记录，并归并事件派生字段（``touch_count`` / ``last_touched`` 等）。"""

        self.initialize()
        conn = self._connect()
        sql = "SELECT * FROM entries"
        if not include_superseded:
            sql += " WHERE superseded = 0"
        sql += " ORDER BY created_at DESC"
        rows = conn.execute(sql).fetchall()
        entries = [self._row_to_entry(row) for row in rows]
        return self.materialize(entries)

    def get_entry(self, entry_id: str) -> Optional[Dict[str, Any]]:
        """按 id 取单条（含派生态）。"""

        self.initialize()
        conn = self._connect()
        row = conn.execute("SELECT * FROM entries WHERE id = ?", (str(entry_id),)).fetchone()
        if row is None:
            return None
        return self.materialize([self._row_to_entry(row)])[0]

    def event_counts(self) -> Dict[str, Dict[str, float]]:
        """每条记录的事件汇总：``{id: {touch_count, recall_count, touch_delta, last_touched, last_manual, rebalance_sum}}``"""

        self.initialize()
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT id, type, ts, delta FROM events ORDER BY seq ASC
            """
        ).fetchall()
        state: Dict[str, Dict[str, float]] = {}
        for row in rows:
            entry_id = str(row["id"])
            bucket = state.setdefault(
                entry_id,
                {
                    "touch_count": 0.0,
                    "recall_count": 0.0,
                    "touch_delta": 0.0,
                    "rebalance_sum": 0.0,
                    "last_touched_ts": 0.0,
                    "last_manual_ts": 0.0,
                    "last_touched": "",
                },
            )
            event_type = str(row["type"])
            ts = str(row["ts"] or "")
            if event_type == EVENT_TOUCH:
                bucket["touch_count"] += 1
                bucket["touch_delta"] += float(row["delta"] or 0)
                bucket["last_touched"] = max(bucket["last_touched"], ts)
                # **只有 delta>0 才算人工确认** —— 自动命中的 delta 恒为 0。
                if float(row["delta"] or 0) > 0:
                    bucket["last_manual_ts"] = max(bucket["last_manual_ts"], _iso_to_epoch(ts))
            elif event_type == EVENT_RECALL:
                # 自动命中**也算被想起**（touch_count 一起涨），但不算人工确认。
                bucket["touch_count"] += 1
                bucket["recall_count"] += 1
                bucket["last_touched"] = max(bucket["last_touched"], ts)
            elif event_type == EVENT_REBALANCE:
                # 只累计权重偏移，**绝不更新 last_touched** —— 归整不是"被想起"。
                bucket["rebalance_sum"] += float(row["delta"] or 0)
        return state

    def materialize(self, entries: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """把事件流归并进记录，派生 ``touch_count`` / ``last_touched`` / ``pool`` / 衰减后权重。"""

        from .pools import decayed_weight, parse_ts, pool_of  # noqa: PLC0415 — 避免循环导入

        counts = self.event_counts()
        out: List[Dict[str, Any]] = []
        for entry in entries:
            bucket = counts.get(str(entry["id"]))
            touch_count = int(bucket["touch_count"]) if bucket else 0
            last_touched = ""
            touch_delta = 0.0
            rebalance_sum = 0.0
            if bucket:
                last_touched = str(bucket["last_touched"] or "")
                touch_delta = float(bucket["touch_delta"] or 0)
                rebalance_sum = float(bucket["rebalance_sum"] or 0)

            enriched = dict(entry)
            enriched["touch_count"] = touch_count
            enriched["last_touched"] = last_touched or entry["ts"]
            enriched["pool"] = pool_of(enriched)

            base_weight = clamp_weight(entry["weight"])
            if entry["superseded"]:
                enriched["raw_weight"] = base_weight
                enriched["weight"] = SUPERSEDED_WEIGHT
            else:
                reinforced = clamp_weight(base_weight + touch_delta + rebalance_sum)
                enriched["raw_weight"] = base_weight
                enriched["weight"] = decayed_weight(
                    reinforced,
                    parse_ts(enriched["last_touched"]) or parse_ts(entry["ts"]),
                    enriched["pool"],
                    touch_count,
                )
            out.append(enriched)
        return out

    def edges_of(self, entry_id: str, *, limit: int = 8) -> List[Dict[str, Any]]:
        """取一条记忆的联想边。"""

        self.initialize()
        conn = self._connect()
        rows = conn.execute(
            "SELECT dst, kind, weight FROM edges WHERE src = ? ORDER BY weight DESC LIMIT ?",
            (str(entry_id), int(limit)),
        ).fetchall()
        return [{"dst": row["dst"], "kind": row["kind"], "weight": float(row["weight"])} for row in rows]

    def same_event_entries(self, event_id: str, *, exclude: str = "", limit: int = 2) -> List[Dict[str, Any]]:
        """同一 ``eventId`` 下的其它活记录（``chain_recall`` 补带用）。"""

        if not str(event_id or "").strip():
            return []
        self.initialize()
        conn = self._connect()
        rows = conn.execute(
            """
            SELECT * FROM entries
            WHERE event_id = ? AND superseded = 0 AND id <> ?
            ORDER BY created_at DESC LIMIT ?
            """,
            (str(event_id), str(exclude), int(limit)),
        ).fetchall()
        return self.materialize([self._row_to_entry(row) for row in rows])

    def stats(self) -> Dict[str, Any]:
        """库概况（给 WebUI / 日志看）。"""

        self.initialize()
        conn = self._connect()
        total = conn.execute("SELECT count(*) AS n FROM entries").fetchone()["n"]
        live = conn.execute("SELECT count(*) AS n FROM entries WHERE superseded = 0").fetchone()["n"]
        events = conn.execute("SELECT count(*) AS n FROM events").fetchone()["n"]
        edges = conn.execute("SELECT count(*) AS n FROM edges").fetchone()["n"]
        return {"total": int(total), "live": int(live), "events": int(events), "edges": int(edges), "path": str(self._path)}

    # ------------------------------------------------------------------ meta

    def set_meta(self, key: str, value: Any) -> None:
        """写一条插件级元数据（如夜巡最后运行日期）。"""

        self.initialize()
        with self._tx() as conn:
            conn.execute(
                "INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(key), json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value),
            )

    def get_meta(self, key: str, default: Any = None) -> Any:
        """读插件级元数据。"""

        self.initialize()
        conn = self._connect()
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (str(key),)).fetchone()
        if row is None:
            return default
        raw = row["value"]
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return raw


def _iso_to_epoch(value: str) -> float:
    """ISO → epoch 秒；失败返回 0。"""

    from .pools import parse_ts  # noqa: PLC0415

    parsed = parse_ts(value)
    return parsed if parsed is not None else 0.0