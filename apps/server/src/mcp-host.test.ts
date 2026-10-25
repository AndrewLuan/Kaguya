/**
 * 功能概述：验证真实 Server 装配、Web→Heavy→W3→MCP→后继模型回复及管理端显式资源/prompt。
 * 只替换模型 HTTP 和数据库连接工厂；MCP 为真实独立 stdio/回环 HTTP 合成服务。
 * 使用临时配置、真实 PGlite 或显式 PostgreSQL schema；等待持久回执及队列收敛，精确核对副作用。
 * Router 首轮排程与 provider 开始使用独立的 8 秒阶段，避免把上游排程耗时算入副作用等待。
 * 管理 GUI 测试仅替换 broker RPC，保留真实 Host/W3/SDK 原图链路；不产生外部模型请求。
 * 正式链路按 MCP 回执、匹配 run 的模型/assistant 持久化、Web 交付与队列收敛分阶段等待。
 * fixture 在 setup 失败和 shutdown 异常时也尝试释放所有资源；记录子进程 PID，验证关闭后不残留。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import {
  KaguyaRuntime,
  LinuxToolsHost,
  LinuxEnvironmentClient,
  nativeToolWireName,
} from "@kaguya/runtime";
import { KaguyaDatabase } from "@kaguya/database";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "@kaguya/database/testing";
import {
  FileUserConfigManager,
  loadModuleInstanceConfigs,
  writeSensitiveJson,
} from "@kaguya/config";
import { createFirstPartyModuleConfigDefaults } from "@kaguya/modules";
import { syntheticServerSource } from "@kaguya/mcp/testing";
import type { ActionExecution } from "@kaguya/sdk";
import { createMcpLateResultRecorder } from "./mcp-host.js";
import { McpHost, mcpLateResultInformationKind } from "@kaguya/mcp";
import { startKaguyaServer, type StartedKaguyaServer } from "./server.js";
import {
  createPersistenceWait,
  expectPersistenceSettled,
} from "./test-support/persistence.js";

const models = vi.hoisted(() => ({ heavy: 0, gui: 0, requests: [] as any[] }));
vi.mock("@ai-sdk/openai-compatible", async (original) => {
  const actual = await original<typeof import("@ai-sdk/openai-compatible")>();
  return {
    ...actual,
    createOpenAICompatible: (options: any) =>
      actual.createOpenAICompatible({
        ...options,
        fetch: async (_url: unknown, init: RequestInit) => {
          const body = JSON.parse(String(init.body));
          models.requests.push(body);
          const heavy = body.model === "heavy";
          if (heavy) models.heavy++;
          const gui = body.model === "vision";
          if (gui) models.gui++;
          const tools =
            ((heavy && models.heavy === 1) || (gui && models.gui === 1)) &&
            body.tools?.length;
          const message = tools
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: gui ? "gui-model-original" : "mcp-model-original",
                    type: "function",
                    function: {
                      name: gui
                        ? nativeToolWireName("gui.observe", "1")
                        : body.tools[0].function.name,
                      arguments: gui
                        ? '{"target":{"kind":"desktop"}}'
                        : '{"value":7}',
                    },
                  },
                ],
              }
            : {
                role: "assistant",
                content: JSON.stringify(
                  heavy
                    ? { action: "message", text: "MCP completed" }
                    : { action: "message", reason: "respond" },
                ),
              };
          return new Response(
            JSON.stringify({
              id: "synthetic-model",
              object: "chat.completion",
              created: 1,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message,
                  finish_reason: tools ? "tool_calls" : "stop",
                },
              ],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      }),
  };
});
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const errors = [];
  for (const cleanup of cleanups.splice(0).reverse())
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  vi.restoreAllMocks();
  models.heavy = 0;
  models.gui = 0;
  models.requests = [];
  if (errors.length)
    throw new AggregateError(errors, "Server MCP cleanup failed");
}, 20000);
async function fixture(
  mode: "stdio" | "http",
  flags: Record<string, unknown> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "kaguya-server-mcp-"));
  let server: StartedKaguyaServer | undefined;
  let db: KaguyaDatabase | undefined;
  let child: ChildProcess | undefined;
  let databaseClosed = false;
  cleanups.push(async () => {
    try {
      await server?.close();
    } finally {
      try {
        if (!databaseClosed) await db?.close();
      } finally {
        if (
          child?.pid &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  const script = join(root, "synthetic.mjs"),
    state = join(root, "state.json"),
    journal = join(root, "journal.jsonl");
  await writeFile(script, syntheticServerSource);
  await writeFile(state, JSON.stringify({ protocol: "2025-11-25", ...flags }));
  await writeFile(journal, "");
  let url = "";
  if (mode === "http") {
    child = spawn(process.execPath, [script, mode, state, journal], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.resume();
    const lines = createInterface({ input: child.stdout! });
    const [line] = await once(lines, "line", {
      signal: AbortSignal.timeout(8000),
    });
    lines.close();
    url = `http://127.0.0.1:${JSON.parse(String(line)).port}/mcp`;
  }
  const manager = await FileUserConfigManager.bootstrap({ rootDir: root });
  await loadModuleInstanceConfigs({
    rootDir: root,
    defaults: createFirstPartyModuleConfigDefaults(),
  });
  await manager.replaceProfile(manager.getSelectedProfileId(), {
    name: "default",
    acknowledgedWarnings: [],
    identity: { timeZone: "Asia/Shanghai" },
    runtime: {
      host: "127.0.0.1",
      port: 3000,
      databaseMode: "external",
      databaseUrl: "postgresql://synthetic@127.0.0.1/synthetic",
      webDistPath: join(root, "web"),
      corsOrigins: [],
      trustProxy: false,
      rateLimitMax: 10000,
      rateLimitWindowMs: 60000,
      logLevel: "silent",
      logFormat: "json",
      inboundAllowlist: [],
      outboundAllowlist: [],
    },
    ai: {
      defaultProviderId: "synthetic",
      modelTiers: {
        light: { providerId: "synthetic", modelId: "light" },
        heavy: { providerId: "synthetic", modelId: "heavy" },
      },
      providers: [
        {
          id: "synthetic",
          type: "openai-compatible",
          enabled: true,
          baseUrl: "https://synthetic.invalid/v1",
          apiKey: "synthetic",
          models: ["light", "heavy", "vision"],
          settings: {},
        },
      ],
    },
  });
  await manager.acknowledgeConfigurationWarnings(
    manager.getSelectedProfileId(),
    [],
  );
  const scope = JSON.stringify([
    "web",
    "web.ui.main",
    "web",
    "47d34f33-c005-45e1-bae4-06df09bd9dc1",
  ]);
  await writeSensitiveJson(join(root, "mcp.json"), {
    version: 1,
    connections: [
      {
        id: "synthetic",
        revision: "one",
        enabled: true,
        protocol: "2025-11-25",
        transport:
          mode === "stdio"
            ? {
                type: "stdio",
                command: process.execPath,
                args: [script, mode, state, journal],
              }
            : { type: "http", url },
        scopes: [scope],
        tools: [{ name: "echo" }],
        resourceUriPrefixes: ["fixture://allowed/"],
        prompts: ["summarize"],
      },
    ],
  });
  await mkdir(join(root, "web"));
  await writeFile(join(root, "web", "index.html"), "<main>synthetic</main>");
  const pg = process.env.KAGUYA_TEST_DATABASE_URL;
  db = pg
    ? await createPostgresTestingDatabase(pg)
    : await createTestingDatabase();
  const closeDatabase = db.close.bind(db);
  vi.spyOn(db, "close").mockImplementation(async () => {
    if (!databaseClosed) {
      await closeDatabase();
      databaseClosed = true;
    }
  });
  vi.spyOn(KaguyaDatabase, "connect").mockResolvedValue(db);
  const start = async () =>
    (server = await startKaguyaServer({
      host: "127.0.0.1",
      port: 0,
      gatewayToken: "synthetic-gateway",
      corsOrigins: [],
      trustProxy: false,
      rateLimitMax: 10000,
      rateLimitWindowMs: 60000,
      databaseUrl: "postgresql://synthetic@127.0.0.1/synthetic",
      configRoot: root,
      development: false,
      webDistPath: join(root, "web"),
      logLevel: "silent",
      logFormat: "json",
      inboundAllowlist: [],
      outboundAllowlist: [],
      napcat: {
        enabled: false,
        adapterId: "napcat.qq.main",
        reconnectMs: 3000,
      },
    }));
  const logs = async () => {
    const text = await readFile(journal, "utf8");
    return text.trim()
      ? text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  };
  return {
    manager,
    update: (next: Record<string, unknown>) =>
      writeFile(
        state,
        JSON.stringify({ protocol: "2025-11-25", ...flags, ...next }),
      ),
    start,
    db,
    logs,
    root,
    scope,
    get server() {
      return server!;
    },
    clearServer() {
      server = undefined;
    },
  };
}
it.each(["stdio", "http"] as const)(
  "runs production Server/Heavy/W3 through actual MCP %s and preserves the original call identity",
  async (mode) => {
    const f = await fixture(mode);
    const server = await f.start();
    expect(server.runtime).toBeDefined();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/v1/messages",
      headers: {
        authorization: "Bearer synthetic-gateway",
        "x-request-id": "mcp-request",
      },
      payload: {
        text: "Run synthetic tool",
        conversationId: "47d34f33-c005-45e1-bae4-06df09bd9dc1",
      },
    });
    expect(response.statusCode).toBe(202);
    const wait = createPersistenceWait(f.db, () => ({ heavy: models.heavy }));
    let runInformationId: unknown;
    let assistantInformationId: string;
    await wait("Router scheduled Heavy", async () => {
      expect(
        await f.db.information.find({
          kinds: ["agent.router.message.intent.requested"],
          limit: 10,
        }),
      ).toHaveLength(1);
    });
    await wait(
      "MCP receipt persisted and follow-up Heavy started",
      async () => {
        const receipts = await f.db.information.find({
          kinds: ["agent.heavy.tool.result.v1"],
          limit: 10,
        });
        expect(receipts).toHaveLength(1);
        runInformationId = receipts[0]!.payload.runInformationId;
        expect(receipts[0]!.payload.toolCallId).toBe("mcp-model-original");
        expect(receipts[0]!.payload.value).toMatchObject({
          status: "succeeded",
          evidence: "returned",
          result: {
            source: { scope: f.scope, trust: "untrusted-mcp-data" },
            requests: [
              { method: "tools/call", modelToolCallId: "mcp-model-original" },
            ],
          },
        });
        expect(models.heavy).toBe(2);
      },
    );
    // 三个顺序阶段各继承既有 8 秒预算；模型请求启动、最终持久化和出站交付是不同边界。
    await wait(
      "matching native final, model completion and assistant persisted",
      async () => {
        const terminals = (
          await f.db.information.find({
            kinds: ["agent.heavy.tool.terminal.v1"],
            limit: 10,
          })
        ).filter((atom) => atom.payload.runInformationId === runInformationId);
        expect(terminals).toHaveLength(1);
        expect(terminals[0]!.payload.reason).toBe("final");
        const finalResult = terminals[0]!.payload.modelResult as any;
        const completed = await f.db.information.get(
          finalResult.terminalInformationId,
        );
        expect(completed?.kind).toBe("core.model.task.completed");
        const assistants = await f.db.information.find({
          kinds: ["core.message.assistant.text"],
          limit: 10,
        });
        expect(assistants).toHaveLength(1);
        expect(assistants[0]!.payload.text).toBe("MCP completed");
        expect(assistants[0]!.references).toContainEqual({
          relation: "core:caused-by",
          informationId: completed!.informationId,
        });
        assistantInformationId = assistants[0]!.informationId;
      },
    );
    await wait(
      "Heavy reply durably delivered and persistence settled",
      async () => {
        const deliveries = await f.db.information.find({
          kinds: ["core.delivery.delivered"],
          limit: 10,
        });
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]!.payload.ok).toBe(true);
        const requestId = deliveries[0]!.references.find(
          (reference) => reference.relation === "core:status-of",
        )!.informationId;
        const request = await f.db.information.get(requestId);
        expect(request?.kind).toBe("core.delivery.requested");
        expect(request!.references).toContainEqual({
          relation: "core:caused-by",
          informationId: assistantInformationId,
        });
        await expectPersistenceSettled(f.db);
      },
    );
    // 队列收敛后只读一次正式 HTTP 历史，避免把持久化轮询变成受限流的重复请求。
    const history = await server.app.inject({
      method: "GET",
      url: "/api/v1/messages?conversationId=47d34f33-c005-45e1-bae4-06df09bd9dc1",
      headers: { authorization: "Bearer synthetic-gateway" },
    });
    expect(history.statusCode).toBe(200);
    expect(
      history
        .json()
        .data.messages.filter((message: any) => message.role === "assistant"),
    ).toEqual([
      expect.objectContaining({ role: "assistant", text: "MCP completed" }),
    ]);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
    const read = await server.app.inject({
      method: "POST",
      url: "/api/mcp/read",
      headers: { authorization: "Bearer synthetic-gateway" },
      payload: {
        kind: "resource",
        connectionId: "synthetic",
        scope: f.scope,
        uri: "fixture://allowed/item",
      },
    });
    expect(read.statusCode).toBe(200);
    const denied = await server.app.inject({
      method: "POST",
      url: "/api/mcp/read",
      payload: {
        kind: "prompt",
        connectionId: "synthetic",
        scope: f.scope,
        name: "summarize",
        arguments: { topic: "synthetic" },
      },
    });
    expect(denied.statusCode).toBe(401);
    expect(
      (await f.logs()).filter((row) => row.method === "prompts/get"),
    ).toHaveLength(0);
    const prompt = await server.app.inject({
      method: "POST",
      url: "/api/mcp/read",
      headers: { authorization: "Bearer synthetic-gateway" },
      payload: {
        kind: "prompt",
        connectionId: "synthetic",
        scope: f.scope,
        name: "summarize",
        arguments: { topic: "synthetic" },
      },
    });
    expect(prompt.statusCode).toBe(200);
    const action = (
      await f.db.sql.query<{ intent_id: string; scope: string }>(
        "SELECT intent_id FROM information_action_heads LIMIT 1",
      )
    ).rows[0]!;
    const saved = await f.db.actions.read(action.intent_id, f.scope);
    expect(saved.state).toBe("succeeded");
    expect(
      models.requests
        .filter((request) => request.model === "heavy")[1]
        .messages.some(
          (message: any) =>
            message.role === "tool" &&
            message.tool_call_id === "mcp-model-original",
        ),
    ).toBe(true);
    const pid = (await f.logs()).find((row) => row.kind === "start").pid;
    await server.close();
    f.clearServer();
    if (mode === "stdio") expect(() => process.kill(pid, 0)).toThrow();
  },
  40000, // 四段各 8 秒；其余预算用于真实 Server/DB 初始化、MCP 管理读取与清理。
);
it("keeps same-scope chat on Heavy and runs an idempotent management GUI task with original image continuation", async () => {
  const f = await fixture("stdio");
  const config = {
    version: 1 as const,
    revision: "gui-test",
    bindings: [
      {
        scope: f.scope,
        environmentId: "desktop",
        workflowId: "gui-flow",
        gui: true,
        guiModel: {
          routeId: "gui.explicit",
          providerId: "synthetic",
          modelId: "vision",
        },
      },
    ],
  };
  await writeSensitiveJson(join(f.root, "linux-tools.json"), config);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  const hash = createHash("sha256").update(png).digest("hex");
  let artifact: any,
    executions = 0;
  const control = (state = "ready") => ({
    environmentId: "desktop",
    scope: f.scope,
    generation: 1,
    state,
  });
  const environment = () => ({
    environmentId: "desktop",
    generation: 1,
    workspaceId: "workspace",
    workflowId: "gui-flow",
    resourceIds: [],
    leaseId: "lease",
    fencing: "1",
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });
  // 只替换 broker RPC；Host 目录/绑定、W3、持久原图装配和最终 SDK wire 均走生产实现。
  const linux = new LinuxToolsHost(
    config,
    new LinuxEnvironmentClient(async (method, params) => {
      if (method === "environment.inspect") return control();
      if (method === "lease.acquire")
        return {
          environment: environment(),
          token: "synthetic-private-lease-secret-123456",
        };
      if (method === "lease.renew") return environment();
      if (method === "lease.validate") return { valid: true };
      if (method === "lease.release") return control("quarantined");
      if (method === "artifact.read")
        return { artifact, dataBase64: png.toString("base64") };
      if (method === "operation.execute") {
        executions++;
        expect(params.toolName).toBe("gui.observe");
        artifact = {
          id: "gui-original",
          hash,
          mime: "image/png",
          size: png.length,
          scope: f.scope,
          actionId: params.intentId,
          generation: 1,
          observedAt: "2026-10-25T00:00:00.000Z",
          source: "environment-helper",
          retention: "explicit-delete-only",
        };
        return {
          status: "succeeded",
          evidence: "returned",
          artifacts: [artifact],
          truncated: false,
          result: {
            observation: {
              id: "a".repeat(64),
              environmentId: "desktop",
              workflowId: "gui-flow",
              generation: 1,
            },
            image: {
              captureId: "original",
              coordinateFrame: "desktop",
              width: 1,
              height: 1,
              originalWidth: 1,
              originalHeight: 1,
              scale: 1,
              origin: { x: 0, y: 0 },
              target: { kind: "desktop" },
              sha256: hash,
              mime: "image/png",
              capturedAt: "2026-10-25T00:00:00.000Z",
              serviceInstanceId: "service",
              driverInstanceId: "driver",
            },
          },
        };
      }
      throw new Error("unexpected synthetic broker method " + method);
    }),
  );
  cleanups.push(() => linux.close());
  const snapshot = LinuxToolsHost.prototype.snapshot;
  vi.spyOn(LinuxToolsHost.prototype, "snapshot").mockImplementation(() =>
    snapshot.call(linux),
  );
  const server = await f.start();
  const headers = { authorization: "Bearer synthetic-gateway" };
  expect(
    (
      await server.app.inject({
        method: "POST",
        url: "/api/v1/messages",
        headers,
        payload: {
          text: "ordinary chat",
          conversationId: "47d34f33-c005-45e1-bae4-06df09bd9dc1",
        },
      })
    ).statusCode,
  ).toBe(202);
  const wait = createPersistenceWait(f.db, () => ({
    heavy: models.heavy,
    gui: models.gui,
    executions,
  }));
  await wait("Router scheduled same-scope Heavy", async () => {
    expect(
      await f.db.information.find({
        kinds: ["agent.router.message.intent.requested"],
        limit: 10,
      }),
    ).toHaveLength(1);
  });
  await wait("same-scope ordinary chat delivered", async () => {
    expect(
      await f.db.information.find({
        kinds: ["core.delivery.delivered"],
        limit: 10,
      }),
    ).toHaveLength(1);
  });
  const chatRequests = models.requests.filter((r) => r.model === "heavy");
  expect(chatRequests).toHaveLength(2);
  expect(models.gui).toBe(0);
  expect(
    chatRequests.every((r) =>
      r.tools.every(
        (t: any) =>
          !["gui.observe", "gui.act", "gui.verify"].some(
            (id) => nativeToolWireName(id, "1") === t.function.name,
          ),
      ),
    ),
  ).toBe(true);
  const url = "/api/v1/environments/desktop/tasks",
    input = { taskRequestId: randomUUID(), prompt: "inspect the desktop" };
  expect(
    (await server.app.inject({ method: "POST", url, payload: input }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await server.app.inject({
        method: "POST",
        url,
        headers,
        payload: { ...input, nativeStep: {} },
      })
    ).statusCode,
  ).toBe(400);
  const accepted = await server.app.inject({
    method: "POST",
    url,
    headers,
    payload: input,
  });
  expect(accepted.statusCode).toBe(202);
  expect(accepted.headers["cache-control"]).toBe("no-store");
  expect(
    (
      await server.app.inject({ method: "POST", url, headers, payload: input })
    ).json().requestedInformationId,
  ).toBe(accepted.json().requestedInformationId);
  expect(
    (
      await server.app.inject({
        method: "POST",
        url,
        headers,
        payload: { ...input, prompt: "different" },
      })
    ).statusCode,
  ).toBe(409);
  await wait(
    "GUI result and original image continuation persisted",
    async () => {
      const state = await server.app.inject({
        method: "GET",
        url: url + "/" + input.taskRequestId,
        headers,
      });
      expect(state.json().status).toBe("completed");
    },
  );
  expect(executions).toBe(1);
  expect(models.gui).toBe(2);
  expect(models.heavy).toBe(2);
  const vision = models.requests.filter((r) => r.model === "vision");
  expect(JSON.stringify(vision[1].messages)).toContain(
    "data:image/png;base64," + png.toString("base64"),
  );
  expect(
    vision[1].messages.some(
      (m: any) => m.role === "tool" && m.tool_call_id === "gui-model-original",
    ),
  ).toBe(true);
  expect(
    (
      await server.app.inject({ method: "POST", url, headers, payload: input })
    ).json().status,
  ).toBe("completed");
  await wait("management task queue settled", () =>
    expectPersistenceSettled(f.db),
  );
  await server.close();
  f.clearServer();
}, 40000);

it("still closes MCP when the Runtime cleanup reports a failure", async () => {
  const f = await fixture("stdio");
  const server = await f.start();
  const pid = (await f.logs()).find((row) => row.kind === "start").pid;
  const original = server.runtime!.close.bind(server.runtime);
  vi.spyOn(server.runtime!, "close").mockImplementationOnce(async (options) => {
    await original(options);
    throw new Error("synthetic cleanup failure");
  });
  await expect(server.close()).rejects.toThrow();
  expect(() => process.kill(pid, 0)).toThrow();
  f.clearServer();
});
it("retains a failed MCP cleanup owner for a later shutdown attempt", async () => {
  const f = await fixture("stdio");
  const server = await f.start();
  const original = McpHost.prototype.close;
  let attempts = 0;
  const close = vi
    .spyOn(McpHost.prototype, "close")
    .mockImplementation(function (this: McpHost) {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error("synthetic close failure"))
        : original.call(this);
    });
  await expect(server.close()).rejects.toThrow();
  await server.close();
  expect(close).toHaveBeenCalledTimes(2);
  f.clearServer();
});

it("reaps MCP after a partial Runtime startup failure", async () => {
  const f = await fixture("stdio");
  vi.spyOn(KaguyaRuntime.prototype, "start").mockRejectedValueOnce(
    new Error("synthetic start failure"),
  );
  const server = await f.start();
  expect(server.runtime).toBeUndefined();
  const pid = (await f.logs()).find((row) => row.kind === "start").pid;
  expect(() => process.kill(pid, 0)).toThrow();
});
it("keeps a candidate MCP owner when Runtime rebuild and candidate cleanup both fail", async () => {
  const f = await fixture("stdio");
  const server = await f.start();
  const original = McpHost.prototype.close;
  let failed: McpHost | undefined;
  const calls = new Map<McpHost, number>();
  let ordinal = 0;
  vi.spyOn(McpHost.prototype, "close").mockImplementation(function (
    this: McpHost,
  ) {
    const count = (calls.get(this) ?? 0) + 1;
    calls.set(this, count);
    if (count === 1 && ++ordinal === 2) {
      failed = this;
      return Promise.reject(new Error("synthetic candidate cleanup failure"));
    }
    return original.call(this);
  });
  vi.spyOn(KaguyaRuntime.prototype, "start").mockRejectedValueOnce(
    new Error("synthetic rebuild failure"),
  );
  const id = f.manager.getSelectedProfileId();
  const profile = await f.manager.getProfile(id);
  await f.manager.replaceProfile(id, {
    name: profile.name,
    acknowledgedWarnings: [],
    identity: { timeZone: "UTC" },
    ai: profile.ai,
    ...(profile.runtime ? { runtime: profile.runtime } : {}),
  });
  const status = await server.app.inject({
    method: "GET",
    url: "/api/v1/configuration/status",
    headers: { authorization: "Bearer synthetic-gateway" },
  });
  const selected = status.json().data;
  const applied = await server.app.inject({
    method: "POST",
    url: "/api/v1/configuration/apply",
    headers: { authorization: "Bearer synthetic-gateway" },
    payload: {
      selectedProfileId: selected.selectedProfileId,
      revision: selected.selectedRevision,
    },
  });
  expect(applied.json()).toMatchObject({
    data: { status: "failed", errorCode: "shutdown_failed" },
  });
  expect(failed).toBeDefined();
  expect(calls.get(failed!)).toBe(1);
  const pids = (await f.logs())
    .filter((row) => row.kind === "start")
    .map((row) => row.pid);
  expect(pids).toHaveLength(2);
  await server.close();
  f.clearServer();
  expect(calls.get(failed!)).toBe(2);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
}, 40000); // 两轮 Server/stdio 启动、配置排空与失败所有者再次关闭，继承完整链路的 40 秒外层预算。

it.each(["before-unknown", "after-unknown"] as const)(
  "persists a scoped late observation %s without changing the W3 head or repeating the effect",
  async (order) => {
    const f = await fixture("stdio", { hold: true });
    let host!: McpHost;
    const snapshot = McpHost.prototype.snapshot;
    vi.spyOn(McpHost.prototype, "snapshot").mockImplementation(function (
      this: McpHost,
    ) {
      host = this;
      return snapshot.call(this);
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finish = f.db.actions.finish.bind(f.db.actions);
    vi.spyOn(f.db.actions, "finish").mockImplementation(async (...args) => {
      if (order === "before-unknown" && args[2].status === "unknown")
        await gate;
      return finish(...args);
    });
    let commitThenFail = order === "after-unknown";
    let committed: any;
    const append = f.db.information.append.bind(f.db.information);
    vi.spyOn(f.db.information, "append").mockImplementation(
      async (atom, ...rest) => {
        await append(atom, ...rest);
        if (atom.kind === mcpLateResultInformationKind.kind) {
          committed = atom;
          if (commitThenFail) {
            commitThenFail = false;
            throw new Error("synthetic error after committed evidence");
          }
        }
      },
    );
    try {
      const server = await f.start();
      expect(
        (
          await server.app.inject({
            method: "POST",
            url: "/api/v1/messages",
            headers: { authorization: "Bearer synthetic-gateway" },
            payload: {
              text: "Run synthetic held tool",
              conversationId: "47d34f33-c005-45e1-bae4-06df09bd9dc1",
            },
          })
        ).statusCode,
      ).toBe(202);
      const wait = createPersistenceWait(f.db, () => ({ heavy: models.heavy }));
      let action!: Awaited<ReturnType<typeof f.db.actions.read>>;
      await wait("Router scheduled Heavy", async () => {
        expect(
          await f.db.information.find({
            kinds: ["agent.router.message.intent.requested"],
            limit: 10,
          }),
        ).toHaveLength(1);
      });
      await wait("MCP side effect has started", async () => {
        expect(
          (await f.logs()).filter((row) => row.kind === "effect"),
        ).toHaveLength(1);
        const row = (
          await f.db.sql.query<{ intent_id: string }>(
            "SELECT intent_id FROM information_action_heads LIMIT 1",
          )
        ).rows[0]!;
        action = await f.db.actions.read(row.intent_id, f.scope);
        expect(action.state).toBe("started");
      });
      await host.snapshot().actionProviders[0]!.cancel!({
        attemptId: action.attemptId,
      } as ActionExecution);
      if (order === "after-unknown") {
        await wait("transport interruption is durably unknown", async () => {
          expect(
            (await f.db.actions.read(action.intentId, f.scope)).state,
          ).toBe("unknown");
          await expectPersistenceSettled(f.db);
        });
      }
      await f.update({ release: true });
      let observation: any;
      await wait("late result is visible through the scope index", async () => {
        const atoms = await f.db.information.find({
          kinds: [mcpLateResultInformationKind.kind],
          scopeKey: f.scope,
          limit: 10,
        });
        expect(atoms).toHaveLength(1);
        observation = atoms[0]!;
      });
      expect(observation.payload.envelope).toMatchObject({
        source: {
          scope: f.scope,
          connectionId: "synthetic",
          connectionRevision: action.intent.target.connectionRevision,
          definitionRevision: action.intent.target.definitionRevision,
        },
        requests: [
          {
            intentId: action.intentId,
            operationId: action.intent.operationId,
            attemptId: action.attemptId,
            modelToolCallId: "mcp-model-original",
          },
        ],
      });
      expect(observation.references).toContainEqual({
        relation: "core:caused-by",
        informationId: action.intentId,
      });
      if (order === "before-unknown")
        expect((await f.db.actions.read(action.intentId, f.scope)).state).toBe(
          "started",
        );
      release();
      await wait("unknown receipt remains after late evidence", async () => {
        expect((await f.db.actions.read(action.intentId, f.scope)).state).toBe(
          "unknown",
        );
        await expectPersistenceSettled(f.db);
      });
      const originalHead = await f.db.actions.read(action.intentId, f.scope);
      // 模拟 append 已提交但调用方报错：相同事实重试只读取同 ID，不新增事实。
      await createMcpLateResultRecorder(f.db)(
        committed.payload.envelope,
        committed.informationId,
      );
      expect(await f.db.actions.read(action.intentId, f.scope)).toEqual(
        originalHead,
      );
      expect(
        await f.db.information.find({
          kinds: [mcpLateResultInformationKind.kind],
          scopeKey: f.scope,
          limit: 10,
        }),
      ).toHaveLength(1);
      expect(
        (await f.logs()).filter((row) => row.kind === "effect"),
      ).toHaveLength(1);
      await server.close();
      f.clearServer();
    } finally {
      release();
      await f.update({ release: true });
    }
  },
  55000, // Router 前置、MCP 开始、unknown 前置、迟到事实、最终收敛最多五段各 8 秒；另留 15 秒供真实初始化、取消和清理。
);
