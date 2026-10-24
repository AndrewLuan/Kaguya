#!/usr/bin/env python3
"""功能概述：Linux CI 在真实 X11 key-down/临时映射出现时中断固定 Cua 进程组。
主要职责：先验证 pid/exe/start-time，观察目标状态后冻结进程组并复查，再 SIGKILL。
代码库关系：gui-drain-probe.mjs 先冻结 baseline，再触发一次真实 Cua 输入；生产不注册此探针。
输入输出与副作用：仅 UID1000、本容器 /opt/cua/cua-driver 组；输出实际触发状态供 release/readback 验证。
"""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import time

spec = importlib.util.spec_from_file_location("gui_x11", Path(__file__).with_name("gui-x11.py"))
x11 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(x11)
pid = int(sys.argv[1])
mode = sys.argv[2]
if mode not in ("held", "modifier", "button", "unicode") or pid < 2 or os.getuid() != 1000:
    raise RuntimeError("interrupt-probe-denied")
identity = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]


def validate():
    if (os.readlink(f"/proc/{pid}/exe") != "/opt/cua/cua-driver" or os.getpgid(pid) != pid or
            Path(f"/proc/{pid}/stat").stat().st_uid != 1000 or
            Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19] != identity):
        raise RuntimeError("interrupt-probe-identity-changed")


def matches(state):
    if mode == "unicode":
        return any(0x1004e2d in row for row in state["mapping"])
    if mode == "button":
        return 1 in state["buttons"]
    if mode == "modifier":
        return any(0xffe1 in state["mapping"][key - 8] or 0xffe2 in state["mapping"][key - 8] for key in state["keys"])
    return bool(state["keys"])


def observe_repeat(_x, _display, keys):
    """冻结真实 key-down 后读取 GTK 实际重复按下事件，不依赖另一个 X 客户端的事件路由。"""
    deadline = time.monotonic() + 3
    path = Path("/run/kaguya-app/session/gui-key-events.json")
    while True:
        events = json.loads(path.read_text())
        if events["uid"] == 1001 and events["presses"] >= 2 and any(key in events["held"] for key in keys):
            return events
        if time.monotonic() >= deadline:
            raise RuntimeError("real-auto-repeat-not-observed:" + json.dumps(events))
        time.sleep(.001)


validate()
x, xt, display = x11.open_x11()
try:
    print("ready", flush=True)
    deadline = time.monotonic() + 15
    while True:
        state = x11.snapshot(x, display)
        if matches(state):
            validate()
            os.killpg(pid, signal.SIGSTOP)
            try:
                validate()
                frozen = x11.snapshot(x, display)
                if not matches(frozen):
                    raise RuntimeError("input-state-ended-before-freeze")
                repeat = observe_repeat(x, display, frozen["keys"]) if mode == "held" else None
                print(json.dumps({"mode": mode, "observed": frozen, "autoRepeat": repeat}), flush=True)
            finally:
                # 冻结后身份变化也不能据旧 PID 清理其他进程组；保留未确认失败。
                validate()
                os.killpg(pid, signal.SIGKILL)
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("input-interruption-state-not-observed")
        time.sleep(.001)
finally:
    x.XCloseDisplay(display)
