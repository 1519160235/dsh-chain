"""mai_chain 核心算法包。

移植自 `canglight/dsh-chain <https://github.com/canglight/dsh-chain>`_（MIT License，
Copyright (c) 2026 末苍和她的大肥鱼）。

本包只包含**与框架无关的纯逻辑**：分池衰减、RRF 检索、字符装箱、夜巡检查。
不含任何 DSH 或 MaiBot 的 API 调用，因此可以独立单测。
"""

from __future__ import annotations

__version__ = "0.1.0"

__all__ = [
    "pools",
    "retrieval",
    "store",
    "injection",
    "mood",
    "patrol",
]