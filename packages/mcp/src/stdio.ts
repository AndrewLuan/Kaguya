/**
 * 功能概述：用一个受宿主管理的子进程实现公开 MCP Transport，协议探测始终复用本进程。
 * SingleProcessStdio.start 以 shell=false 和明确环境启动；send 写入有界 JSON-RPC 行；
 * close 先结束 stdin，再按有界阶段终止本组件子进程并等待 exit，最后释放管道。
 * MCP Client 使用公开 Transport/parseJSONRPCMessage，不访问 SDK 私有字段，也不创建探测兄弟进程。
 * stdout 只作协议；stderr 被持续排空但不进入日志，失败只报告固定错误码。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  parseJSONRPCMessage,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/client";
import { writeSensitiveJson } from "@kaguya/config";
import { McpError } from "./config.js";
import {
  verifyOwnedGroup,
  runTreeHelper,
  signalOwnedGroup,
} from "./process-tree.js";

export class SingleProcessStdio implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  private child: ChildProcessWithoutNullStreams | undefined;
  private closing: Promise<void> | undefined;
  private buffer = Buffer.alloc(0);
  private exited: Promise<void> = Promise.resolve();
  private ownershipFile: string | undefined;
  private ownershipRoot: string | undefined;
  private ownRoot = false;
  private groupId: number | undefined;
  private starting: Promise<void> | undefined;
  private closeRequested = false;
  private readonly ownerTag = randomUUID();
  constructor(
    private readonly config: {
      command: string;
      args: string[];
      cwd?: string;
      env: Record<string, string>;
      maxBytes: number;
      ownershipDirectory?: string;
      /** 宿主资源准备 barrier；不属于可由 MCP/模型提交的配置。 */
      beforeSpawn?: () => Promise<void>;
      verifyGroup?: typeof verifyOwnedGroup;
    },
  ) {}
  get pid() {
    return this.child?.pid ?? null;
  }
  // SDK 以公开的 stdio 特征选择原连接探测；此 transport 不暴露可克隆的启动私有字段。
  get stderr() {
    return this.child?.stderr ?? null;
  }
  start(): Promise<void> {
    if (this.child || this.closing || this.closeRequested || this.starting)
      throw new McpError("mcp-stdio-already-started");
    return (this.starting = this.startOwned().finally(() => {
      this.starting = undefined;
    }));
  }
  private async startOwned() {
    this.ownershipRoot =
      this.config.ownershipDirectory ??
      (await mkdtemp(join(tmpdir(), "kaguya-mcp-owned-")));
    this.ownRoot = this.config.ownershipDirectory === undefined;
    await mkdir(this.ownershipRoot, { recursive: true, mode: 0o700 });
    this.ownershipFile = join(this.ownershipRoot, `${randomUUID()}.json`);
    await this.config.beforeSpawn?.();
    if (this.closeRequested) throw new McpError("mcp-stdio-start-interrupted");
    const child = spawn(this.config.command, this.config.args, {
      env: { ...this.config.env, KAGUYA_MCP_OWNER: this.ownerTag },
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.groupId = child.pid;
    this.exited = new Promise((resolve) => child.once("exit", () => resolve()));
    child.once("close", () => this.onclose?.());
    child.on("error", () => this.onerror?.(new McpError("mcp-stdio-failed")));
    child.stdin.on("error", () =>
      this.onerror?.(new McpError("mcp-stdio-write-failed")),
    );
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let boundary: number;
      while ((boundary = this.buffer.indexOf(10)) >= 0) {
        const line = this.buffer.subarray(0, boundary);
        this.buffer = this.buffer.subarray(boundary + 1);
        if (line.byteLength > this.config.maxBytes) {
          this.fail();
          return;
        }
        try {
          this.onmessage?.(
            parseJSONRPCMessage(JSON.parse(line.toString("utf8"))),
          );
        } catch {
          this.fail();
          return;
        }
      }
      if (this.buffer.byteLength > this.config.maxBytes) this.fail();
    });
    try {
      await once(child, "spawn");
      await writeSensitiveJson(this.ownershipFile, {
        ownerPid: process.pid,
        pid: child.pid,
        processGroup: process.platform === "win32" ? null : child.pid,
        platform: process.platform,
        startedAt: new Date().toISOString(),
        state: "owned",
        ownerTag: this.ownerTag,
      });
    } catch {
      throw new McpError("mcp-stdio-start-failed");
    }
  }
  private fail() {
    this.onerror?.(new McpError("mcp-stdio-invalid-frame"));
    void this.close().catch(() => undefined);
  }
  async send(message: JSONRPCMessage) {
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > this.config.maxBytes)
      throw new McpError("mcp-request-budget");
    const child = this.child;
    if (
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      child.stdin.destroyed
    )
      throw new McpError("mcp-stdio-unavailable");
    await new Promise<void>((resolve, reject) =>
      child.stdin.write(line, (error) =>
        error ? reject(new McpError("mcp-stdio-write-failed")) : resolve(),
      ),
    );
  }
  close() {
    this.closeRequested = true;
    return (this.closing ??= (async () => {
      const deadline = Date.now() + 5000;
      await this.starting?.catch(() => undefined);
      const child = this.child;
      if (!child) {
        if (this.ownRoot && this.ownershipRoot)
          await rm(this.ownershipRoot, { recursive: true, force: true });
        return;
      }
      const wait = async (milliseconds: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            this.exited.then(() => true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), milliseconds);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      try {
        if (process.platform === "win32") {
          // Windows 没有 POSIX 进程组；仅在根进程尚在时用系统 taskkill 回收正常派生树。
          if (
            child.pid &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            await runTreeHelper(
              join(
                process.env.SystemRoot ??
                  process.env.SYSTEMROOT ??
                  "C:\\Windows",
                "System32",
                "taskkill.exe",
              ),
              ["/PID", String(child.pid), "/T", "/F"],
              deadline,
            );
            if (!(await wait(Math.max(1, deadline - Date.now()))))
              throw new McpError("mcp-stdio-reap-failed");
          } else if (child.pid)
            throw new McpError("mcp-stdio-tree-unconfirmed");
        } else {
          child.stdin.end();
          await wait(250);
          const alive = () => {
            if (!this.groupId) return false;
            try {
              process.kill(-this.groupId, 0);
              return true;
            } catch (error) {
              if (
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "ESRCH"
              )
                return false;
              throw error;
            }
          };
          const signal = async (value: NodeJS.Signals) => {
            if (alive()) {
              await signalOwnedGroup(
                this.groupId!,
                this.ownerTag,
                value,
                deadline,
                this.config.verifyGroup ?? verifyOwnedGroup,
              );
            }
          };
          const drain = async (milliseconds: number) => {
            const until = Math.min(deadline, Date.now() + milliseconds);
            while (alive() && Date.now() < until)
              await new Promise((resolve) => setTimeout(resolve, 20));
            return !alive();
          };
          await signal("SIGTERM");
          if (!(await drain(1000))) {
            await signal("SIGKILL");
            if (!(await drain(2000)))
              throw new McpError("mcp-stdio-tree-unconfirmed");
          }
          if (
            child.pid &&
            child.exitCode === null &&
            child.signalCode === null &&
            !(await wait(2000))
          )
            throw new McpError("mcp-stdio-reap-failed");
        }
        if (this.ownershipFile) await rm(this.ownershipFile, { force: true });
        if (this.ownRoot && this.ownershipRoot)
          await rm(this.ownershipRoot, { recursive: true, force: true });
      } finally {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        this.buffer = Buffer.alloc(0);
      }
    })().catch((error) => {
      this.closing = undefined;
      throw error;
    }));
  }
}
