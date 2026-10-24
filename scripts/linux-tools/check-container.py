#!/usr/bin/env python3
"""功能概述：临时 CI runner 上实跑 W6 同参数 rootless 容器、helper/job 与代次持久性。
主要职责：固定镜像 digest 校验后导入 OCI；使用生产 PodmanBackend 的 create/health/collect/isolate。
代码库关系：复用 linux-environments/broker.py，仅 runner 的 HOME/storage 环境不同；不安装生产 bootstrap。
输入输出与副作用：仅创建带随机名的 CI 容器/命名卷，finally 回收；输出镜像、Podman、UID 与文件核对证据。
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
import platform
from pathlib import Path
import subprocess
import sys
import traceback
import time
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--digest", required=True)
    args = parser.parse_args()
    module_path = Path(__file__).resolve().parent.parent / "linux-environments/broker.py"
    spec = importlib.util.spec_from_file_location("broker", module_path)
    broker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(broker)
    backend = broker.PodmanBackend()
    backend.env = {k: v for k, v in os.environ.items() if k in ("HOME", "PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")}
    def diagnostic_command(*command, timeout=30):
        result = subprocess.run(["/usr/bin/podman", *command], env=backend.env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if result.returncode:
            print(json.dumps({"podmanCommand": command, "exitCode": result.returncode, "stderr": result.stderr.decode(errors="replace")}), flush=True)
            raise broker.BrokerError("podman-command-failed")
        return result.stdout
    backend.command = diagnostic_command
    info = json.loads(backend.command("info", "--format=json"))
    print(json.dumps({"runtimeEvidence": {"podman": info["version"], "ociRuntime": info["host"].get("ociRuntime"),
                                           "kernel": platform.release(), "rootless": info["host"]["security"]["rootless"],
                                           "apparmorRestrictUserns": Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").read_text().strip()
                                           if Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").exists() else None}}), flush=True)
    assert info["host"]["security"]["rootless"] is True and info["host"]["cgroupVersion"] == "v2"
    backend.command("load", "--input", str(Path(args.archive).resolve()), timeout=300)
    inspected = json.loads(backend.command("image", "inspect", "localhost/kaguya-shell:ci"))[0]
    assert inspected["Digest"] == args.digest, "loaded image digest differs from build receipt"
    image = "localhost/kaguya-shell@" + args.digest
    backend.command("image", "inspect", image)
    key = "ci-" + uuid.uuid4().hex
    env = {"environmentId": key, "workspaceId": key, "generation": 0, "container": key + "-0", "network": "none", "image": image}
    containers = []
    def operation(mode, **values):
        now = datetime.now(timezone.utc)
        operation_id = uuid.uuid4().hex
        reference = {"environmentId": key, "generation": env["generation"], "fencing": str(env["generation"] + 1), "leaseId": "lease", "workflowId": "flow"}
        permit = {**reference, "operationId": operation_id, "attemptId": operation_id, "digest": operation_id,
                  "expiresAt": (now + timedelta(seconds=20)).isoformat()}
        request = {"helperProtocolVersion": 1, "kind": "operation", "environment": reference, "scope": "ci",
                   "operationId": operation_id, "attemptId": operation_id, "digest": operation_id, "permit": permit,
                   "deadline": (now + timedelta(seconds=25)).isoformat(), "toolName": "shell.exec", "target": {}, "arguments": {"mode": mode, **values}}
        return backend.collect(backend.launch(env, request), 20)
    try:
        containers.append(dict(env))
        backend.create(env)
        home_info = backend.command("exec", env["container"], "/usr/bin/stat", "-c", "%u:%g:%a", "/home/tool").decode().strip()
        assert home_info == "1000:1000:700", home_info
        diagnostics = backend.command("exec", env["container"], "/bin/cat", "/proc/self/status").decode()
        print(json.dumps({"home": home_info, "processStatus": diagnostics}), flush=True)
        start = operation("start", argv=["/usr/local/bin/node", "-e", "setTimeout(()=>require('fs').writeFileSync('marker','actual-container'),100)"], cwd=".", env={})
        assert start["result"]["accepted"] is True
        limit = time.monotonic() + 10
        while True:
            state = operation("query", jobId=start["result"]["jobId"])["result"]
            if state["state"] in ("exited", "unknown", "stopped"):
                break
            assert time.monotonic() < limit, state
            time.sleep(0.02)
        if state["state"] != "exited" or state["exitCode"] != 0:
            print(json.dumps({"failedJob": state, "stderr": operation("export", jobId=start["result"]["jobId"], stream="stderr", mime="text/plain"),
                              "container": json.loads(backend.command("inspect", env["container"]))}), flush=True)
            raise AssertionError("actual namespace job did not exit successfully")
        assert state["uid"] == 1000
        isolation_code = """const f=require('fs'),a=require('assert');
a.equal(f.existsSync('/home/tool/kaguya-tools.sock'),false);
a.equal(f.existsSync('/proc/1/root/home/tool/kaguya-tools.sock'),false);
a.deepEqual(f.readdirSync('/workspace/.kaguya-tools'),[]);
for(const d of f.readdirSync('/proc/self/fd')){try{a.equal(f.readlinkSync('/proc/self/fd/'+d).includes('.kaguya-tools'),false)}catch(e){if(e.code!=='ENOENT')throw e}}
f.writeFileSync('isolation.json',JSON.stringify({uid:process.getuid(),pid:f.readlinkSync('/proc/self/ns/pid'),net:f.readlinkSync('/proc/self/ns/net')}));"""
        isolated = operation("start", argv=["/usr/local/bin/node", "-e", isolation_code], cwd=".", env={})
        limit = time.monotonic() + 10
        while True:
            isolation_job = operation("query", jobId=isolated["result"]["jobId"])["result"]
            if isolation_job["state"] in ("exited", "unknown", "stopped"):
                break
            assert time.monotonic() < limit
            time.sleep(0.02)
        assert isolation_job["state"] == "exited" and isolation_job["exitCode"] == 0, isolation_job
        import base64
        isolated_state = json.loads(base64.b64decode(operation("export", path="isolation.json", mime="application/json")["artifacts"][0]["dataBase64"]))
        assert isolated_state["pid"] != backend.command("exec", env["container"], "/usr/bin/readlink", "/proc/1/ns/pid").decode().strip()
        assert isolated_state["net"] != backend.command("exec", env["container"], "/usr/bin/readlink", "/proc/1/ns/net").decode().strip()
        original = {k: start["result"][k] for k in ("operationId", "attemptId")}
        verified = operation("verify", path="marker", original=original)["result"]
        assert verified["sha256"] == hashlib.sha256(b"actual-container").hexdigest()
        backend.isolate(env)
        env = {**env, "generation": 1, "container": key + "-1"}
        containers.append(dict(env))
        backend.create(env)
        persisted = operation("verify", path="marker", original=original)["result"]
        assert persisted["sha256"] == verified["sha256"]
        print(json.dumps({"rootless": True, "uid": state["uid"], "podman": info["version"], "imageDigest": args.digest,
                          "archiveSha256": hashlib.sha256(Path(args.archive).read_bytes()).hexdigest(), "generationRecovery": True,
                          "sandbox": isolated_state, "verified": verified}))
    finally:
        primary = sys.exc_info()[0] is not None
        if primary:
            traceback.print_exc()
        failures = []
        for container in containers:
            try:
                backend.isolate(container)
            except Exception as error:
                failures.append(error)
            try:
                backend.command("rm", "--force", container["container"])
            except Exception as error:
                failures.append(error)
        volume = "kaguya-workspace-" + broker.digest(key)[:24]
        exists = subprocess.run(["/usr/bin/podman", "volume", "exists", volume], env=backend.env)
        if exists.returncode == 0:
            try:
                backend.command("volume", "rm", volume)
            except Exception as error:
                failures.append(error)
        elif exists.returncode != 1:
            failures.append(RuntimeError("volume-existence-unconfirmed"))
        if failures:
            print(json.dumps({"cleanupFailures": [str(error) for error in failures]}), flush=True)
            if not primary:
                raise ExceptionGroup("CI environment cleanup failed", failures)


if __name__ == "__main__":
    main()
