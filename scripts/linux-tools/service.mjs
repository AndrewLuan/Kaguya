/**
 * 功能概述：W7 固定 helper 服务，管理独立 cwd/env 的真实 shell 进程组、持久 job 和有界导出。
 * ToolService.handle 校验协议/permit/代次；start 在 spawn 前持久登记，重放仅查询同一 job。
 * stopTree/expire 在固定许可到期或接管时停止全树；query 不续期；verify 读取真实文件与原 job 回执。
 * 代码库关系：init 启动，helper 经 HOME 内 Unix socket 调用；W6 拥有外层环境及秘密 token。
 * 输入输出与副作用：仅 workspace 写入、子进程和内部 socket；journal 保留原 operation/attempt。
 * 命令接受与命令退出分别报告；断连不重发，服务重启将旧在途 job 保留为 unknown。
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  readlinkSync,
  createWriteStream,
} from "node:fs";
import { finished } from "node:stream/promises";
import {
  mkdir,
  lstat,
  open,
  readFile,
  rename,
  readdir,
  unlink,
  chmod,
  readlink,
} from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, relative, join, dirname, isAbsolute } from "node:path";

const LIMIT = 16 * 1024 ** 2;
const runFile = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
const fail = (code) => {
  throw new Error(code);
};
const outcome = (result) => ({
  status: "succeeded",
  evidence: "returned",
  result,
  artifacts: [],
  truncated: false,
});
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,240}$/.test(value);

async function atomic(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class ToolService {
  constructor({
    workspace = "/workspace",
    environmentId = process.env.KAGUYA_ENVIRONMENT_ID,
    generation = Number(process.env.KAGUYA_ENVIRONMENT_GENERATION),
    home = process.env.HOME,
    sandbox = true,
  } = {}) {
    if (
      !id(environmentId) ||
      !Number.isSafeInteger(generation) ||
      generation < 0
    )
      fail("invalid-initial-identity");
    this.workspace = resolve(workspace);
    this.home = home;
    this.sandbox = sandbox;
    this.environmentId = environmentId;
    this.generation = generation;
    this.mode = "automation";
    this.jobs = new Map();
    this.running = new Map();
    this.writes = new Map();
    this.controls = new Map();
    this.isolationFailures = new Set();
    this.active = false;
    this.closed = false;
    this.state = join(this.workspace, ".kaguya-tools", hash(environmentId));
  }
  async ready() {
    await this.directory(this.workspace);
    await this.directory(join(this.workspace, ".kaguya-tools"));
    await this.directory(this.state);
    for (const name of await readdir(this.state)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(this.state, name);
      if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink())
        fail("invalid-job-record");
      const record = JSON.parse(await readFile(path, "utf8"));
      if (
        record.environmentId !== this.environmentId ||
        name !== `${record.jobId}.json`
      )
        fail("job-identity-mismatch");
      if (["prepared", "running"].includes(record.state)) {
        record.state = "unknown";
        record.reason = "service-restarted";
        await atomic(path, record);
      }
      this.jobs.set(record.jobId, record);
    }
  }
  async directory(path) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("unsafe-directory");
  }
  async path(value = ".", { file = false } = {}) {
    if (typeof value !== "string" || value.includes("\0") || isAbsolute(value))
      fail("workspace-relative-path-required");
    const path = resolve(this.workspace, value);
    const rel = relative(this.workspace, path);
    if (
      rel === ".." ||
      rel.startsWith("../") ||
      rel.startsWith("..\\") ||
      isAbsolute(rel) ||
      rel.split(/[\\/]/).includes(".kaguya-tools")
    )
      fail("workspace-path-denied");
    const parts = rel.split(/[\\/]/).filter(Boolean);
    let cursor = this.workspace;
    for (let i = 0; i < parts.length; i++) {
      cursor = join(cursor, parts[i]);
      const info = await lstat(cursor);
      if (
        info.isSymbolicLink() ||
        ((i < parts.length - 1 || !file) && !info.isDirectory())
      )
        fail("unsafe-workspace-path");
    }
    return path;
  }
  check(req) {
    const p = req.permit,
      e = req.environment;
    if (
      this.closed ||
      this.mode !== "automation" ||
      req.helperProtocolVersion !== 1 ||
      req.kind !== "operation" ||
      !p ||
      !e
    )
      fail("input-not-authorized");
    if (
      !id(req.operationId) &&
      (typeof req.operationId !== "string" || req.operationId.length > 4096)
    )
      fail("invalid-operation");
    for (const key of [
      "environmentId",
      "generation",
      "fencing",
      "leaseId",
      "workflowId",
    ]) {
      if (p[key] !== e[key]) fail("permit-binding-mismatch");
    }
    for (const key of ["operationId", "attemptId", "digest"])
      if (p[key] !== req[key]) fail("permit-operation-mismatch");
    if (
      e.environmentId !== this.environmentId ||
      e.generation !== this.generation ||
      typeof req.scope !== "string" ||
      !req.scope.length ||
      req.scope.length > 4096 ||
      !id(e.workflowId) ||
      !id(e.leaseId)
    )
      fail("stale-environment");
    const expires = Date.parse(p.expiresAt),
      deadline = Date.parse(req.deadline);
    if (
      !Number.isFinite(expires) ||
      !Number.isFinite(deadline) ||
      expires <= Date.now() ||
      expires > deadline
    )
      fail("permit-expired");
    return expires;
  }
  async handle(req) {
    if (req.helperProtocolVersion !== 1) fail("helper-protocol-mismatch");
    if (req.kind === "health")
      return {
        helperProtocolVersion: 1,
        ready: !this.closed,
        generation: this.generation,
      };
    if (req.kind === "control") return this.control(req);
    this.check(req);
    if (this.active) fail("input-already-active");
    this.active = true;
    try {
      if (req.toolName !== "shell.exec") fail("tool-not-supported");
      const a = req.arguments;
      if (!a || typeof a !== "object") fail("invalid-arguments");
      switch (a.mode) {
        case "start":
          return await this.start(req);
        case "query":
          return outcome(await this.query(req, a.jobId));
        case "stop":
          return outcome(await this.stop(req, a.jobId));
        case "verify":
          return await this.verify(req);
        case "export":
          return await this.export(req);
        default:
          fail("shell-mode-not-supported");
      }
    } finally {
      this.active = false;
    }
  }
  async save(record) {
    const snapshot = structuredClone(record);
    const write = (this.writes.get(record.jobId) ?? Promise.resolve()).then(
      () => atomic(join(this.state, `${record.jobId}.json`), snapshot),
    );
    this.writes.set(record.jobId, write);
    await write;
    this.jobs.set(record.jobId, record);
  }
  view(record) {
    return Object.fromEntries(
      Object.entries(record).filter(
        ([key]) => !["requestHash", "pid"].includes(key),
      ),
    );
  }
  async start(req) {
    const a = req.arguments;
    if (
      !Array.isArray(a.argv) ||
      !a.argv.length ||
      a.argv.length > 128 ||
      a.argv.some(
        (x) => typeof x !== "string" || x.length > 32768 || x.includes("\0"),
      )
    )
      fail("invalid-argv");
    if (!a.argv[0].startsWith("/")) fail("absolute-executable-required");
    const cwd = await this.path(a.cwd ?? ".");
    const env = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: this.home,
      TMPDIR: "/tmp",
    };
    for (const [key, value] of Object.entries(a.env ?? {})) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        typeof value !== "string" ||
        value.includes("\0") ||
        /^(KAGUYA_|NODE_|LD_|DYLD_)/.test(key)
      )
        fail("invalid-job-environment");
      env[key] = value;
    }
    const jobId = hash(`${this.environmentId}\0${req.operationId}`);
    const requestHash = hash(
      canonical({
        operationId: req.operationId,
        attemptId: req.attemptId,
        digest: req.digest,
        scope: req.scope,
        environment: req.environment,
        arguments: a,
      }),
    );
    const previous = this.jobs.get(jobId);
    if (previous) {
      if (previous.requestHash !== requestHash) fail("job-operation-conflict");
      return outcome({
        accepted: previous.state !== "prepared",
        ...this.view(previous),
      });
    }
    const expires = this.check(req);
    const stdout = join(this.state, `${jobId}.stdout`),
      stderr = join(this.state, `${jobId}.stderr`);
    const record = {
      jobId,
      requestHash,
      environmentId: this.environmentId,
      generation: this.generation,
      workflowId: req.environment.workflowId,
      scope: req.scope,
      operationId: req.operationId,
      attemptId: req.attemptId,
      digest: req.digest,
      state: "prepared",
      cwd: a.cwd ?? ".",
      permitExpiresAt: req.permit.expiresAt,
      startedAt: new Date().toISOString(),
      uid: process.getuid(),
      gid: process.getgid(),
      exitCode: null,
      signal: null,
    };
    await this.save(record);
    let out, err, child;
    try {
      out = openSync(
        stdout,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      err = openSync(
        stderr,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      this.check(req); // 持久登记和目录 I/O 后，真正 spawn 前再次检查固定许可。
      const command = this.sandbox ? "/usr/bin/bwrap" : a.argv[0];
      const args = this.sandbox
        ? [
            "--unshare-user",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--unshare-net",
            "--die-with-parent",
            "--new-session",
            "--json-status-fd",
            "3",
            "--ro-bind",
            "/",
            "/",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--tmpfs",
            "/run",
            "--tmpfs",
            "/home/tool",
            "--bind",
            this.workspace,
            "/workspace",
            "--tmpfs",
            "/workspace/.kaguya-tools",
            "--chdir",
            "/workspace/" + relative(this.workspace, cwd),
            "--",
            "/usr/local/bin/node",
            "/opt/kaguya-tools/job-entry.mjs",
            String(expires),
            ...a.argv,
          ]
        : a.argv.slice(1);
      child = spawn(command, args, {
        cwd: this.sandbox ? this.workspace : cwd,
        env,
        detached: true,
        stdio: this.sandbox
          ? ["ignore", "pipe", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe"],
      });
      const completion = Promise.withResolvers();
      const running = { child, record, completion, stopping: false };
      const output = createWriteStream(stdout, { fd: out, autoClose: true });
      out = undefined;
      const errors = createWriteStream(stderr, { fd: err, autoClose: true });
      err = undefined;
      running.logs = Promise.all(
        [finished(output), finished(errors)].map((p) =>
          p.catch(() => {
            running.error = "output-unconfirmed";
            void this.stopTree(running, running.error);
          }),
        ),
      );
      child.stdout.pipe(output);
      child.stderr.pipe(errors);
      if (this.sandbox) {
        let status = "";
        child.stdio[3].on("data", (data) => {
          status += data;
          if (status.length > 65536) {
            running.error = "sandbox-status-invalid";
            void this.stopTree(running, running.error);
            return;
          }
          while (status.includes("\n")) {
            const split = status.indexOf("\n"),
              line = status.slice(0, split);
            status = status.slice(split + 1);
            try {
              const entry = JSON.parse(line);
              if (Number.isSafeInteger(entry["child-pid"])) {
                running.sandboxReady = true;
                try {
                  running.namespace = readlinkSync(
                    `/proc/${entry["child-pid"]}/ns/pid`,
                  );
                } catch (error) {
                  if (error.code !== "ENOENT")
                    running.error = "namespace-unconfirmed";
                }
              }
            } catch {
              running.error = "sandbox-status-invalid";
            }
          }
        });
      }
      this.running.set(jobId, running);
      child.once("error", (error) => {
        running.error = error.code ?? "spawn-failed";
      });
      child.once(
        "close",
        (code, signal) => void this.finish(running, code, signal),
      );
      running.timer = setTimeout(
        () => {
          void this.stopTree(running, "permit-expired");
        },
        Math.max(0, expires - Date.now()),
      );
      record.pid = child.pid ?? null;
      record.state = "running";
      await this.save(record);
      return outcome({ accepted: true, ...this.view(record) });
    } catch (error) {
      if (child)
        await this.stopTree(this.running.get(jobId), "start-unconfirmed");
      else {
        record.state = "unknown";
        record.reason = "start-unconfirmed";
        await this.save(record);
      }
      throw error;
    } finally {
      if (out !== undefined) closeSync(out);
      if (err !== undefined) closeSync(err);
    }
  }
  async finish(running, code, signal) {
    clearTimeout(running.timer);
    await running.logs;
    const r = running.record;
    // 直属父进程退出后也清理仍存活的同组后代，禁止孤儿继续产生副作用。
    try {
      if (running.child.pid) process.kill(-running.child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") running.error = "tree-stop-unconfirmed";
    }
    if (this.sandbox && !running.sandboxReady && !running.stopping)
      running.error = "sandbox-not-ready";
    if (this.sandbox && running.namespace) {
      const deadline = Date.now() + 2000;
      try {
        while (true) {
          let alive = false;
          for (const pid of await readdir("/proc")) {
            if (!/^\d+$/.test(pid)) continue;
            try {
              if (
                (await readlink(`/proc/${pid}/ns/pid`)) === running.namespace
              ) {
                const stat = await readFile(`/proc/${pid}/stat`, "utf8");
                if (
                  !["Z", "X"].includes(
                    stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0],
                  )
                )
                  alive = true;
              }
            } catch (error) {
              if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
            }
          }
          if (!alive) break;
          if (Date.now() >= deadline) fail("namespace-still-running");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } catch {
        running.error = "namespace-stop-unconfirmed";
      }
    }
    if (
      running.error?.includes("unconfirmed") ||
      running.error === "sandbox-status-invalid"
    )
      this.isolationFailures.add(r.jobId);
    r.state = running.error
      ? "unknown"
      : running.stopping
        ? "stopped"
        : "exited";
    r.exitCode = code;
    r.signal = signal;
    r.completedAt = new Date().toISOString();
    if (running.error) r.reason = running.error;
    try {
      for (const stream of ["stdout", "stderr"]) {
        const f = await open(
          join(this.state, `${r.jobId}.${stream}`),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const info = await f.stat();
          const h = createHash("sha256");
          for await (const data of f.createReadStream({ autoClose: false }))
            h.update(data);
          r[stream] = { size: info.size, sha256: h.digest("hex") };
        } finally {
          await f.close();
        }
      }
      await this.save(r);
    } catch {
      r.state = "unknown";
      r.reason = "receipt-write-unconfirmed";
    }
    this.running.delete(r.jobId);
    running.completion.resolve();
  }
  async stopTree(running, reason) {
    if (!running) return;
    running.stopping = true;
    running.record.reason = reason;
    try {
      if (running.child.pid) process.kill(-running.child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") running.error = "tree-stop-unconfirmed";
    }
    await running.completion.promise;
  }
  owned(req, jobId) {
    if (typeof jobId !== "string" || !/^[a-f0-9]{64}$/.test(jobId))
      fail("invalid-job-id");
    const record = this.jobs.get(jobId);
    if (
      !record ||
      record.scope !== req.scope ||
      record.environmentId !== this.environmentId
    )
      fail("job-not-authorized");
    return record;
  }
  async query(req, jobId) {
    const record = this.owned(req, jobId);
    if (record.generation !== this.generation && this.running.has(jobId))
      fail("stale-job-generation");
    return this.view(record);
  }
  async stop(req, jobId) {
    const record = this.owned(req, jobId);
    this.check(req);
    await this.stopTree(this.running.get(jobId), "stop-requested");
    return this.view(record);
  }
  async verify(req) {
    const a = req.arguments;
    if (
      !a.original ||
      typeof a.original.operationId !== "string" ||
      typeof a.original.attemptId !== "string"
    )
      fail("original-operation-required");
    if (a.jobId) {
      const r = this.owned(req, a.jobId);
      if (
        r.operationId !== a.original.operationId ||
        r.attemptId !== a.original.attemptId
      )
        fail("original-operation-mismatch");
      return outcome({
        original: a.original,
        checkedAt: new Date().toISOString(),
        job: this.view(r),
      });
    }
    const result = await this.readFile(req, this.workspace, a.path, false);
    return outcome({
      original: a.original,
      path: a.path,
      ...result,
      checkedAt: new Date().toISOString(),
    });
  }
  async readFile(req, root, path, exporting) {
    const remaining = this.check(req) - Date.now();
    const { stdout } = await runFile(
      "/usr/bin/python3",
      [
        fileURLToPath(new URL("./file-access.py", import.meta.url)),
        root,
        path,
        String(exporting ? (req.arguments.offset ?? 0) : 0),
        String(exporting ? (req.arguments.maxBytes ?? LIMIT) : 0),
        req.arguments.sha256 ?? "",
      ],
      {
        timeout: Math.max(1, Math.min(20000, remaining)),
        maxBuffer: 24 * 1024 ** 2,
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    this.check(req);
    return JSON.parse(stdout);
  }
  async export(req) {
    const a = req.arguments;
    let path,
      root = this.workspace;
    if (a.jobId) {
      const r = this.owned(req, a.jobId);
      if (!["stdout", "stderr"].includes(a.stream)) fail("invalid-job-stream");
      root = this.state;
      path = `${r.jobId}.${a.stream}`;
    } else path = a.path;
    const mime = a.mime ?? "application/octet-stream";
    if (
      ![
        "image/png",
        "image/jpeg",
        "image/webp",
        "text/plain",
        "text/csv",
        "application/json",
        "application/pdf",
        "application/zip",
        "application/octet-stream",
        "video/webm",
      ].includes(mime)
    )
      fail("invalid-export-mime");
    const result = await this.readFile(req, root, path, true);
    const { dataBase64, ...metadata } = result;
    return {
      ...outcome({
        exports: [
          {
            path: a.path ?? null,
            jobId: a.jobId ?? null,
            stream: a.stream ?? null,
            ...metadata,
          },
        ],
      }),
      artifacts: [{ mime, dataBase64 }],
      truncated: result.offset > 0 || result.bytes < result.size,
    };
  }
  async control(req) {
    const previous = this.controls.get(req.controlOperationId);
    if (previous) {
      if (previous.request !== canonical(req)) fail("control-conflict");
      return previous.response;
    }
    if (
      req.action !== "handoff" ||
      req.environmentId !== this.environmentId ||
      req.expectedGeneration !== this.generation ||
      req.generation !== this.generation + 1 ||
      !["human", "automation"].includes(req.mode) ||
      !id(req.controlOperationId)
    )
      fail("invalid-control");
    this.mode = "draining";
    await Promise.all(
      [...this.running.values()].map((job) => this.stopTree(job, "handoff")),
    );
    if (this.isolationFailures.size) fail("automation-isolation-unconfirmed");
    this.generation = req.generation;
    this.mode = req.mode;
    const response = {
      helperProtocolVersion: 1,
      automationIsolated: true,
      generation: this.generation,
      mode: this.mode,
    };
    this.controls.set(req.controlOperationId, {
      request: canonical(req),
      response,
    });
    return response;
  }
  async close() {
    this.closed = true;
    await Promise.all(
      [...this.running.values()].map((job) =>
        this.stopTree(job, "service-stopped"),
      ),
    );
  }
}

export async function startService(options = {}) {
  if (process.platform === "win32") fail("linux-helper-required");
  const service = new ToolService(options);
  await service.ready();
  const path = join(service.home, "kaguya-tools.sock");
  // 不接管可能仍由活跃 init 持有的 socket；新容器 HOME 是全新 tmpfs。
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let data = Buffer.alloc(0);
    socket.setTimeout(10000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 262144) socket.destroy();
    });
    socket.on("end", async () => {
      socket.setTimeout(0);
      try {
        socket.end(
          JSON.stringify(
            await service.handle(JSON.parse(data.toString("utf8"))),
          ) + "\n",
        );
      } catch {
        socket.end(
          JSON.stringify({
            status: "unknown",
            evidence: "unconfirmed",
            result: { reason: "helper-unconfirmed" },
            artifacts: [],
            truncated: false,
          }) + "\n",
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  let closing;
  const close = () =>
    (closing ??= (async () => {
      await service.close();
      await new Promise((resolve) => server.close(resolve));
      try {
        await unlink(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    })());
  process.once("SIGTERM", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
  return { service, close };
}
