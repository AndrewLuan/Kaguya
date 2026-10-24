/**
 * 功能概述：使用真实子进程和 Unix helper 证明持久 job、固定许可、代次、导出与文件后置状态。
 * fixture 为每个用例创建独立 workspace/HOME，after 在失败时也停止进程树并清理；状态等待有界。
 * 代码库关系：Node --test 直接运行，不将 Linux 服务测试误收集进 Windows Vitest；CI Linux 单独执行。
 * 输入输出与副作用：只操作临时目录和合成命令，不使用 Podman、模型、私人文件或真实桌面。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, lstat, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ToolService, startService } from "./service.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kt-"));
  const home = join(root, "home"),
    workspace = join(root, "work");
  await mkdir(home);
  await mkdir(workspace);
  const service = new ToolService({
    workspace,
    home,
    environmentId: "env",
    generation: 0,
    sandbox: false,
  });
  const cleanups = [];
  t.after(async () => {
    const errors = [];
    for (const cleanup of cleanups.reverse())
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    try {
      await service.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    if (errors.length)
      throw new AggregateError(errors, "fixture cleanup failed");
  });
  await service.ready();
  let index = 0;
  const request = (arguments_, expires = Date.now() + 8000) => {
    const operationId = `op:${++index}`,
      attemptId = `attempt:${index}`,
      digest = `digest:${index}`;
    const environment = {
      environmentId: "env",
      generation: service.generation,
      workflowId: "flow",
      leaseId: "lease",
      fencing: "1",
    };
    return {
      helperProtocolVersion: 1,
      kind: "operation",
      operationId,
      attemptId,
      digest,
      scope: "scope",
      environment,
      toolName: "shell.exec",
      target: {},
      arguments: arguments_,
      deadline: new Date(Date.now() + 20000).toISOString(),
      permit: {
        ...environment,
        operationId,
        attemptId,
        digest,
        expiresAt: new Date(expires).toISOString(),
      },
    };
  };
  return { root, home, workspace, service, request, cleanups };
}
async function until(read, check) {
  const deadline = Date.now() + 8000;
  while (true) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() >= deadline) assert.fail("state transition not observed");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const original = (req) => ({
  operationId: req.operationId,
  attemptId: req.attemptId,
});

test("start is accepted before delayed effect; replay starts once, query exits and verify reads real bytes", async (t) => {
  const f = await fixture(t);
  const req = f.request({
    mode: "start",
    argv: [
      process.execPath,
      "-e",
      `setTimeout(()=>{require('fs').appendFileSync('marker','once'); console.log(process.env.TASK_VALUE);},200)`,
    ],
    env: { TASK_VALUE: "isolated" },
  });
  const started = await f.service.handle(req);
  assert.equal(started.result.accepted, true);
  assert.equal(started.result.state, "running");
  await assert.rejects(lstat(join(f.workspace, "marker")), { code: "ENOENT" });
  const replay = await f.service.handle(req);
  assert.equal(replay.result.jobId, started.result.jobId);
  const query = f.request({ mode: "query", jobId: started.result.jobId });
  const completed = await until(
    () => f.service.handle(query),
    (r) => r.result.state === "exited",
  );
  assert.equal(completed.result.exitCode, 0);
  assert.equal(await readFile(join(f.workspace, "marker"), "utf8"), "once");
  const verified = await f.service.handle(
    f.request({ mode: "verify", path: "marker", original: original(req) }),
  );
  assert.equal(verified.result.size, 4);
  assert.equal(verified.result.original.operationId, req.operationId);
  const output = await f.service.handle(
    f.request({
      mode: "export",
      jobId: started.result.jobId,
      stream: "stdout",
      mime: "text/plain",
    }),
  );
  assert.equal(
    Buffer.from(output.artifacts[0].dataBase64, "base64").toString(),
    "isolated\n",
  );
  await assert.rejects(
    f.service.handle({
      ...req,
      arguments: { ...req.arguments, env: { TASK_VALUE: "changed" } },
    }),
    /conflict/,
  );
});
test("fixed permit expires: querying with a later permit does not renew job or allow delayed marker", async (t) => {
  const f = await fixture(t);
  const req = f.request(
    {
      mode: "start",
      argv: [
        process.execPath,
        "-e",
        `setTimeout(()=>require('fs').writeFileSync('forbidden','late'),700);setInterval(()=>{},100)`,
      ],
    },
    Date.now() + 250,
  );
  const started = await f.service.handle(req);
  const query = f.request({ mode: "query", jobId: started.result.jobId });
  const stopped = await until(
    () => f.service.handle(query),
    (r) => r.result.state === "stopped",
  );
  assert.equal(stopped.result.reason, "permit-expired");
  assert.equal(stopped.result.permitExpiresAt, req.permit.expiresAt);
  await assert.rejects(lstat(join(f.workspace, "forbidden")), {
    code: "ENOENT",
  });
});
test("stop kills managed parent and child, retains output; handoff fences old input and is idempotent", async (t) => {
  const f = await fixture(t);
  const started = await f.service.handle(
    f.request({
      mode: "start",
      argv: [
        process.execPath,
        "-e",
        `const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e',"setTimeout(()=>require('fs').writeFileSync('forbidden','x'),2000);setInterval(()=>{},100)"]);require('fs').writeFileSync('child',String(c.pid));console.log('ready');setInterval(()=>{},100)`,
      ],
    }),
  );
  await until(async () => {
    try {
      return await readFile(join(f.workspace, "child"), "utf8");
    } catch {
      return "";
    }
  }, Boolean);
  const stopped = await f.service.handle(
    f.request({ mode: "stop", jobId: started.result.jobId }),
  );
  assert.equal(stopped.result.state, "stopped");
  assert.equal(stopped.result.signal, "SIGKILL");
  const control = {
    helperProtocolVersion: 1,
    kind: "control",
    action: "handoff",
    environmentId: "env",
    expectedGeneration: 0,
    generation: 1,
    sandbox: false,
    mode: "human",
    controlOperationId: "control1",
  };
  assert.equal((await f.service.handle(control)).automationIsolated, true);
  assert.deepEqual(
    await f.service.handle(control),
    await f.service.handle(control),
  );
  await assert.rejects(
    f.service.handle(f.request({ mode: "query", jobId: started.result.jobId })),
    /authorized/,
  );
  assert.equal(
    (
      await f.service.handle({
        ...control,
        expectedGeneration: 1,
        generation: 2,
        mode: "automation",
        controlOperationId: "control2",
      })
    ).generation,
    2,
  );
  await assert.rejects(lstat(join(f.workspace, "forbidden")), {
    code: "ENOENT",
  });
});
test("workspace persists across service generation; old receipts verify without original dispatch", async (t) => {
  const f = await fixture(t);
  const req = f.request({
    mode: "start",
    argv: [
      process.execPath,
      "-e",
      "require('fs').writeFileSync('kept','value')",
    ],
  });
  const started = await f.service.handle(req);
  await until(
    () =>
      f.service.handle(
        f.request({ mode: "query", jobId: started.result.jobId }),
      ),
    (r) => r.result.state === "exited",
  );
  await f.service.close();
  const next = new ToolService({
    workspace: f.workspace,
    home: f.home,
    environmentId: "env",
    generation: 1,
  });
  await next.ready();
  f.cleanups.push(() => next.close());
  const verify = f.request({
    mode: "verify",
    jobId: started.result.jobId,
    original: original(req),
  });
  verify.environment.generation = verify.permit.generation = 1;
  const result = await next.handle(verify);
  assert.equal(result.result.job.generation, 0);
  assert.equal(result.result.job.exitCode, 0);
  assert.equal(await readFile(join(f.workspace, "kept"), "utf8"), "value");
});
test("exports are bounded with original file hash; path traversal and symlinks are denied", async (t) => {
  const f = await fixture(t);
  const req = f.request({
    mode: "start",
    argv: [
      process.execPath,
      "-e",
      "require('fs').writeFileSync('file',Buffer.alloc(100000,42))",
    ],
  });
  const started = await f.service.handle(req);
  await until(
    () =>
      f.service.handle(
        f.request({ mode: "query", jobId: started.result.jobId }),
      ),
    (r) => r.result.state === "exited",
  );
  const output = await f.service.handle(
    f.request({
      mode: "export",
      path: "file",
      maxBytes: 16,
      mime: "application/pdf",
    }),
  );
  assert.equal(output.truncated, true);
  assert.equal(output.result.exports[0].size, 100000);
  assert.equal(
    Buffer.from(output.artifacts[0].dataBase64, "base64").length,
    16,
  );
  await assert.rejects(
    f.service.handle(f.request({ mode: "export", path: "../outside" })),
    /denied/,
  );
  await symlink(join(f.workspace, "file"), join(f.workspace, "link"));
  await assert.rejects(
    f.service.handle(f.request({ mode: "export", path: "link" })),
    /unsafe/,
  );
  await assert.rejects(
    f.service.handle(
      f.request({ mode: "export", path: "file", sha256: "0".repeat(64) }),
    ),
    /hash/,
  );
});
test("fixed stdin/stdout helper uses actual ready service and shuts down socket", async (t) => {
  const f = await fixture(t);
  await f.service.close();
  const running = await startService({
    workspace: f.workspace,
    home: f.home,
    environmentId: "env",
    generation: 0,
    sandbox: false,
  });
  f.cleanups.push(() => running.close());
  const child = spawn(
    process.execPath,
    [new URL("./helper", import.meta.url).pathname],
    { env: { ...process.env, HOME: f.home }, stdio: ["pipe", "pipe", "pipe"] },
  );
  f.cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "exit");
      child.kill("SIGKILL");
      await done;
    }
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  const done = once(child, "close");
  child.stdin.end(
    JSON.stringify({ helperProtocolVersion: 1, kind: "health" }) + "\n",
  );
  await done;
  assert.deepEqual(JSON.parse(output), {
    helperProtocolVersion: 1,
    ready: true,
    generation: 0,
  });
});
