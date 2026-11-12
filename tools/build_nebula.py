"""把上游 client.js 原样内联进 host.html，生成最终的 nebula.html。

## 为什么需要这一步

宿主给自定义页的 CSP 是 `script-src 'unsafe-inline' blob:` —— **不允许外部脚本**，
所以 `client.js` 不能通过 `<script src>` 引入，必须内联。
但它有 100 KB / 1900 行，直接塞进 HTML 里永远没法维护，
所以源文件留在 `webui/client.js`（与上游逐字节一致），由这个脚本拼装。

用法::

    python tools/build_nebula.py           # 生成 webui/nebula.html
    python tools/build_nebula.py --check   # 只检查是否已同步
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEBUI = ROOT / "webui"
HOST = WEBUI / "host.html"
CLIENT = WEBUI / "client.js"
OUT = WEBUI / "nebula.html"
PLACEHOLDER = "/*__CLIENT_JS__*/"


def main() -> int:
    for path in (HOST, CLIENT):
        if not path.is_file():
            print(f"缺少文件: {path}")
            return 1

    client = CLIENT.read_text(encoding="utf-8")
    if "</script>" in client:
        print("client.js 里出现了 </script>，内联会截断脚本，需先转义")
        return 1

    host = HOST.read_text(encoding="utf-8")
    if PLACEHOLDER not in host:
        print(f"host.html 里找不到占位符 {PLACEHOLDER}")
        return 1

    rendered = host.replace(PLACEHOLDER, client.rstrip() + "\n")

    current = OUT.read_text(encoding="utf-8") if OUT.is_file() else ""
    if "--check" in sys.argv:
        if rendered != current:
            print("nebula.html 与 client.js/host.html 不同步，请运行: python tools/build_nebula.py")
            return 1
        print("已同步")
        return 0

    if rendered == current:
        print("nebula.html 已是最新")
        return 0

    OUT.write_text(rendered, encoding="utf-8")
    print(f"已生成 webui/nebula.html（{len(rendered.encode('utf-8')) / 1024:.1f} KB）")
    print(f"  · 宿主壳 webui/host.html  {len(host.encode('utf-8')) / 1024:.1f} KB")
    print(f"  · 原版渲染 webui/client.js {len(client.encode('utf-8')) / 1024:.1f} KB（未修改）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
