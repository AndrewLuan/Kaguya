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
from pathlib import Path
import subprocess
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
    info = json.loads(backend.command("info", "--format=json"))
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
                          "archiveSha256": hashlib.sha256(Path(args.archive).read_bytes()).hexdigest(), "generationRecovery": True, "verified": verified}))
    finally:
        for container in containers:
            try:
                backend.isolate(container)
            finally:
                backend.command("rm", "--force", container["container"])
        volume = "kaguya-workspace-" + broker.digest(key)[:24]
        backend.command("volume", "rm", volume)


if __name__ == "__main__":
    main()
