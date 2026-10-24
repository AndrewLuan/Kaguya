#!/usr/bin/env python3
"""功能概述：rootless Linux 的首阶段双 UID GUI 实测，不调用模型或连接用户桌面。
主要职责：固定 OCI 隔离参数启动可信显示，再由宿主固定 UID 启动 app-session 与合成 GTK。
代码库关系：Linux tools workflow 构建 Dockerfile.gui 后调用；证据绑定输入镜像 digest。
输入输出与副作用：仅临时命名容器与 HOME，finally 清理；有界条件检查总线/GTK，不固定 sleep 猜就绪。
"""
import argparse
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("--archive", required=True)
parser.add_argument("--digest", required=True)
args = parser.parse_args()
name = "kaguya-gui-ci-" + uuid.uuid4().hex
probe_process = None
podman_unresponsive = False


def host_diagnostics(reason):
    """不依赖容器 exec/Podman 锁的宿主证据；不读取进程环境或应用内容。"""
    evidence = {"reason": reason, "processes": [], "storage": {}}
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            comm = (process / "comm").read_text().strip()
            if comm not in ("podman", "conmon", "crun", "runc", "fuse-overlayfs"):
                continue
            item = {"pid": int(process.name), "comm": comm}
            for field in ("status", "wchan", "cgroup", "stack"):
                try:
                    item[field] = (process / field).read_text()[:8192]
                except OSError as error:
                    item[field] = str(error)
            evidence["processes"].append(item)
        except OSError:
            continue
    for directory in (Path.home() / ".local/share/containers/storage", Path(f"/run/user/{os.getuid()}/containers")):
        try:
            stats = os.statvfs(directory)
            evidence["storage"][str(directory)] = {
                "availableBytes": stats.f_bavail * stats.f_frsize, "availableInodes": stats.f_favail,
                "entries": sorted(entry.name for entry in directory.iterdir())[:100],
            }
        except OSError as error:
            evidence["storage"][str(directory)] = str(error)
    with Path("gui-host-diagnostics.jsonl").open("a") as output:
        output.write(json.dumps(evidence) + "\n")


def command(*parts, timeout=30, check=True, input=None):
    global podman_unresponsive
    try:
        result = subprocess.run(["/usr/bin/podman", *parts], input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        podman_unresponsive = True
        host_diagnostics(f"podman {parts[0]} exceeded {timeout}s")
        raise
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


def until_json(parts, predicate, seconds=15):
    deadline = time.monotonic() + seconds
    while True:
        value = json.loads(command(*parts).stdout)
        if predicate(value):
            return value
        if time.monotonic() >= deadline:
            raise AssertionError({"applicationConditionTimeout": value})
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
            "--tmpfs=/run/kaguya-app:rw,nosuid,nodev,size=32m,mode=1777",
            "--tmpfs=/home/app:rw,nosuid,nodev,size=256m,mode=1777",
            "--tmpfs=/home/tool:rw,nosuid,nodev,size=256m,mode=0700,U",
            "--env=KAGUYA_ENVIRONMENT_ID=" + name, "--env=KAGUYA_ENVIRONMENT_GENERATION=0",
            "--env=KAGUYA_HELPER_PROTOCOL_VERSION=1", image)
    container = json.loads(command("inspect", name).stdout)[0]
    oci = json.loads(command("unshare", "/bin/cat", container["OCIConfigPath"]).stdout)
    assert oci["process"]["user"]["uid"] == 1000
    assert oci["process"]["noNewPrivileges"] is True
    assert all(not caps for caps in oci["process"]["capabilities"].values())
    assert oci["root"]["readonly"] is True
    command("exec", "--detach", "--user=1001:1001", name, "/usr/bin/python3", "/opt/kaguya-tools/gui-app-session.py")
    address_result = until(["exec", name, "/usr/bin/dbus-send", "--session", "--print-reply", "--dest=org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus.GetAddress"])
    address = re.search(r'string "([^"]+)"', address_result.decode()).group(1)
    assert address.startswith("unix:path=/run/kaguya-app/session/at-spi/")
    command("exec", name, "/usr/bin/dbus-send", "--bus=" + address, "--print-reply", "--dest=org.freedesktop.DBus", "/", "org.freedesktop.DBus.ListNames")
    print(json.dumps({"controlUid": 1000, "appUid": 1001, "atspiAddress": address, "bothBusesConnected": True}), flush=True)
    command("exec", "--detach", "--user=1001:1001", "--env=HOME=/home/app/session", "--env=GTK_MODULES=gail:atk-bridge", "--env=NO_AT_BRIDGE=0", name, "/usr/bin/python3", "/opt/kaguya-tools/gui-fixture.py")
    until(["exec", "--user=1001:1001", name, "/usr/bin/test", "-s", "/home/app/session/gui-ledger.json"])
    ledger = json.loads(command("exec", "--user=1001:1001", name, "/bin/cat", "/home/app/session/gui-ledger.json").stdout)
    assert ledger["uid"] == 1001
    probe_process = subprocess.Popen(["/usr/bin/podman", "exec", name, "/usr/local/bin/node", "/opt/kaguya-tools/gui-probe.mjs", str(ledger["pid"])], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    driver = json.loads(until(["exec", name, "/bin/cat", "/home/tool/gui-probe-driver.json"]))
    health = json.loads(command("exec", "-i", name, "/opt/kaguya-tools/helper", input=b'{"helperProtocolVersion":1,"kind":"health"}').stdout)
    assert health["ready"] is True and health["generation"] == 0 and health["serviceInstanceId"]
    print(json.dumps({"controlHealth": health}), flush=True)
    isolation = command("exec", "--user=1001:1001", name, "/usr/bin/python3", "/opt/kaguya-tools/gui-isolation-probe.py", str(driver["pid"]))
    print(isolation.stdout.decode(), flush=True)
    command("exec", name, "/usr/bin/touch", "/home/tool/gui-probe-continue")
    output, errors = probe_process.communicate(timeout=120)
    if probe_process.returncode:
        raise RuntimeError(errors.decode(errors="replace"))
    print(output.decode(), flush=True)
    after = until_json(["exec", "--user=1001:1001", name, "/bin/cat", "/home/app/session/gui-ledger.json"], lambda value: value["text"] == "W8 暂存" and value["count"] == 1)
    assert after == {"uid": 1001, "pid": ledger["pid"], "text": "W8 暂存", "count": 1}, after
    print(json.dumps({"independentApplicationLedger": after}), flush=True)
    drain = command("exec", name, "/usr/local/bin/node", "/opt/kaguya-tools/gui-drain-probe.mjs", timeout=180)
    print(drain.stdout.decode(), flush=True)
    preserved = json.loads(command("exec", "--user=1001:1001", name, "/bin/cat", "/home/app/session/gui-ledger.json").stdout)
    assert preserved == after, preserved
    Path("gui-probe.json").write_bytes(command("exec", name, "/bin/cat", "/home/tool/gui-probe.json").stdout)
    Path("gui-packages.txt").write_bytes(command("exec", name, "/bin/cat", "/usr/share/kaguya-gui-packages.txt").stdout)
    print(json.dumps({"imageDigest": args.digest, "ociProcess": oci["process"], "rootless": True}), flush=True)
finally:
    primary = sys.exc_info()[1]
    if primary:
        print(f"Primary GUI failure: {primary!r}", file=sys.stderr, flush=True)
    cleanup_errors = []
    for source, destination in [("/home/tool/gui-probe.json", "gui-probe.json"),
                                ("/home/tool/gui-gtk.png", "gui-gtk.png"),
                                ("/home/tool/gui-desktop.png", "gui-desktop.png"),
                                ("/usr/share/kaguya-gui-packages.txt", "gui-packages.txt")]:
        if podman_unresponsive:
            break
        try:
            value = command("exec", name, "/bin/cat", source, check=False)
            if value.returncode == 0:
                Path(destination).write_bytes(value.stdout)
        except Exception as error:
            cleanup_errors.append(error)
    try:
        if not podman_unresponsive:
            app_logs = command("exec", "--user=1001:1001", name, "/usr/bin/tail", "-c", "65536", "/home/app/session/session.log", check=False)
            print(app_logs.stdout.decode(errors="replace"), flush=True)
    except Exception as error:
        cleanup_errors.append(error)
    try:
        if not podman_unresponsive:
            logs = command("logs", name, check=False)
            print(logs.stdout.decode(errors="replace"), flush=True)
            print(logs.stderr.decode(errors="replace"), flush=True)
    except Exception as error:
        cleanup_errors.append(error)
    try:
        command("rm", "--force", "--ignore", name)
    except Exception as error:
        cleanup_errors.append(error)
    if probe_process is not None:
        try:
            if probe_process.poll() is None:
                probe_process.kill()
            probe_process.wait(timeout=5)
        except Exception as error:
            cleanup_errors.append(error)
    if cleanup_errors:
        raise BaseExceptionGroup("gui fixture cleanup failed", ([primary] if primary else []) + cleanup_errors)
