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


def observe_repeat(x, display, keys):
    """冻结真实 key-down 后观察额外 KeyPress，证明本例实际进入 XServer auto-repeat。"""
    C = x11.C
    class KeyEvent(C.Structure):
        _fields_ = [("type", C.c_int), ("serial", C.c_ulong), ("send_event", C.c_int), ("display", C.c_void_p),
                    ("window", C.c_ulong), ("root", C.c_ulong), ("subwindow", C.c_ulong), ("time", C.c_ulong),
                    ("x", C.c_int), ("y", C.c_int), ("x_root", C.c_int), ("y_root", C.c_int),
                    ("state", C.c_uint), ("keycode", C.c_uint), ("same_screen", C.c_int)]
    class Event(C.Union):
        _fields_ = [("type", C.c_int), ("key", KeyEvent), ("pad", C.c_long * 24)]
    x.XGetInputFocus.argtypes = [C.c_void_p, C.POINTER(C.c_ulong), C.POINTER(C.c_int)]
    x.XSelectInput.argtypes = [C.c_void_p, C.c_ulong, C.c_long]
    x.XPending.argtypes = [C.c_void_p]
    x.XNextEvent.argtypes = [C.c_void_p, C.c_void_p]
    focus, revert = C.c_ulong(), C.c_int()
    x.XGetInputFocus(display, C.byref(focus), C.byref(revert))
    if focus.value <= 1:
        raise RuntimeError("repeat-focus-unconfirmed")
    x.XSelectInput(display, focus, 1)  # KeyPressMask 可被多个只读观察客户端订阅。
    x.XSync(display, 0)
    deadline = time.monotonic() + 3
    event = Event()
    while True:
        while x.XPending(display):
            x.XNextEvent(display, C.byref(event))
            if event.type == 2 and event.key.keycode in keys and not event.key.send_event:
                return {"keycode": event.key.keycode, "window": event.key.window, "serverTime": event.key.time}
        if time.monotonic() >= deadline:
            raise RuntimeError("real-auto-repeat-not-observed")
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
