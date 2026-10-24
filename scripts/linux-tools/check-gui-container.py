#!/usr/bin/env python3
"""功能概述：rootless Linux 的首阶段双 UID GUI 实测，不调用模型或连接用户桌面。
主要职责：固定 OCI 隔离参数启动可信显示，再由宿主固定 UID 启动 app-session 与合成 GTK。
代码库关系：Linux tools workflow 构建 Dockerfile.gui 后调用；证据绑定输入镜像 digest。
输入输出与副作用：仅临时命名容器与 HOME，finally 清理；有界条件检查总线/GTK，不固定 sleep 猜就绪。
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("--archive", required=True)
parser.add_argument("--digest", required=True)
args = parser.parse_args()
name = "kaguya-gui-ci-" + uuid.uuid4().hex


def command(*parts, timeout=30, check=True):
    result = subprocess.run(["/usr/bin/podman", *parts], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace"))
    return result


def until(parts, seconds=15):
    deadline = time.monotonic() + seconds
    while True:
        result = command(*parts, check=False)
        if result.returncode == 0:
            return result.stdout
        if time.monotonic() >= deadline:
            raise RuntimeError(result.stderr.decode(errors="replace") or "gui-readiness-timeout")
        time.sleep(.02)


info = json.loads(command("info", "--format=json").stdout)
assert info["host"]["security"]["rootless"] is True
command("load", "--input", str(Path(args.archive).resolve()), timeout=300)
image = "localhost/kaguya-gui@" + args.digest
assert json.loads(command("image", "inspect", image).stdout)[0]["Digest"] == args.digest
try:
    command("run", "--detach", "--pull=never", "--name", name,
            "--userns=keep-id:uid=1000,gid=1000", "--user=1000:1000", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", "--read-only", "--network=none",
            "--ipc=private", "--pid=private", "--cgroupns=private", "--cpus=1", "--memory=2g",
            "--memory-swap=2g", "--pids-limit=256", "--shm-size=512m", "--init",
            "--tmpfs=/tmp:rw,nosuid,nodev,size=512m", "--tmpfs=/run:rw,nosuid,nodev,size=64m",
            "--tmpfs=/run/kaguya-app:rw,nosuid,nodev,size=32m,uid=1001,gid=1001,mode=0711",
            "--tmpfs=/home/app:rw,nosuid,nodev,size=256m,uid=1001,gid=1001,mode=0700",
            "--tmpfs=/home/tool:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700", image)
    container = json.loads(command("inspect", name).stdout)[0]
    oci = json.loads(command("unshare", "/bin/cat", container["OCIConfigPath"]).stdout)
    assert oci["process"]["user"]["uid"] == 1000
    assert oci["process"]["noNewPrivileges"] is True
    assert all(not caps for caps in oci["process"]["capabilities"].values())
    assert oci["root"]["readonly"] is True
    command("exec", "--detach", "--user=1001:1001", name, "/usr/bin/python3", "/opt/kaguya-tools/gui-app-session.py")
    until(["exec", name, "/usr/bin/dbus-send", "--session", "--print-reply", "--dest=org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus.GetAddress"])
    command("exec", "--detach", "--user=1001:1001", "--env=HOME=/home/app", "--env=GTK_MODULES=gail:atk-bridge", "--env=NO_AT_BRIDGE=0", name, "/usr/bin/python3", "/opt/kaguya-tools/gui-fixture.py")
    until(["exec", "--user=1001:1001", name, "/usr/bin/test", "-s", "/home/app/gui-ledger.json"])
    probe = command("exec", name, "/usr/local/bin/node", "/opt/kaguya-tools/gui-probe.mjs", timeout=120)
    print(probe.stdout.decode(), flush=True)
    Path("gui-probe.json").write_bytes(command("exec", name, "/bin/cat", "/home/tool/gui-probe.json").stdout)
    Path("gui-packages.txt").write_bytes(command("exec", name, "/bin/cat", "/usr/share/kaguya-gui-packages.txt").stdout)
    print(json.dumps({"imageDigest": args.digest, "ociProcess": oci["process"], "rootless": True}), flush=True)
finally:
    logs = command("logs", name, check=False)
    print(logs.stdout.decode(errors="replace"), flush=True)
    print(logs.stderr.decode(errors="replace"), flush=True)
    command("rm", "--force", "--ignore", name)
