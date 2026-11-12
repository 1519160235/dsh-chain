"""给宿主补一条 ``memory.ingest`` 能力 —— 幂等、可检查、可回退。

为什么需要它
------------
A_Memorix（框架自带的长期记忆）是**核心插件**，内核跑在宿主进程里；
我们的思维链插件跑在**扩展插件 Runner** 的另一个进程里。插件 SDK 只开放
``cap.call``（且 84 项能力里没有任何一种「写记忆」），A_Memorix 也不暴露
``@API`` 组件。所以「把一条判断顺带写进长期记忆」在框架侧没有入口。

这个脚本只做一件事：在 ``src/plugin_runtime/capabilities/registry.py`` 里注册
一条 ``memory.ingest``，转发到 ``a_memorix_host_service.invoke("ingest_text", ...)``。
不碰检索、不碰提示词、不碰别的任何能力。

升级会怎样
----------
``uv tool upgrade maibot`` 会整目录替换 ``Lib/site-packages/src``，补丁随之消失。
**重新跑一次 ``--apply`` 即可**（幂等，重复执行无副作用）。
``E:\\mai\\{data,plugins,config,logs}`` 不受升级影响，补丁状态记录在
``E:\\mai\\host\\patch_state.json``。

用法
----
    python tools/patch_host.py --check
    python tools/patch_host.py --apply
    python tools/patch_host.py --revert
    python tools/patch_host.py --apply --site-packages "D:/path/to/site-packages"

退出码：0 = 已打补丁且一致；1 = 未打补丁；2 = 需要人工确认（上游改过目标文件）。
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import shutil
import sys
import sysconfig
import time
from pathlib import Path
from typing import Optional

TARGET_REL = Path("src/plugin_runtime/capabilities/registry.py")
MARKER = "mai-chain-cross-write-patch"
ANCHOR = '_register("knowledge.search", manager._cap_knowledge_search)'

PATCH_BLOCK = '''    # >>> {marker}
    # 给扩展插件一条把文本写进 A_Memorix 的通道（思维链 -> 长期记忆联动）。
    # A_Memorix 是核心插件，与扩展插件不在同一进程；SDK 没有"调用别的插件"的能力，
    # 所以在这里补一条最小入口。只转发写入，不参与检索、不改提示词。
    # 由 mai-chain 插件的 tools/patch_host.py 维护，可 --revert 回退。
    async def _cap_memory_ingest(plugin_id, capability, args):
        """把一条文本写进 A_Memorix 长期记忆（仅转发，无业务逻辑）。"""
        del capability
        import os as _os
        import pathlib as _pl
        import sys as _sys

        payload = dict(args or {{}})
        logger.info(
            f"memory.ingest: plugin={{plugin_id}} source_type={{payload.get('source_type')}} "
            f"external_id={{payload.get('external_id')}}"
        )

        # 1) 进程里已经加载了记忆服务就直接用 —— 能绕开导入路径问题
        _ms = _sys.modules.get("src.services.memory_service")
        if _ms is not None:
            _svc = getattr(_ms, "memory_service", None)
            if _svc is not None:
                _res = await _svc.ingest_text(**payload)
                return _res.to_dict() if hasattr(_res, "to_dict") else _res

        for _name, _mod in list(_sys.modules.items()):
            if _name.endswith("A_memorix.host_service"):
                _svc = getattr(_mod, "a_memorix_host_service", None)
                if _svc is not None:
                    return await _svc.invoke("ingest_text", payload, timeout_ms=30000)

        # 2) 没加载过就导入；失败时按 registry.py 自身位置修 sys.path 再试一次
        try:
            from src.A_Memorix.host_service import a_memorix_host_service as _svc
        except ModuleNotFoundError as _exc:
            _root = _pl.Path(__file__).resolve().parents[3]      # site-packages
            _src_dir = _root / "src"
            _diag = f"cwd={{_os.getcwd()}} root={{_root}} src={{_src_dir.is_dir()}} err={{_exc}}"
            if not _src_dir.is_dir():
                raise RuntimeError("memory.ingest 定位 site-packages 失败: " + _diag) from _exc
            if str(_root) not in _sys.path:
                _sys.path.append(str(_root))
            _pkg = _sys.modules.get("src")
            if _pkg is not None and hasattr(_pkg, "__path__") and str(_src_dir) not in list(_pkg.__path__):
                _pkg.__path__.append(str(_src_dir))
            import importlib as _il
            _il.invalidate_caches()
            logger.warning("memory.ingest 走了导入兜底: " + _diag)
            from src.A_Memorix.host_service import a_memorix_host_service as _svc

        return await _svc.invoke("ingest_text", payload, timeout_ms=30000)

    cap_service.register_capability("memory.ingest", _cap_memory_ingest)
    # <<< {marker}
'''.format(marker=MARKER)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def find_site_packages(explicit: Optional[str]) -> Path:
    """定位包含着 ``src/plugin_runtime`` 的 site-packages 目录。"""

    def ok(base: Path) -> bool:
        return (base / TARGET_REL).is_file()

    if explicit:
        base = Path(explicit)
        if not ok(base):
            raise SystemExit(f"指定的 site-packages 里没有 {TARGET_REL}: {base}")
        return base

    # 1) 当前解释器（用 maibot 自己的 python 跑时命中）
    for key in ("purelib", "platlib"):
        candidate = Path(sysconfig.get_paths().get(key, "") or "")
        if str(candidate) and ok(candidate):
            return candidate

    # 2) uv tool 默认安装位置
    appdata = os.environ.get("APPDATA", "")
    if appdata:
        candidate = Path(appdata) / "uv" / "tools" / "maibot" / "Lib" / "site-packages"
        if ok(candidate):
            return candidate

    raise SystemExit(
        "找不到 maibot 的 site-packages。请用 maibot 自带的 python 运行，"
        "或显式传 --site-packages <目录>。"
    )


def framework_version(sp: Path) -> str:
    """读 dist-info 目录名取版本（``maibot-1.4.2.dist-info`` -> ``1.4.2``）。"""

    candidates = sorted(sp.glob("maibot-*.dist-info"))
    if not candidates:
        return "unknown"
    name = candidates[0].name
    if name.endswith(".dist-info"):
        name = name[: -len(".dist-info")]
    # name 形如 maibot-1.4.2
    _, _, version = name.partition("-")
    return version or "unknown"


def instance_root() -> Path:
    """定位实例根目录（``E:////mai``）。

    脚本放在 ``<实例>/plugins/mai-chain/tools/`` 下，往上四级就是实例根。
    允许用 ``MAIBOT_INSTANCE_DIR`` 覆盖；再不行就退回当前工作目录。
    """

    env = os.environ.get("MAIBOT_INSTANCE_DIR")
    if env:
        return Path(env)

    here = Path(__file__).resolve()
    if len(here.parents) >= 4:
        candidate = here.parents[3]
        # 正常情况是 <实例>；万一被放深了，认一下 host/ 或 data/ 是否存在
        if candidate.name.lower() not in {"tools", "mai-chain", "plugins", "src"}:
            return candidate

    cwd = Path.cwd()
    if (cwd / "host").is_dir() or (cwd / "data").is_dir():
        return cwd
    return cwd


def state_path() -> Path:
    """补丁状态放在实例目录，升级不会动它。"""

    return instance_root() / "host" / "patch_state.json"


def backup_dir() -> Path:
    return state_path().parent / "patch_backup"


def read_target(sp: Path) -> str:
    return (sp / TARGET_REL).read_text(encoding="utf-8", newline="")


def write_target(sp: Path, text: str) -> None:
    (sp / TARGET_REL).write_text(text, encoding="utf-8", newline="")


def load_state() -> dict:
    p = state_path()
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state: dict) -> None:
    p = state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def cmd_check(sp: Path) -> int:
    text = read_target(sp)
    state = load_state()
    patched = MARKER in text
    current = sha256_text(text)
    print(f"目标文件 : {sp / TARGET_REL}")
    print(f"框架版本 : {framework_version(sp)}")
    print(f"当前哈希 : {current[:16]}…")
    print(f"补丁状态 : {'已打' if patched else '未打'}")

    if not patched:
        if state.get("original_sha256") and state["original_sha256"] != current:
            print("⚠️  上游改过这个文件（哈希与上次记录不一致），打补丁前请先看 diff")
            if state.get("patched_at"):
                print(f"    上次打补丁: {state['patched_at']}")
            return 2
        return 1

    if state.get("patched_sha256") and state["patched_sha256"] != current:
        print("⚠️  文件里有补丁标记，但内容与记录不一致 —— 可能被手工改过")
        return 2

    print(f"记录时间 : {state.get('patched_at', '-')}")
    print("状态一致，无需处理")
    return 0


def cmd_apply(sp: Path, force: bool) -> int:
    text = read_target(sp)
    current = sha256_text(text)

    if MARKER in text:
        print("已打过补丁，跳过（幂等）")
        return 0

    if ANCHOR not in text:
        print("✗ 找不到锚点，放弃打补丁。目标文件可能已被上游重写：")
        print(f"    {ANCHOR}")
        print("  请人工确认 registry.py 的结构后再改脚本。")
        return 2

    state = load_state()
    if state.get("original_sha256") and state["original_sha256"] != current and not force:
        print("⚠️  上游改过这个文件（哈希与上次记录不一致）。")
        print("    加 --force 才会继续；建议先 diff 看上游改了什么。")
        return 2

    # 备份
    backup = backup_dir()
    backup.mkdir(parents=True, exist_ok=True)
    version = framework_version(sp)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    bak = backup / f"registry.py.{version}.{stamp}"
    shutil.copy2(sp / TARGET_REL, bak)
    print(f"已备份   : {bak}")

    # 插到锚点所在的下一行（保持缩进与上下文）
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    inserted = False
    for line in lines:
        out.append(line)
        if not inserted and ANCHOR in line:
            out.append("\n" + PATCH_BLOCK)
            inserted = True

    if not inserted:  # 理论上前面已挡掉，双保险
        print("✗ 插入失败")
        return 2

    patched = "".join(out)
    write_target(sp, patched)

    save_state(
        {
            "target": str(sp / TARGET_REL),
            "framework_version": version,
            "original_sha256": current,
            "patched_sha256": sha256_text(patched),
            "backup": str(bak),
            "patched_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
    )

    diff = difflib.unified_diff(
        text.splitlines(), patched.splitlines(), fromfile="改前", tofile="改后", lineterm="", n=2
    )
    print("\n".join(list(diff)[:40]))
    print(f"\n✓ 已打补丁。重启宿主（或等插件重载）后生效：memory.ingest")
    return 0


def cmd_revert(sp: Path, force: bool) -> int:
    text = read_target(sp)
    if MARKER not in text:
        print("当前没有补丁，无需回退")
        return 0

    state = load_state()
    bak = Path(state.get("backup", "")) if state.get("backup") else None
    if bak and bak.is_file():
        shutil.copy2(bak, sp / TARGET_REL)
        print(f"✓ 已从备份恢复: {bak}")
        return 0

    # 没有备份就按标记删除
    lines = text.splitlines(keepends=True)
    out, skip = [], False
    for line in lines:
        if f">>> {MARKER}" in line:
            skip = True
            # 去掉块前多余的空行
            while out and out[-1].strip() == "":
                out.pop()
            continue
        if f"<<< {MARKER}" in line:
            skip = False
            continue
        if not skip:
            out.append(line)
    write_target(sp, "".join(out))
    print("✓ 已按标记删除补丁（无备份可用）")
    if not force:
        print("  提示：删除后建议手动确认 registry.py 语法正常")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="给 MaiBot 补一条 memory.ingest 能力")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true", help="检查补丁状态")
    group.add_argument("--apply", action="store_true", help="打补丁（幂等）")
    group.add_argument("--revert", action="store_true", help="回退补丁")
    parser.add_argument("--site-packages", default=None, help="显式指定 site-packages 目录")
    parser.add_argument("--force", action="store_true", help="上游改过文件时仍然继续")
    args = parser.parse_args()

    sp = find_site_packages(args.site_packages)
    if args.check:
        return cmd_check(sp)
    if args.apply:
        return cmd_apply(sp, args.force)
    return cmd_revert(sp, args.force)


if __name__ == "__main__":
    sys.exit(main())
