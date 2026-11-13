"""通过宿主代理调用插件面板接口（调试用）。

为什么需要这个脚本
------------------
面板接口不是 ``http://127.0.0.1:8001/api/webui/...`` 这种直连路径。宿主是**多机器人**
架构，浏览器只登录宿主，业务请求经进程间通道转发：

    POST /api/host/session                 {"ticket": "..."}   -> 下发会话 cookie
    POST /api/host/bots/<bot_id>/proxy/api/webui/plugins/runtime/webui/
         <plugin_id>/<page>/<queries|actions>/<name>            {"args": {...}}

三个容易踩的点（都是实测踩出来的）：

1. **鉴权是会话 cookie，不是 Bearer token**。``host/webui.json`` 里那个 access_token
   是宿主管理页的，对 ``/api/host/`` 无效。
2. **``/api/host/`` 下的非代理操作必须带 ``X-Maibot-Host: 1``**，否则 403
   「缺少管理请求标识」。
3. **只转发以 ``api/`` 开头的路径**，且 ``api/host``、``api/webui/auth``、
   ``api/webui/setup`` 被明确排除。

用法
----
    # 列出一个页面的数据
    python tools/panel_call.py --bot <bot_id> --page memories --query rows

    # 写入一条（会触发长期记忆联动）
    python tools/panel_call.py --bot <bot_id> --page memories --action write \
        --args '{"judgement": "先给结论再解释", "tags": "铁律"}'

    # 只验证登录链路
    python tools/panel_call.py --bot <bot_id> --login-only

``--ticket`` 可省略：不给就自己跑 ``maibot host open-webui`` 取。
脚本只在宿主机本机运行（127.0.0.1），不对外暴露任何凭据。
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

HOST = "http://127.0.0.1:8001"
DEFAULT_PLUGIN = "maibot.mai-chain"


def find_maibot() -> str:
    """定位 maibot 可执行文件。

    它通常不在 PATH 里（uv tool 装到 ``%USERPROFILE%\\.local\\bin``），
    所以这里按几个已知位置找一遍。
    """

    candidates = [
        "maibot",
        str(Path.home() / ".local" / "bin" / "maibot.exe"),
        str(Path.home() / ".local" / "bin" / "maibot"),
        r"C:\Users\Administrator\.local\bin\maibot.exe",
    ]
    for cand in candidates:
        found = shutil.which(cand) or (cand if Path(cand).is_file() else None)
        if found:
            return found
    sys.exit("找不到 maibot 命令；用 --maibot 指定路径，或手动传 --ticket")


def fetch_ticket(instance_dir: str, exe: str | None = None) -> str:
    """跑 ``maibot host open-webui`` 并抠出 ticket。"""

    try:
        out = subprocess.run(
            [exe or find_maibot(), "host", "open-webui", "-d", instance_dir],
            capture_output=True,
            text=True,
            timeout=120,
        ).stdout
    except FileNotFoundError:
        sys.exit("找不到 maibot 命令；请用 --maibot 指定，或手动传 --ticket")

    match = re.search(r"ticket=([\w\-]+)", out)
    if not match:
        sys.exit(f"没能从输出里取到 ticket：{out[:200]}")
    return match.group(1)


class Panel:
    """一个带会话 cookie 的极简客户端。"""

    def __init__(self, origin: str = HOST) -> None:
        self.origin = origin
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar)
        )

    def call(self, method: str, path: str, body: dict | None = None) -> tuple[int | None, str]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.origin + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        # 宿主会校验 Origin 与 Host 一致（same_webui_origin），必须带
        req.add_header("Origin", self.origin)
        req.add_header("Referer", self.origin + "/bots")
        # /api/host/ 下的管理操作要求这个标识
        req.add_header("X-Maibot-Host", "1")
        try:
            with self.opener.open(req, timeout=40) as resp:
                return resp.status, resp.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", "ignore")
        except Exception as exc:  # noqa: BLE001
            return None, f"{type(exc).__name__}: {exc}"

    def login(self, ticket: str) -> bool:
        status, body = self.call("POST", "/api/host/session", {"ticket": ticket})
        print(f"登录: {status} {body[:120]}")
        print(f"  cookies: {[c.name for c in self.jar]}")
        return status == 200

    def invoke(
        self,
        bot_id: str,
        page: str,
        kind: str,
        name: str,
        args: dict | None = None,
        plugin: str = DEFAULT_PLUGIN,
    ) -> tuple[int | None, str]:
        path = (
            f"/api/host/bots/{bot_id}/proxy/api/webui/plugins/runtime/webui/"
            f"{plugin}/{page}/{kind}/{name}"
        )
        return self.call("POST", path, {"args": args or {}})


def main() -> None:
    ap = argparse.ArgumentParser(description="通过宿主代理调用插件面板接口")
    ap.add_argument("--bot", required=False, help="bot id（32 位十六进制）")
    ap.add_argument("--plugin", default=DEFAULT_PLUGIN)
    ap.add_argument("--page", help="页面 id，如 memories / overview")
    ap.add_argument("--query", help="查询名，如 rows")
    ap.add_argument("--action", help="动作名，如 write")
    ap.add_argument("--args", default="{}", help="JSON 参数")
    ap.add_argument("--ticket", help="跳过 open-webui，直接用这个 ticket")
    ap.add_argument("--instance", default=r"E:\mai")
    ap.add_argument("--maibot", help="maibot 可执行文件路径（默认自动找）")
    ap.add_argument("--login-only", action="store_true")
    opts = ap.parse_args()

    ticket = opts.ticket or fetch_ticket(opts.instance, opts.maibot)
    panel = Panel()
    if not panel.login(ticket):
        sys.exit(1)
    if opts.login_only:
        return

    if not opts.bot:
        sys.exit("需要 --bot（或只用 --login-only 验证登录）")
    if not opts.page or not (opts.query or opts.action):
        sys.exit("需要 --page 且指定 --query 或 --action")

    args = json.loads(opts.args or "{}")
    kind, name = ("queries", opts.query) if opts.query else ("actions", opts.action)
    status, body = panel.invoke(opts.bot, opts.page, kind, name, args, opts.plugin)
    print(f"{kind}/{name}: {status}")
    try:
        print(json.dumps(json.loads(body), ensure_ascii=False, indent=2)[:1500])
    except Exception:  # noqa: BLE001
        print(body[:800])


if __name__ == "__main__":
    main()
