"""功能概述：宿主可信 shell 控制面；任意命令只在独立 rootless 容器中执行。
主要职责：ShellJobs 持久登记原 operation/attempt，调度独立 systemd job unit，
核对停止屏障，提供 start/query/stop/verify/export；文件读取保留逐级目录 FD。
代码库关系：PodmanBackend 路由 shell.exec；job_runner.py 独占运行回执，
本模块只在 unit 和整个 cgroup 已停止后补写终态，不与 supervisor 并发写 receipt。
输入输出与副作用：私有宿主目录保存 manifest/日志，只有 workspace 命名卷进入容器。
启动声明一旦落盘就不重放；截止时间固定，未知状态必须隔离后核对，不恢复执行。
"""
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time

from broker import BrokerError, atomic, canonical, digest

LIMIT = 16 * 1024 ** 2
LOG_RESERVATION = 32 * 1024 ** 2
LOG_TOTAL = 1024 ** 3
MIMES = {"image/png", "image/jpeg", "image/webp", "text/plain", "text/csv", "application/json",
         "application/pdf", "application/zip", "application/octet-stream", "video/webm"}
TERMINAL = {"exited", "stopped", "unknown"}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value, exclusive=False):
    atomic(Path(path), canonical(value).encode(), exclusive=exclusive)


def read_json(path):
    with open(path, "rb") as source:
        return json.load(source)


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def parts(path, directory=False):
    if directory and path == ".":
        return []
    if not isinstance(path, str) or not path or len(path) > 4096:
        raise BrokerError("workspace-relative-path-required")
    result = path.split("/")
    if any(p in ("", ".", "..", ".kaguya-tools") or "\\" in p or "\0" in p for p in result):
        raise BrokerError("workspace-path-denied")
    return result


def open_beneath(root, path, directory=False):
    components = parts(path, directory)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for i, component in enumerate(components):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if directory or i < len(components) - 1:
                flags |= os.O_DIRECTORY
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def file_result(root, path, offset=0, length=0, expected=None, deadline=None):
    if type(offset) is not int or offset < 0 or type(length) is not int or not 0 <= length <= LIMIT:
        raise BrokerError("invalid-export-range")
    with os.fdopen(open_beneath(root, path), "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise BrokerError("regular-file-required")
        h = hashlib.sha256()
        while chunk := source.read(1024 ** 2):
            if deadline is not None and time.time() >= deadline:
                raise BrokerError("permit-expired")
            h.update(chunk)
        source.seek(offset)
        data = source.read(length)
        after = os.fstat(source.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise BrokerError("file-changed-during-read")
        sha = h.hexdigest()
        if expected is not None and expected != sha:
            raise BrokerError("export-hash-mismatch")
        result = {"size": before.st_size, "sha256": sha}
        if length:
            result.update(offset=offset, bytes=len(data), partSha256=hashlib.sha256(data).hexdigest(),
                          dataBase64=base64.b64encode(data).decode())
        return result


def success(result, artifacts=None, truncated=False):
    return {"status": "succeeded", "evidence": "returned", "result": result,
            "artifacts": artifacts or [], "truncated": truncated}


class ShellJobs:
    def __init__(self, root, backend):
        self.root = Path(root) / "shell-jobs"
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.backend = backend

    def system(self, *args, timeout=20, check=True):
        result = subprocess.run(args, env=self.backend.env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if check and result.returncode:
            raise BrokerError("systemd-job-command-failed")
        return result

    def properties(self, unit):
        raw = self.system("/usr/bin/systemctl", "--user", "show", unit,
                          "--property=ActiveState,SubState,ControlGroup,MainPID,Result,ActiveEnterTimestampMonotonic,RuntimeMaxUSec").stdout
        return dict(line.split("=", 1) for line in raw.decode().splitlines() if "=" in line)

    def configure_environment(self, env):
        # 动态 slice 的限制覆盖桌面、全部 job 以及各自 conmon，而非每个容器重复领取总额。
        name = self.slice(env)
        self.system("/usr/bin/systemctl", "--user", "set-property", "--runtime", name,
                    "CPUQuota=200%", "MemoryMax=4G", "MemorySwapMax=0", "TasksMax=512")
        self.system("/usr/bin/systemctl", "--user", "start", name)
        return name

    @staticmethod
    def slice(env):
        return "kaguya-e" + digest(env["environmentId"])[:24] + ".slice"

    def records(self, env=None):
        for path in sorted(self.root.glob("*/manifest.json")):
            record = read_json(path)
            if env is None or record["environmentId"] == env["environmentId"]:
                yield path.parent, record

    def workspace(self, env):
        volume = "kaguya-workspace-" + digest(env["workspaceId"])[:24]
        info = json.loads(self.backend.command("volume", "inspect", volume))[0]
        return info["Mountpoint"]

    def check(self, env, req):
        p, e = req["permit"], req["environment"]
        for key in ("environmentId", "generation", "fencing", "leaseId", "workflowId"):
            if p.get(key) != e.get(key):
                raise BrokerError("permit-binding-mismatch")
        for key in ("operationId", "attemptId", "digest"):
            if p.get(key) != req.get(key):
                raise BrokerError("permit-operation-mismatch")
        expires = datetime.fromisoformat(p["expiresAt"].replace("Z", "+00:00")).timestamp()
        deadline = datetime.fromisoformat(req["deadline"].replace("Z", "+00:00")).timestamp()
        if e["environmentId"] != env["environmentId"] or e["generation"] != env["generation"]:
            raise BrokerError("stale-environment")
        if expires <= time.time() or expires > deadline:
            raise BrokerError("permit-expired")
        return expires

    def handle(self, env, req):
        expires = self.check(env, req)
        a = req["arguments"]
        if a.get("mode") == "start":
            return self.start(env, req, expires)
        if a.get("mode") in ("query", "stop"):
            path, record = self.owned(env, req, a.get("jobId"))
            if a["mode"] == "stop":
                self.stop(path, record, "stop-requested")
            return success(self.view(path, record))
        if a.get("mode") == "verify":
            original = a.get("original")
            if not isinstance(original, dict) or not all(isinstance(original.get(k), str) for k in ("operationId", "attemptId")):
                raise BrokerError("original-operation-required")
            if a.get("jobId"):
                path, record = self.owned(env, req, a["jobId"])
                if any(record[k] != original[k] for k in ("operationId", "attemptId")):
                    raise BrokerError("original-operation-mismatch")
                return success({"original": original, "checkedAt": now_iso(), "job": self.view(path, record)})
            result = file_result(self.workspace(env), a.get("path"), deadline=expires)
            return success({"original": original, "checkedAt": now_iso(), "path": a["path"], **result})
        if a.get("mode") == "export":
            root, path = self.workspace(env), a.get("path")
            if a.get("jobId"):
                root, record = self.owned(env, req, a["jobId"])
                self.view(root, record)
                if a.get("stream") not in ("stdout", "stderr"):
                    raise BrokerError("invalid-job-stream")
                path = a["stream"]
            mime = a.get("mime", "application/octet-stream")
            if mime not in MIMES:
                raise BrokerError("invalid-export-mime")
            result = file_result(root, path, a.get("offset", 0), a.get("maxBytes", LIMIT), a.get("sha256"), expires)
            data = result.pop("dataBase64", "")
            return success({"exports": [{"path": a.get("path"), "jobId": a.get("jobId"),
                                         "stream": a.get("stream"), **result}]},
                           [{"mime": mime, "dataBase64": data}], result.get("offset", 0) > 0 or result.get("bytes", 0) < result["size"])
        raise BrokerError("shell-mode-not-supported")

    def owned(self, env, req, job_id):
        if not isinstance(job_id, str) or not re.fullmatch("[a-f0-9]{64}", job_id):
            raise BrokerError("invalid-job-id")
        path = self.root / job_id
        try:
            record = read_json(path / "manifest.json")
        except FileNotFoundError:
            raise BrokerError("job-not-authorized") from None
        if record["environmentId"] != env["environmentId"] or record["scope"] != req["scope"]:
            raise BrokerError("job-not-authorized")
        return path, record

    def start(self, env, req, expires):
        a = req["arguments"]
        argv = a.get("argv")
        if (not isinstance(argv, list) or not 1 <= len(argv) <= 128 or
                any(not isinstance(v, str) or len(v) > 32768 or "\0" in v for v in argv) or not argv[0].startswith("/")):
            raise BrokerError("invalid-argv")
        cwd = a.get("cwd", ".")
        fd = open_beneath(self.workspace(env), cwd, directory=True)
        os.close(fd)
        variables = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/home/tool", "TMPDIR": "/tmp"}
        if not isinstance(a.get("env", {}), dict):
            raise BrokerError("invalid-job-environment")
        for key, value in a.get("env", {}).items():
            if (not re.fullmatch("[A-Za-z_][A-Za-z0-9_]*", key) or not isinstance(value, str) or "\0" in value or
                    re.match("^(KAGUYA_|NODE_|LD_|DYLD_|NOTIFY_SOCKET$|WATCHDOG_|LISTEN_)", key)):
                raise BrokerError("invalid-job-environment")
            variables[key] = value
        job_id = hashlib.sha256((env["environmentId"] + "\0" + req["operationId"]).encode()).hexdigest()
        request_hash = digest({k: req[k] for k in ("operationId", "attemptId", "digest", "scope", "environment", "arguments")})
        path = self.root / job_id
        if (path / "manifest.json").exists():
            record = read_json(path / "manifest.json")
            if record["requestHash"] != request_hash:
                raise BrokerError("job-operation-conflict")
            view = self.view(path, record)
            return success({"accepted": view["state"] != "prepared", **view})
        reserved = sum(LOG_RESERVATION if not (p / "receipt.json").exists() else
                       sum((p / stream).stat().st_size for stream in ("stdout", "stderr") if (p / stream).exists())
                       for p, _ in self.records())
        if reserved + LOG_RESERVATION > LOG_TOTAL:
            raise BrokerError("job-output-budget-exhausted")
        path.mkdir(mode=0o700, exist_ok=True)
        left = expires - time.time()
        if left <= 0:
            raise BrokerError("permit-expired")
        record = {"jobId": job_id, "requestHash": request_hash, "environmentId": env["environmentId"],
                  "generation": env["generation"], "fencing": req["environment"]["fencing"],
                  "leaseId": req["environment"]["leaseId"], "workflowId": req["environment"]["workflowId"],
                  "scope": req["scope"], "operationId": req["operationId"], "attemptId": req["attemptId"],
                  "digest": req["digest"], "state": "prepared", "cwd": cwd,
                  "permitExpiresAt": req["permit"]["expiresAt"], "expires": expires,
                  "monotonicDeadline": time.monotonic() + left,
                  "bootDeadline": time.clock_gettime(time.CLOCK_BOOTTIME) + left, "bootId": boot_id(),
                  "startedAt": now_iso(), "uid": 1000, "gid": 1000, "exitCode": None, "signal": None,
                  "unit": "kaguya-job-" + job_id + ".service", "container": "kaguya-job-" + job_id,
                  "slice": self.slice(env), "image": env["image"], "network": env["network"],
                  "volume": "kaguya-workspace-" + digest(env["workspaceId"])[:24],
                  "argv": argv, "env": variables, "hostEnv": self.backend.env}
        write_json(path / "manifest.json", record, exclusive=True)
        runner = str(Path(__file__).with_name("job_runner.py"))
        command = ["/usr/bin/systemd-run", "--user", "--quiet", "--unit=" + record["unit"],
                   "--slice=" + record["slice"], "--service-type=exec", "--property=Delegate=yes",
                   "--property=KillMode=control-group", "--property=KillSignal=SIGKILL", "--property=Restart=no",
                   "--property=TimeoutStopSec=5s", "--property=RuntimeMaxSec=" + str(left) + "s",
                   "--property=UMask=0077", "--property=StandardOutput=null", "--property=StandardError=journal"]
        command += ["--setenv=" + k + "=" + v for k, v in self.backend.env.items()]
        self.system(*command, "/usr/bin/python3", "-I", runner, str(path))
        end = min(expires, time.time() + 20)
        while time.time() < end:
            if (path / "running.json").exists() or (path / "receipt.json").exists():
                return success({"accepted": True, **self.view(path, record)})
            state = self.properties(record["unit"])
            if state.get("ActiveState") in ("inactive", "failed"):
                self.stop(path, record, "start-unconfirmed")
                raise BrokerError("job-start-unconfirmed")
            time.sleep(0.02)
        self.stop(path, record, "start-unconfirmed")
        raise BrokerError("job-start-unconfirmed")

    def stopped(self, record):
        props = self.properties(record["unit"])
        group = props.get("ControlGroup")
        if props.get("ActiveState") not in ("inactive", "failed"):
            return False
        if group:
            events = Path("/sys/fs/cgroup") / group.lstrip("/") / "cgroup.events"
            if events.exists() and "populated 1" in events.read_text():
                return False
        exists = self.backend.command("ps", "--all", "--filter", "name=^" + record["container"] + "$", "--format={{.ID}}").strip()
        if exists:
            state = json.loads(self.backend.command("inspect", record["container"]))[0]["State"]
            if state["Running"] or state.get("Pid", 0):
                return False
        return True

    def stop(self, path, record, reason):
        # 新旧代次都按不可变 job 成员身份停止；不通过用户输入构造 unit 或容器名。
        write_json(path / "stop.json", {"reason": reason})
        self.system("/usr/bin/systemctl", "--user", "stop", record["unit"], check=False)
        # runtime 状态可能尚未被 conmon 回收，显式 kill/wait 后仍以 cgroup 和 inspect 为准。
        self.backend.stop_container(record["container"])
        end = time.monotonic() + 10
        while not self.stopped(record):
            if time.monotonic() >= end:
                raise BrokerError("job-isolation-unconfirmed")
            time.sleep(0.02)
        if not (path / "receipt.json").exists():
            self.finalize(path, record, "stopped", reason)

    def finalize(self, path, record, state, reason):
        receipt = {"state": state, "reason": reason, "completedAt": now_iso(), "exitCode": None,
                   "signal": "SIGKILL" if state == "stopped" else None, "isolationConfirmed": True}
        for stream in ("stdout", "stderr"):
            if (path / stream).exists():
                receipt[stream] = file_result(path, stream)
        write_json(path / "receipt.json", receipt)

    def view(self, path, record):
        view = {k: record[k] for k in ("jobId", "environmentId", "generation", "workflowId", "scope", "operationId",
                                      "attemptId", "digest", "state", "cwd", "permitExpiresAt", "startedAt", "uid", "gid", "exitCode", "signal")}
        if (path / "receipt.json").exists():
            view.update(read_json(path / "receipt.json"))
        elif (path / "running.json").exists():
            if self.stopped(record):
                reason = "permit-expired" if time.time() >= record["expires"] else "supervisor-lost"
                self.finalize(path, record, "stopped" if reason == "permit-expired" else "unknown", reason)
                view.update(read_json(path / "receipt.json"))
            else:
                view["state"] = "running"
        return view

    def isolate(self, env, reason="environment-fenced"):
        for path, record in self.records(env):
            self.stop(path, record, reason)

