"""校验 webui.json 的字段引用与插件实际返回是否一致。

为什么需要它
------------
面板前端（``dashboard/src/lib/plugin-webui.ts``）解析引用时是**抛错**的：

```ts
if (value === null || typeof value !== 'object' || !Object.hasOwn(value, field)) {
  throw new Error(`Missing data field: ${reference.source}.${reference.field}`)
}
```

一旦抛出，就被 ErrorBoundary 接住，页面显示一句
**「插件返回的数据与组件声明不一致」**——不告诉你缺哪个字段。

实际踩过的坑：``webui_patrol`` 的空态分支少返回一个 ``date``，
夜巡页在「还没跑过」的状态下整页打不开，而正常分支又是好的。

所以把「声明」和「返回」做一次机器比对，而不是靠肉眼看 JSON。

用法
----
    python tools/check_webui.py            # 全量检查
    python tools/check_webui.py -v         # 打印每个引用

退出码：0 全通过 / 1 有缺失 / 2 运行失败。
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import inspect
import json
import logging
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Tuple

PLUGIN_DIR = Path(__file__).resolve().parent.parent


def default_data_dir() -> Path | None:
    """推断插件在实例里的真实数据目录。找不到就返回 None（用临时目录）。"""

    candidates = []
    env = os.environ.get("MAIBOT_INSTANCE_DIR")
    if env:
        candidates.append(Path(env) / "data" / "plugins" / "maibot.mai-chain")
    # tools/check_webui.py -> 插件目录 -> plugins/ -> 实例根
    plugin_dir = PLUGIN_DIR
    if len(plugin_dir.parents) >= 2:
        candidates.append(plugin_dir.parents[1] / "data" / "plugins" / "maibot.mai-chain")
    candidates.append(Path(r"E://mai//data//plugins//maibot.mai-chain"))

    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return None


def load_plugin_module(plugin_dir: Path):
    """按宿主的方式加载 plugin.py（子包搜索路径指向插件目录）。"""

    sys.path.insert(0, str(plugin_dir.parent))
    spec = importlib.util.spec_from_file_location(
        "mai_chain_probe",
        plugin_dir / "plugin.py",
        submodule_search_locations=[str(plugin_dir)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("无法构造插件模块的 spec")
    module = importlib.util.module_from_spec(spec)
    sys.modules["mai_chain_probe"] = module
    spec.loader.exec_module(module)
    return module


class _Paths:
    def __init__(self, directory: Path) -> None:
        self.data_dir = directory
        self.runtime_dir = directory


class _Ctx:
    """最小 ctx：只要 paths 和 logger。"""

    def __init__(self, directory: Path) -> None:
        self.paths = _Paths(directory)
        self.logger = logging.getLogger("check_webui")


def iter_references(node: Any, label: str = "") -> List[Tuple[str, Dict[str, Any]]]:
    """递归收集节点里的 DataReference（value 与 when.reference 两种写法）。"""

    found: List[Tuple[str, Dict[str, Any]]] = []
    if isinstance(node, dict):
        value = node.get("value")
        # 注意：scope 可以省略（默认 data），所以只看有没有 source。
        # 之前这里写成 `"scope" in (value.get("scope"), "data", None)` —— 那是在判断
        # 字符串 "scope" 是否在元组里，恒为假，把所有引用都漏掉了。
        if isinstance(value, dict) and "source" in value:
            found.append((label or str(node.get("label") or node.get("type")), value))
        when = node.get("when")
        if isinstance(when, dict) and isinstance(when.get("reference"), dict):
            found.append((f"{label}(when)", when["reference"]))
        for key in ("children", "content"):
            child = node.get(key)
            if isinstance(child, list):
                for item in child:
                    found.extend(iter_references(item, label))
        # children 之外的嵌套结构（tabs 的 panels、repeat 的 item 等）
        for key, child in node.items():
            if key in {"value", "when", "children", "content"}:
                continue
            if isinstance(child, (dict, list)):
                found.extend(iter_references(child, label))
    elif isinstance(node, list):
        for item in node:
            found.extend(iter_references(item, label))
    return found


def resolve(reference: Dict[str, Any], data: Dict[str, Any]) -> Tuple[bool, str]:
    """完全按前端 resolveReference 的规则走一遍（scope=data 情形）。"""

    source_name = reference.get("source")
    if source_name not in data:
        return False, f"缺少数据源 {source_name}"

    value: Any = data[source_name]
    for field in (reference.get("field") or "").split("."):
        if not field:
            continue
        if value is None or not isinstance(value, (dict, list)) or field not in value:
            return False, f"{source_name}.{reference.get('field')}"
        value = value[field]
    return True, ""


def row_fields(data: Dict[str, Any]) -> set:
    """把各查询里出现的行字段并起来，用来校验 scope=selection 的引用。"""

    fields = set()
    for payload in data.values():
        if not isinstance(payload, dict):
            continue
        for key in ("rows", "recent", "pools", "pool_chart", "sections"):
            rows = payload.get(key)
            if isinstance(rows, list):
                for row in rows:
                    if isinstance(row, dict):
                        fields.update(row.keys())
    return fields


async def check(plugin_dir: Path, verbose: bool, data_dir: Path | None) -> int:
    manifest = json.loads((plugin_dir / "webui.json").read_text(encoding="utf-8"))
    module = load_plugin_module(plugin_dir)

    instance = module.create_plugin()
    # 默认用真实数据目录：空库时列表页没有行，选中行的字段就无从校验，
    # 而「空态少字段」正是之前整页打不开的原因，必须用有数据的状态验证。
    instance._ctx = _Ctx(data_dir or Path(tempfile.mkdtemp(prefix="check_webui_")))
    config = module.MaiChainConfig()
    config.plugin.enabled = True
    instance._plugin_config_instance = config

    problems: List[str] = []
    total = 0
    skipped = 0

    for page in manifest.get("pages", []):
        if page.get("mode") == "custom":
            continue
        page_id = page.get("id", "?")
        queries = page.get("queries") or {}

        # 1) 逐个查询取真实返回
        data: Dict[str, Any] = {}
        for name, binding in queries.items():
            api_name = binding.get("api")
            method = getattr(instance, str(api_name), None)
            if method is None:
                problems.append(f"[{page_id}] 查询 {name} 指向不存在的接口 {api_name}")
                continue
            # 只传该接口接受的参数，全部用默认值（模拟空库/无筛选）
            kwargs = {}
            signature = inspect.signature(method)
            for param_name, param in signature.parameters.items():
                if param.default is not inspect.Parameter.empty:
                    continue
                if param_name in {"pool", "keyword"}:
                    kwargs[param_name] = ""
                elif param_name in {"page", "page_size", "limit", "max_edges"}:
                    kwargs[param_name] = 20
            try:
                data[name] = await method(**kwargs)
            except Exception as exc:  # noqa: BLE001
                problems.append(f"[{page_id}] 查询 {name} -> {api_name} 调用失败: {type(exc).__name__}: {exc}")

        # 2) 校验每个引用
        for node in page.get("content") or []:
            for label, reference in iter_references(node):
                total += 1
                if reference.get("scope") == "selection":
                    fields = row_fields(data)
                    name = reference.get("field", "").split(".")[0]
                    if not fields:
                        # 一条行都没有（空库），无从比对；不算失败但要说清楚
                        skipped += 1
                        continue
                    if name and name not in fields:
                        problems.append(
                            f"[{page_id}] {label} 引用了选中行的 {name}，但查询结果的行里没有这个字段"
                        )
                    continue
                ok, detail = resolve(reference, data)
                if ok:
                    if verbose:
                        print(f"  OK   [{page_id}] {label} -> {reference.get('source')}.{reference.get('field')}")
                else:
                    problems.append(f"[{page_id}] {label} 引用了 {detail}，但返回体里没有")

    print()
    print(f"引用总数 {total}，问题 {len(problems)} 个，跳过 {skipped} 个（无数据可验证）")
    for line in problems:
        print("  ✗", line)
    return 0 if not problems else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="校验面板字段引用与实际返回是否一致")
    parser.add_argument("--plugin-dir", default=str(PLUGIN_DIR))
    parser.add_argument("--data-dir", help="插件数据目录（默认自动找实例里的真实目录）")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    if data_dir:
        print(f"数据目录: {data_dir}")

    try:
        code = asyncio.run(check(Path(args.plugin_dir), args.verbose, data_dir))
    except Exception as exc:  # noqa: BLE001
        print(f"运行失败: {type(exc).__name__}: {exc}")
        raise SystemExit(2)
    raise SystemExit(code)


if __name__ == "__main__":
    main()
