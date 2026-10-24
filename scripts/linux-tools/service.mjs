/**
 * 功能概述：可信桌面容器的协议入口，只处理 health 和自动化隔离，不执行任意 shell。
 * 主要职责：ToolService 串行控制 generation/mode；每个 component.isolate 必须停止并
 * 排空自己的输入通道后返回 true，才允许 handoff ACK。startService 提供私有 Unix socket。
 * 代码库关系：宿主 PodmanBackend 先清空独立 shell job，再调用此服务；W8 在 components
 * 注册浏览器/GUI 输入执行者，持久 profile 使用 /private，不能放入共享 /workspace。
 * 输入输出与副作用：控制回执支持同进程幂等重试，handoff 保留页面/桌面进程；隔离失败拒绝 ACK。
 */
import { createServer } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
const canonical = (value) => JSON.stringify(value);
export class ToolService {
  constructor({
    environmentId = process.env.KAGUYA_ENVIRONMENT_ID,
    generation = Number(process.env.KAGUYA_ENVIRONMENT_GENERATION),
    home = process.env.HOME,
    components = [],
  } = {}) {
    if (!environmentId || !Number.isSafeInteger(generation) || generation < 0)
      throw new Error("invalid-identity");
    this.environmentId = environmentId;
    this.generation = generation;
    this.home = home;
    this.components = components;
    this.mode = "automation";
    this.controls = new Map();
    this.pending = Promise.resolve();
    this.closed = false;
  }
  async ready() {}
  async handle(req) {
    if (req.helperProtocolVersion !== 1)
      throw new Error("helper-protocol-mismatch");
    if (req.kind === "health")
      return {
        helperProtocolVersion: 1,
        ready: !this.closed,
        generation: this.generation,
        capabilities: [],
      };
    if (req.kind !== "control") throw new Error("tool-not-supported");
    const result = this.pending.then(() => this.control(req));
    this.pending = result.catch(() => {});
    return result;
  }
  async control(req) {
    const previous = this.controls.get(req.controlOperationId);
    if (previous) {
      if (previous.request !== canonical(req))
        throw new Error("control-conflict");
      return previous.response;
    }
    if (
      this.closed ||
      req.environmentId !== this.environmentId ||
      req.expectedGeneration !== this.generation ||
      typeof req.controlOperationId !== "string" ||
      !req.controlOperationId ||
      !["fence", "handoff"].includes(req.action)
    )
      throw new Error("invalid-control");
    if (
      req.action === "handoff" &&
      (req.generation !== this.generation + 1 ||
        !["human", "automation"].includes(req.mode))
    )
      throw new Error("invalid-control");
    this.mode = "draining";
    for (const component of this.components) {
      if (
        (await component.isolate({
          generation: this.generation,
          mode: req.mode ?? "draining",
        })) !== true
      )
        throw new Error("automation-isolation-unconfirmed");
    }
    if (req.action === "handoff") {
      this.generation = req.generation;
      this.mode = req.mode;
    }
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
    await this.pending;
    this.mode = "draining";
    for (const component of this.components) {
      if (
        (await component.isolate({
          generation: this.generation,
          mode: "draining",
        })) !== true
      )
        throw new Error("automation-isolation-unconfirmed");
    }
    this.closed = true;
  }
}
export async function startService(options = {}) {
  const service = new ToolService(options);
  await service.ready();
  const path = join(service.home, "kaguya-tools.sock");
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
      await unlink(path);
    })());
  process.once("SIGTERM", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
  return { service, close };
}
