#!/usr/bin/env python3
"""功能概述：每个 shell job 的可信宿主 supervisor，运行于独立 systemd user service。
主要职责：run 在不可重放 claim 后布置固定截止，核对 payload/conmon 的 cgroup 后放行 argv，
收集有界输出，并在整个 payload cgroup 清空后写回执。systemd 清理崩溃或暂停的 supervisor。
代码库关系：shell_jobs.py 传入私有 manifest 目录，job-entry.mjs 仅通过 stdin 接收启动消息。
输入输出与副作用：命令没有 permit、控制 FD 或宿主路径；lease renew 不改变原截止。
"""
import fcntl
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from broker import BrokerError, PodmanBackend  # noqa: E402
from shell_jobs import ShellJobs, LOG_RESERVATION, boot_id, file_result, now_iso, read_json, write_json  # noqa: E402


def remaining(record):
    return min(record["expires"] - time.time(), record["monotonicDeadline"] - time.monotonic(),
               record["bootDeadline"] - time.clock_gettime(time.CLOCK_BOOTTIME))


def group_for(pid):
    lines = Path(f"/proc/{pid}/cgroup").read_text().splitlines()
    return next(line[3:] for line in lines if line.startswith("0::"))


def payload_empty(group):
    path = Path("/sys/fs/cgroup") / group.lstrip("/") / "cgroup.events"
    return not path.exists() or "populated 0" in path.read_text()


def run(path):
    record = read_json(path / "manifest.json")
    if record["bootId"] != boot_id() or remaining(record) <= 0:
        raise BrokerError("job-expired-before-launch")
    lock = os.open(path / "runner.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # claim 永不删除；重复 unit start 以及恢复均不得再次执行命令。
    claim = os.open(path / "claimed", os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    os.fsync(claim)
    os.close(claim)
    directory = os.open(path, os.O_DIRECTORY | os.O_RDONLY)
    os.fsync(directory)
    os.close(directory)
    backend = PodmanBackend()
    backend.env = record["hostEnv"]
    jobs = ShellJobs(path.parent.parent, backend)
    props = jobs.properties(record["unit"])
    group = props["ControlGroup"]
    if not group or group_for(os.getpid()) != group:
        raise BrokerError("supervisor-cgroup-unconfirmed")
    entered = int(props["ActiveEnterTimestampMonotonic"]) / 1000000
    if entered <= 0:
        raise BrokerError("unit-activation-unconfirmed")
    runtime = record["monotonicDeadline"] - entered
    if runtime <= 0:
        raise BrokerError("job-expired-before-arm")
    jobs.system("/usr/bin/systemctl", "--user", "set-property", "--runtime", record["unit"],
                f"RuntimeMaxSec={runtime:.6f}s")
    expiry_unit = record["unit"].removesuffix(".service") + "-expiry"
    jobs.system("/usr/bin/systemd-run", "--user", "--quiet", "--unit=" + expiry_unit,
                "--on-calendar=@" + str(record["expires"]), "--timer-property=AccuracySec=1us",
                "--timer-property=RandomizedDelaySec=0", "/usr/bin/systemctl", "--user", "stop", record["unit"])
    armed = jobs.properties(record["unit"])
    if armed.get("RuntimeMaxUSec") in (None, "infinity", "0") or remaining(record) <= 0:
        raise BrokerError("deadline-not-armed")
    command = ["/usr/bin/podman", "--cgroup-manager=cgroupfs", "run", "--pull=never", "--interactive",
               "--name=" + record["container"], "--label=kaguya.environment=" + record["environmentId"],
               "--label=kaguya.role=shell", "--label=kaguya.job=" + record["jobId"],
               "--label=kaguya.generation=" + str(record["generation"]), "--cgroups=split",
               "--userns=keep-id:uid=1000,gid=1000", "--user=1000:1000", "--cap-drop=ALL",
               "--security-opt=no-new-privileges", "--read-only", "--ipc=private", "--pid=private",
               "--cgroupns=private", "--cpus=2", "--memory=4g", "--memory-swap=4g", "--pids-limit=512",
               "--shm-size=512m", "--init", "--log-driver=none", "--restart=no",
               "--network=" + ("none" if record["network"] == "none" else "pasta:--no-map-gw"),
               "--tmpfs=/tmp:rw,nosuid,nodev,size=512m", "--tmpfs=/run:rw,nosuid,nodev,size=64m",
               "--tmpfs=/home/tool:rw,nosuid,nodev,size=256m,mode=0700,U",
               "--volume=" + record["volume"] + ":/workspace:rw", "--workdir=/workspace",
               "--entrypoint=/usr/local/bin/node"]
    command += ["--env=" + key + "=" + value for key, value in record["env"].items()]
    command += [record["image"], "/opt/kaguya-tools/job-entry.mjs", record["cwd"], *record["argv"]]
    streams = {}
    proc = None
    selector = selectors.DefaultSelector()
    reason, payload_group, count = None, None, 0
    try:
        for name in ("stdout", "stderr"):
            streams[name] = os.open(path / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        proc = subprocess.Popen(command, env=backend.env, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        end = time.monotonic() + min(15, remaining(record))
        while time.monotonic() < end:
            if proc.poll() is not None:
                os.write(streams["stderr"], proc.stderr.read(LOG_RESERVATION))
                raise BrokerError("container-start-failed")
            result = subprocess.run(["/usr/bin/podman", "inspect", record["container"]], env=backend.env,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2)
            if result.returncode == 0:
                info = json.loads(result.stdout)[0]
                pid = info["State"].get("Pid", 0)
                if info["State"]["Running"] and pid:
                    payload_group = group_for(pid)
                    conmon_group = group_for(info["State"]["ConmonPid"])
                    if not all(g.startswith(group + "/") for g in (payload_group, conmon_group)):
                        raise BrokerError("container-outside-job-unit")
                    if remaining(record) <= 0:
                        raise BrokerError("permit-expired-before-release")
                    write_json(path / "running.json", {"pidNamespace": os.readlink(f"/proc/{pid}/ns/pid"),
                                                       "payloadGroup": payload_group, "unitGroup": group,
                                                       "conmonGroup": conmon_group, "containerId": info["Id"],
                                                       "supervisorPid": os.getpid(), "deadlineArmed": True})
                    proc.stdin.write(b"run\n")
                    proc.stdin.close()
                    break
            time.sleep(0.02)
        else:
            raise BrokerError("container-start-timeout")
        for stream, name in ((proc.stdout, "stdout"), (proc.stderr, "stderr")):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            left = remaining(record)
            if left <= 0:
                reason = "permit-expired"
                break
            for key, _ in selector.select(min(left, 0.1)):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                if count + len(data) > LOG_RESERVATION:
                    reason = "job-output-budget-exhausted"
                    break
                os.write(streams[key.data], data)
                count += len(data)
            if reason:
                break
        if reason:
            backend.stop_container(record["container"])
        code = proc.wait(timeout=5)
        backend.stop_container(record["container"])
        if not payload_group or not payload_empty(payload_group):
            raise BrokerError("payload-isolation-unconfirmed")
        for fd in streams.values():
            os.fsync(fd)
        receipt = {"state": "stopped" if reason else "exited", "exitCode": code,
                   "signal": "SIGKILL" if reason else None, "completedAt": now_iso(), "isolationConfirmed": True}
        if reason:
            receipt["reason"] = reason
        for name in streams:
            receipt[name] = file_result(path, name)
        write_json(path / "receipt.json", receipt)
    finally:
        selector.close()
        try:
            backend.stop_container(record["container"])
        finally:
            for fd in streams.values():
                os.close(fd)
            if proc:
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=5)
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    stream.close()
            os.close(lock)


if __name__ == "__main__":
    try:
        run(Path(sys.argv[1]))
    except Exception as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
        sys.exit(1)
