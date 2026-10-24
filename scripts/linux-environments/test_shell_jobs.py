"""功能概述：验证宿主 shell 控制面的持久身份、权限、日志预算和文件读取边界。
主要职责：使用真实临时目录验证不可重复登记、固定 permit、跨 scope 拒绝与路径替换；
真实 systemd/PID namespace/截止崩溃验证位于 check-container.py，不用 mock 冒充隔离成功。
代码库关系：直接测试生产 ShellJobs、file_result/open_beneath；现有 Broker 测试覆盖 token/fence。
输入输出与副作用：每例创建独立目录，所有资源通过 addCleanup/finally 收尾；无后台进程。
"""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from broker import BrokerError
from shell_jobs import ShellJobs, LOG_RESERVATION, file_result, open_beneath, read_json, write_json


class Backend:
    env = {"PATH": "/usr/bin:/bin"}
    def __init__(self, workspace):
        self.workspace = workspace
    def command(self, *args):
        if args[:2] == ("volume", "inspect"):
            return json.dumps([{"Mountpoint": str(self.workspace)}]).encode()
        raise AssertionError(args)


class ShellJobsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.jobs = ShellJobs(self.root / "private", Backend(self.workspace))
        def read_workspace(env, path, expires, *, directory=False, **kwargs):
            if directory:
                fd = open_beneath(self.workspace, path, directory=True)
                os.close(fd)
                return {}
            return file_result(self.workspace, path, deadline=expires, **kwargs)
        self.jobs.workspace_read = read_workspace
        self.env = {"environmentId": "env", "generation": 3, "workspaceId": "ws", "image": "fixed@sha256:" + "1" * 64, "network": "none"}
        self.addCleanup(patch.stopall)
        patch("shell_jobs.boot_id", return_value="boot").start()
        patch.object(time, "CLOCK_BOOTTIME", time.CLOCK_MONOTONIC, create=True).start()

    def request(self, op="op", **arguments):
        ref = {"environmentId": "env", "generation": 3, "fencing": "f", "leaseId": "lease", "workflowId": "workflow"}
        expiry = (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()
        return {"environment": ref, "permit": {**ref, "operationId": op, "attemptId": "attempt", "digest": "digest", "expiresAt": expiry},
                "operationId": op, "attemptId": "attempt", "digest": "digest", "scope": "scope", "deadline": expiry,
                "arguments": {"mode": "start", "argv": ["/bin/true"], "cwd": ".", "env": {}, **arguments}}

    def prepare(self, req):
        return self.jobs.prepare(self.env, req, self.jobs.check(self.env, req))

    def test_same_operation_returns_one_immutable_identity_without_extending_deadline(self):
        req = self.request()
        path, record, existing = self.prepare(req)
        self.assertFalse(existing)
        original = (path / "manifest.json").read_bytes()
        renewed = {**req, "permit": {**req["permit"], "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=120)).isoformat()}}
        renewed["deadline"] = renewed["permit"]["expiresAt"]
        again, other, existing = self.prepare(renewed)
        self.assertTrue(existing)
        self.assertEqual(again, path)
        self.assertEqual(other["monotonicDeadline"], record["monotonicDeadline"])
        self.assertEqual((path / "manifest.json").read_bytes(), original)
        self.assertFalse((self.workspace / ".kaguya-tools").exists())
        self.assertNotIn("permit", record)
        self.assertNotIn("token", record)
        self.assertEqual(record["uid"], 1000)
        conflict = {**req, "arguments": {**req["arguments"], "argv": ["/bin/false"]}}
        with self.assertRaisesRegex(BrokerError, "job-operation-conflict"):
            self.prepare(conflict)

    def test_old_permit_and_mismatched_generation_are_rejected(self):
        req = self.request()
        req["permit"]["expiresAt"] = "2000-01-01T00:00:00Z"
        with self.assertRaisesRegex(BrokerError, "permit-expired"):
            self.jobs.check(self.env, req)
        req = self.request()
        req["permit"]["generation"] = 2
        with self.assertRaisesRegex(BrokerError, "permit-binding-mismatch"):
            self.jobs.check(self.env, req)

    def test_control_environment_injection_and_unsafe_cwd_are_rejected(self):
        for variables in ({"NODE_OPTIONS": "--require /workspace/x"}, {"KAGUYA_TOKEN": "x"}, {"NOTIFY_SOCKET": "/x"}, {"LD_PRELOAD": "/x"}):
            with self.subTest(variables=variables), self.assertRaisesRegex(BrokerError, "invalid-job-environment"):
                self.prepare(self.request(env=variables))
        for cwd in ("/tmp", "../private", "a/../b", ".kaguya-tools"):
            with self.subTest(cwd=cwd), self.assertRaises(BrokerError):
                self.prepare(self.request(cwd=cwd))
        (self.workspace / "link").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            self.prepare(self.request(cwd="link"))

    def test_scope_and_original_attempt_remain_bound(self):
        req = self.request()
        path, record, _ = self.prepare(req)
        with self.assertRaisesRegex(BrokerError, "job-not-authorized"):
            self.jobs.owned(self.env, {**req, "scope": "other"}, record["jobId"])
        query = self.request("verify", mode="verify", jobId=record["jobId"], original={"operationId": "op", "attemptId": "other"})
        with self.assertRaisesRegex(BrokerError, "original-operation-mismatch"):
            self.jobs.handle(self.env, query)
        self.assertEqual(read_json(path / "manifest.json")["attemptId"], "attempt")

    def test_output_reservations_bound_all_environments(self):
        with patch("shell_jobs.LOG_TOTAL", 2 * LOG_RESERVATION):
            p, _, _ = self.prepare(self.request("one"))
            self.prepare(self.request("two"))
            with self.assertRaisesRegex(BrokerError, "job-output-budget-exhausted"):
                self.prepare(self.request("three"))
            (p / "stdout").write_bytes(b"done")
            write_json(p / "receipt.json", {"state": "exited"})
            with self.assertRaisesRegex(BrokerError, "job-output-budget-exhausted"):
                self.prepare(self.request("three"))
            # 两份完整 reservation 不能再取得第三份；释放足够额度才允许新 job。
            with patch("shell_jobs.LOG_TOTAL", 2 * LOG_RESERVATION + 4):
                self.prepare(self.request("three"))

    def test_file_export_hash_range_and_fifo_rejection(self):
        (self.workspace / "file").write_bytes(b"abcdef")
        result = file_result(self.workspace, "file", 2, 2)
        self.assertEqual(result["sha256"], hashlib.sha256(b"abcdef").hexdigest())
        self.assertEqual(result["dataBase64"], "Y2Q=")
        self.assertEqual(result["size"], 6)
        with self.assertRaisesRegex(BrokerError, "export-hash-mismatch"):
            file_result(self.workspace, "file", expected="0" * 64)
        os.mkfifo(self.workspace / "fifo")
        with self.assertRaisesRegex(BrokerError, "regular-file-required"):
            file_result(self.workspace, "fifo")
        (self.workspace / "link").symlink_to(self.workspace / "file")
        with self.assertRaises(OSError):
            file_result(self.workspace, "link")

    def test_directory_swap_cannot_redirect_open_file_to_private_tree(self):
        folder = self.workspace / "dir"
        folder.mkdir()
        (folder / "file").write_bytes(b"public")
        private = self.root / "secret"
        private.mkdir()
        (private / "file").write_bytes(b"private")
        original_open = os.open
        swapped = False
        def racing_open(path, flags, *args, **kwargs):
            nonlocal swapped
            fd = original_open(path, flags, *args, **kwargs)
            if path == "dir" and not swapped:
                swapped = True
                folder.rename(self.workspace / "moved")
                folder.symlink_to(private, target_is_directory=True)
            return fd
        with patch("shell_jobs.os.open", side_effect=racing_open):
            result = file_result(self.workspace, "dir/file", 0, 20)
        self.assertEqual(result["sha256"], hashlib.sha256(b"public").hexdigest())


if __name__ == "__main__":
    unittest.main()
