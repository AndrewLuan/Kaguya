#!/usr/bin/env python3
"""功能概述：宿主固定 podman exec --user 1001:1001 启动的应用会话，不承担控制授权。
主要职责：等待真实 X11 就绪，启动固定 session bus、AT-SPI、Openbox 与终端；派生进程均为应用 UID。
代码库关系：gui-session.conf 禁用用户 activation 搜索；gui-init.mjs 独立拥有 Xvfb。
输入输出与副作用：只接受镜像内固定程序；子进程异常使会话失败，SIGTERM 回收本会话子进程。
"""
import os
from pathlib import Path
import signal
import subprocess
import time

if os.getuid() != 1001:
    raise RuntimeError("gui-app-uid-required")
for directory, mode in [("/home/app/session", 0o700), ("/run/kaguya-app/session", 0o711),
                        ("/run/kaguya-app/session/at-spi", 0o711)]:
    path = Path(directory)
    path.mkdir(mode=mode, exist_ok=True)
    info = path.lstat()
    if path.is_symlink() or info.st_uid != 1001 or info.st_mode & 0o022:
        raise RuntimeError("unsafe-app-session-directory")
log = os.open("/home/app/session/session.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
os.dup2(log, 1)
os.dup2(log, 2)
os.close(log)
os.environ.update(HOME="/home/app/session", DISPLAY=":99", XDG_RUNTIME_DIR="/run/kaguya-app/session",
                  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/kaguya-app/session/bus",
                  GTK_MODULES="gail:atk-bridge", NO_AT_BRIDGE="0", GTK_A11Y="always")
children = []


def start(args):
    child = subprocess.Popen(args)
    children.append(child)
    return child


def ready(args, seconds=12):
    deadline = time.monotonic() + seconds
    while True:
        if any(child.poll() is not None for child in children):
            raise RuntimeError("gui-session-child-exited")
        result = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
        if result.returncode == 0:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError("gui-session-not-ready")
        time.sleep(.02)


def stop(_signum, _frame):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    ready(["/usr/bin/xdpyinfo"])
    start(["/usr/bin/dbus-daemon", "--nofork", "--config-file=/opt/kaguya-tools/gui-session.conf"])
    ready(["/usr/bin/dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.DBus", "/", "org.freedesktop.DBus.ListNames"])
    start(["/usr/libexec/at-spi-bus-launcher", "--launch-immediately"])
    ready(["/usr/bin/dbus-send", "--session", "--print-reply", "--dest=org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus.GetAddress"])
    start(["/usr/bin/openbox", "--config-file", "/opt/kaguya-tools/gui-openbox.xml"])
    start(["/usr/bin/xterm", "-title", "Kaguya isolated terminal"])
    while True:
        # 这里是会话存活监视；就绪和测试行为使用上方有界条件，不以休眠猜测完成。
        for child in children:
            if child.poll() is not None:
                raise RuntimeError("gui-session-child-exited")
        time.sleep(.2)
finally:
    for child in children:
        if child.poll() is None:
            child.terminate()
    for child in children:
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=3)
