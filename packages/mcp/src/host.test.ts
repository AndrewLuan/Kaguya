/**
 * 功能概述：以独立进程的真实 stdio/回环 HTTP 服务验证三个协议 profile 和 W3 适配边界。
 * fixture 在 setup 前登记清理；等待 journal 中的真实请求/副作用信号，失败时也释放 hold 并回收进程。
 * 控制通道以 held/released 与应用 ACK 同步；控制 ACK 失败也独立等待原工作收敛并汇总错误。
 * 覆盖分页、权限、凭据、单进程探测、取消晚到、断连与 schema 更换；严格断言没有隐式重发。
 * 所有凭据与正文均为合成数据，不运行模型或生产服务；完整文件进入 critical 门禁。
 */
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { afterEach, describe, it, expect } from "vitest";
import type { ActionExecution } from "@kaguya/sdk";
import { McpHost, type McpPromptSelection } from "./host.js";
import {
  mcpConfigurationSchema,
  loadMcpConfiguration,
  type McpConnectionConfig,
} from "./config.js";
import {
  signalOwnedGroup,
  verifyOwnedGroup,
  runTreeHelper,
} from "./process-tree.js";
import type { McpEnvelope } from "./connection.js";
import { SingleProcessStdio } from "./stdio.js";
import {
  applySyntheticControl,
  syntheticServerSource,
} from "./synthetic-fixture.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((clean) => clean()),
  );
  const rejected = results.filter((result) => result.status === "rejected");
  if (rejected.length) throw new AggregateError(rejected, "MCP cleanup failed");
}, 20000); // 控制ACK2s、stdio树回收5s及已知worker退出8s，另留文件清理余量。
const wait = { timeout: 8000, interval: 20 };
/** 保守累加串行阶段；并行于 RPC 的观察也单列，不以某阶段未用完预算补给其他阶段。 */
function fixtureBudget({
  connections,
  calls = 0,
  polls = 0,
  controls = 0,
  closes = 0,
  timeoutMs = 16000,
}: {
  connections: number;
  calls?: number;
  polls?: number;
  controls?: number;
  closes?: number;
  timeoutMs?: number;
}) {
  // ready8s + 每次连接独立的握手/分页发现 + RPC + 每次观察8s + ACK2s + close5s + 文件I/O5s。
  return (
    8000 +
    connections * 2 * timeoutMs +
    calls * timeoutMs +
    polls * 8000 +
    controls * 2000 +
    closes * 5000 +
    5000
  );
}
async function fixture(
  mode: "stdio" | "http",
  protocol = "2025-11-25",
  flags: Record<string, unknown> = {},
  recorder?: (envelope: McpEnvelope, id: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "kaguya-mcp-"));
  const script = join(root, "server.mjs"),
    statePath = join(root, "state.json"),
    journal = join(root, "journal.jsonl");
  let state = { protocol, ...flags };
  let child: ChildProcess | undefined;
  let host: McpHost | undefined;
  let confirmedUncertainClose = false;
  const lateResults: { envelope: McpEnvelope; id: string }[] = [];
  const update = async (
    next: Record<string, unknown>,
    options: { allowStopped?: boolean } = {},
  ) => {
    state = { ...state, ...next };
    await writeFile(statePath, JSON.stringify(state));
    return applySyntheticControl(journal, state, options);
  };
  cleanups.push(async () => {
    const failures: unknown[] = [];
    try {
      await update(
        { release: true, dropControlAck: false },
        { allowStopped: true },
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      if (!confirmedUncertainClose) await host?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    } catch (error) {
      failures.push(error);
    }
    // 在任何测试断言前已登记：即使根进程先退出，也从本 fixture journal 回收已知 worker。
    try {
      const rows = (await readFile(journal, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      for (const row of rows.filter((row) => row.kind === "worker")) {
        try {
          process.kill(row.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await expect
          .poll(() => {
            try {
              process.kill(row.pid, 0);
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH")
                return true;
              throw error;
            }
          }, wait)
          .toBe(true);
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      if (!failures.length) await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(failures, "synthetic fixture cleanup failed");
  });
  await writeFile(script, syntheticServerSource);
  await writeFile(journal, "");
  await writeFile(statePath, JSON.stringify(state));
  let url = "";
  if (mode === "http") {
    child = spawn(process.execPath, [script, mode, statePath, journal], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.resume();
    const lines = createInterface({ input: child.stdout! });
    const ready = Promise.race([
      once(lines, "line", { signal: AbortSignal.timeout(8000) }),
      once(child, "exit").then(() => {
        throw new Error("synthetic HTTP exited before readiness");
      }),
    ]);
    const [line] = await ready;
    url = `http://127.0.0.1:${JSON.parse(String(line)).port}/mcp`;
    lines.close();
  }
  const configuration = mcpConfigurationSchema.parse({
    version: 1,
    connections: [
      {
        id: "test",
        revision: "one",
        enabled: true,
        protocol,
        transport:
          mode === "stdio"
            ? {
                type: "stdio",
                command: process.execPath,
                args: [script, mode, statePath, journal],
                envRefs: { SYNTHETIC_SECRET: "SYNTHETIC_SECRET" },
              }
            : {
                type: "http",
                url,
                headerRefs: { Authorization: "SYNTHETIC_AUTH" },
              },
        scopes: ["scope"],
        tools: [{ name: "echo" }, { name: "increment" }],
        resourceUriPrefixes: ["fixture://allowed/"],
        prompts: ["summarize"],
        timeoutMs: 3000,
      },
    ],
  });
  const open = async (overrides: Partial<McpConnectionConfig> = {}) =>
    (host = await McpHost.open(
      {
        ...configuration,
        connections: [{ ...configuration.connections[0]!, ...overrides }],
      },
      (reference) =>
        reference === "SYNTHETIC_AUTH"
          ? "Bearer synthetic-token"
          : "synthetic-secret",
      {
        ownershipDirectory: join(root, "owned"),
        recordLateResult: async (envelope, id) => {
          lateResults.push({ envelope, id });
          await recorder?.(envelope, id);
        },
      },
    ));
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
    open,
    logs,
    lateResults,
    update,
    root,
    configuration,
    acknowledgeUnconfirmedClose() {
      confirmedUncertainClose = true;
    },
    get host() {
      return host!;
    },
  };
}
function execution(host: McpHost, index = 0): ActionExecution {
  const tool = host.snapshot().nativeTools.registrations[index]!;
  return {
    intentId: "intent",
    attemptId: "attempt",
    operationId: "operation",
    digest: "digest",
    signal: new AbortController().signal,
    intent: {
      operationId: "operation",
      runInformationId: "run",
      decisionInformationId: "decision",
      scope: "scope",
      sceneId: "scene",
      authorizationId: "authorization",
      authorizationVersion: 1,
      domain: "tool",
      providerId: tool.providerId,
      providerVersion: tool.providerVersion,
      executor: tool.executor,
      toolName: tool.id,
      toolCallId: "model-original-call",
      target: {},
      arguments: { value: 1 },
      dependencies: {
        observationId: "observation",
        memoryRevisions: [],
        sourceInformationIds: [],
      },
      dependsOn: [],
      deadline: new Date(Date.now() + 30000).toISOString(),
    },
  } as ActionExecution;
}
async function invoke(host: McpHost, input = execution(host)) {
  const tool = host
    .snapshot()
    .nativeTools.registrations.find(
      (tool) => tool.id === input.intent.toolName,
    )!;
  input.intent.target = (
    await tool.bind({
      arguments: input.intent.arguments,
      runInformationId: "run",
      stepInformationId: "step",
      scope: input.intent.scope,
    })
  ).target;
  return host.snapshot().actionProviders[0]!.execute(input);
}
/** 断言、release 和原工作分别收敛；保留主错和控制/清理错误，避免前者跳过后者。 */
async function withSyntheticRelease(
  inspect: () => Promise<void>,
  release: () => Promise<unknown>,
  observed: Promise<PromiseSettledResult<unknown>[]>,
) {
  const failures: unknown[] = [];
  try {
    await inspect();
  } catch (error) {
    failures.push(error);
  }
  try {
    await release();
  } catch (error) {
    failures.push(error);
  }
  for (const result of await observed)
    if (result.status === "rejected") failures.push(result.reason);
  if (failures.length)
    throw new AggregateError(failures, "held assertion or cleanup failed");
}
describe.each(["2025-06-18", "2025-11-25", "2026-07-28"])(
  "MCP %s",
  (protocol) => {
    it.each(["stdio", "http"] as const)(
      "executes actual %s tools/resources/prompts with one process and frozen policy",
      async (mode) => {
        const f = await fixture(mode, protocol);
        const host = await f.open();
        expect(host.snapshot().nativeTools.registrations).toHaveLength(2);
        expect(
          host
            .snapshot()
            .nativeTools.registrations.every(
              (tool) => !tool.readonly && !tool.independent,
            ),
        ).toBe(true);
        expect(
          (await f.logs()).filter((row) => row.kind === "start"),
        ).toHaveLength(1);
        expect(
          (await f.logs()).filter(
            (row) => row.kind === "request" && row.method === "tools/list",
          ),
        ).toHaveLength(2);
        expect(
          (await f.logs()).some(
            (row) =>
              row.method === "resources/list" ||
              row.method === "prompts/list" ||
              row.method === "subscriptions/listen",
          ),
        ).toBe(false);
        const result = await invoke(host);
        expect(result).toMatchObject({
          status: "succeeded",
          evidence: "returned",
          result: {
            source: { scope: "scope", protocol, trust: "untrusted-mcp-data" },
            requests: [
              {
                method: "tools/call",
                modelToolCallId: "model-original-call",
                operationId: "operation",
                attemptId: "attempt",
              },
            ],
          },
        });
        expect(await host.listResources("test", "scope")).toMatchObject({
          value: [{ uri: "fixture://allowed/item" }],
        });
        expect(await host.listResourceTemplates("test", "scope")).toMatchObject(
          { value: [{ uriTemplate: "fixture://allowed/{id}" }] },
        );
        expect(
          await host.readResource("test", "scope", "fixture://allowed/item"),
        ).toMatchObject({ value: { contents: [{ mimeType: "text/plain" }] } });
        await host.listPrompts("test", "scope");
        await expect(host.getPrompt({} as McpPromptSelection)).rejects.toThrow(
          "mcp-user-selection-required",
        );
        const selection = host.selectPrompt({
          connectionId: "test",
          scope: "scope",
          name: "summarize",
          arguments: { topic: "synthetic" },
        });
        expect(await host.getPrompt(selection)).toMatchObject({
          value: { prompt: { messages: [{ role: "user" }] } },
        });
        await expect(host.getPrompt(selection)).rejects.toThrow(
          "mcp-user-selection-required",
        );
        const pid = host.status()[0]!.pid;
        await host.close();
        if (pid) expect(() => process.kill(pid, 0)).toThrow();
        expect(
          (await f.logs()).filter((row) => row.kind === "effect"),
        ).toHaveLength(1);
        expect(
          (await f.logs()).filter(
            (row) => row.kind === "http" && row.method === "GET",
          ),
        ).toHaveLength(0);
      },
    );
  },
);
it.each(["stdio", "http"] as const)(
  "rejects version mismatch on %s without a second process or fallback",
  async (mode) => {
    const f = await fixture(mode, "2025-06-18");
    await expect(f.open({ protocol: "2026-07-28" })).rejects.toThrow();
    expect((await f.logs()).filter((row) => row.kind === "start")).toHaveLength(
      1,
    );
    expect((await f.logs()).some((row) => row.method === "initialize")).toBe(
      false,
    );
  },
);
it("rejects endless pagination and atomically publishes no partial directory", async () => {
  const f = await fixture("http", "2026-07-28", { loopPages: true });
  await expect(f.open()).rejects.toThrow();
  expect(
    (await f.logs()).filter(
      (row) => row.kind === "request" && row.method === "tools/list",
    ),
  ).toHaveLength(2);
});
it.each([{ maxPages: 1 }, { maxItems: 1 }, { maxBytes: 256 }])(
  "enforces directory budget %j",
  async (limits) => {
    const f = await fixture("http");
    await expect(f.open(limits)).rejects.toThrow();
    expect((await f.logs()).some((row) => row.kind === "effect")).toBe(false);
  },
);
it("rejects failed authentication without reauthorization", async () => {
  const f = await fixture("http", "2026-07-28", { auth: true });
  const config = f.configuration.connections[0]!;
  await expect(
    f.open({
      transport: {
        ...config.transport,
        type: "http",
        url: (config.transport as { url: string }).url,
        headerRefs: {},
      },
    }),
  ).rejects.toThrow();
  expect((await f.logs()).filter((row) => row.kind === "http")).toHaveLength(1);
});
it.each(["headerMismatch", "inputRequired", "drop"])(
  "does not repeat an effect after %s",
  async (flag) => {
    const f = await fixture("http", "2026-07-28", { [flag]: true });
    const host = await f.open();
    expect(await invoke(host)).toMatchObject({
      status: "unknown",
      evidence: "unconfirmed",
    });
    await host.reconnect("test");
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
    expect(
      (await f.logs()).filter(
        (row) => row.kind === "request" && row.method === "tools/list",
      ),
    ).toHaveLength(4);
  },
  fixtureBudget({ connections: 2, calls: 1, timeoutMs: 3000 }),
);
it(
  "keeps an old definition frozen after reconnect publishes a changed schema",
  async () => {
    const f = await fixture("http");
    const host = await f.open();
    const frozen = host.snapshot();
    await f.update({ schemaType: "string" });
    await host.reconnect("test");
    expect(frozen.nativeTools.registrations[0]!.version).not.toBe(
      host.status()[0]!.tools[0]!.revision,
    );
    expect(await invoke(host)).toMatchObject({
      status: "rejected",
      evidence: "not-executed",
    });
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(0);
  },
  fixtureBudget({ connections: 2, calls: 1, controls: 1, timeoutMs: 3000 }),
);
it.each(["stdio", "http"] as const)(
  "keeps cancellation and late %s results unconfirmed with exactly one effect",
  async (mode) => {
    const f = await fixture(mode, "2026-07-28", { hold: true });
    const host = await f.open({ timeoutMs: 16000 });
    const input = execution(host);
    const work = invoke(host, input);
    await expect
      .poll(
        async () =>
          (await f.logs()).filter((row) => row.kind === "effect").length,
        wait,
      )
      .toBe(1);
    await host.snapshot().actionProviders[0]!.cancel!(input);
    expect(await work).toMatchObject({ status: "unknown" });
    await f.update({ release: true });
    await expect
      .poll(
        async () =>
          (await f.logs()).filter((row) => row.kind === "returned").length,
        wait,
      )
      .toBe(1);
    expect(
      (await f.logs()).filter(
        (row) => row.kind === "request" && row.method === "tools/call",
      ),
    ).toHaveLength(1);
    if (mode === "stdio") {
      await expect.poll(() => f.lateResults.length, wait).toBe(1);
      expect(f.lateResults[0]!.envelope).toMatchObject({
        source: {
          scope: "scope",
          definitionRevision: input.intent.target.definitionRevision,
        },
        requests: [
          {
            intentId: "intent",
            attemptId: "attempt",
            operationId: "operation",
            modelToolCallId: "model-original-call",
          },
        ],
      });
      expect(JSON.stringify(f.lateResults)).not.toContain("synthetic-secret");
    }
    await host.reconnect("test");
    expect(f.lateResults).toHaveLength(mode === "stdio" ? 1 : 0);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
  },
  fixtureBudget({ connections: 2, calls: 1, polls: 3, controls: 1 }),
);
it("does not restart an exited stdio process while reading its unconfirmed outcome", async () => {
  const f = await fixture("stdio", "2025-06-18", { exit: true });
  const host = await f.open();
  expect(await invoke(host)).toMatchObject({ status: "unknown" });
  expect((await f.logs()).filter((row) => row.kind === "start")).toHaveLength(
    1,
  );
  expect((await f.logs()).filter((row) => row.kind === "effect")).toHaveLength(
    1,
  );
  if (process.platform === "win32") {
    await expect(host.close()).rejects.toThrow("mcp-cleanup-failed");
    f.acknowledgeUnconfirmedClose();
  }
});
it(
  "redacts referenced credentials from content and denies other scopes/resources",
  async () => {
    const f = await fixture("stdio", "2025-11-25", { echoSecret: true });
    const host = await f.open();
    expect(JSON.stringify(await invoke(host))).not.toContain(
      "synthetic-secret",
    );
    await expect(
      host.readResource("test", "scope", "fixture://denied/item"),
    ).rejects.toThrow("mcp-resource-denied");
    await expect(host.listResources("test", "other")).rejects.toThrow(
      "mcp-scope-denied",
    );
    await f.update({ escapeResource: true });
    await expect(
      host.readResource("test", "scope", "fixture://allowed/item"),
    ).rejects.toThrow("mcp-resource-result-denied");
  },
  fixtureBudget({ connections: 1, calls: 2, controls: 1, timeoutMs: 3000 }),
);
it("reports capabilities explicitly and defaults missing config to disabled", async () => {
  const f = await fixture("http", "2026-07-28", { unsupported: true });
  expect(await loadMcpConfiguration(f.root)).toEqual({
    version: 1,
    connections: [],
  });
  const host = await f.open();
  expect(host.snapshot().nativeTools.registrations).toHaveLength(0);
  await expect(host.listPrompts("test", "scope")).rejects.toThrow(
    "mcp-capability-unsupported",
  );
});

it(
  "invalidates an arrived stdio directory notification without refreshing or executing",
  async () => {
    const f = await fixture("stdio");
    const host = await f.open();
    const snapshot = host.snapshot();
    const input = execution(host);
    input.intent.target = (
      await snapshot.nativeTools.registrations[0]!.bind({
        arguments: input.intent.arguments,
        scope: "scope",
        runInformationId: "run",
        stepInformationId: "step",
      })
    ).target;
    await f.update({ notify: true });
    await expect.poll(() => host.status()[0]!.tools.length, wait).toBe(0);
    expect(
      await snapshot.nativeTools.registrations[0]!.authorize({
        intent: input.intent,
        mode: "execute",
      }),
    ).toBe(false);
    expect(await snapshot.actionProviders[0]!.execute(input)).toMatchObject({
      status: "rejected",
      evidence: "not-executed",
    });
    expect(
      (await f.logs()).filter(
        (row) => row.kind === "request" && row.method === "tools/list",
      ),
    ).toHaveLength(2);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(0);
  },
  fixtureBudget({ connections: 1, polls: 1, controls: 1, timeoutMs: 3000 }),
);
it(
  "does not admit an old provider during delayed reconnect discovery",
  async () => {
    const f = await fixture("http");
    const host = await f.open({ timeoutMs: 16000 });
    const snapshot = host.snapshot();
    const input = execution(host);
    input.intent.target = (
      await snapshot.nativeTools.registrations[0]!.bind({
        arguments: input.intent.arguments,
        scope: "scope",
        runInformationId: "run",
        stepInformationId: "step",
      })
    ).target;
    await f.update({ holdList: true });
    const reconnect = host.reconnect("test");
    const observed = Promise.allSettled([reconnect]);
    let held: { method: string; rpcId: string | number } | undefined;
    await withSyntheticRelease(
      async () => {
        await expect
          .poll(
            async () =>
              (await f.logs()).filter(
                (row) => row.kind === "held" && row.method === "tools/list",
              ).length,
            wait,
          )
          .toBe(1);
        held = (await f.logs()).find(
          (row) => row.kind === "held" && row.method === "tools/list",
        );
        expect(await snapshot.actionProviders[0]!.execute(input)).toMatchObject(
          {
            status: "rejected",
            evidence: "not-executed",
          },
        );
      },
      async () => {
        const ack = await f.update({ release: true });
        expect(ack.released).toContainEqual({
          method: held?.method,
          rpcId: held?.rpcId,
        });
      },
      observed,
    );
    expect(
      (await f.logs()).filter(
        (row) => row.kind === "released" && row.method === "tools/list",
      ),
    ).toHaveLength(1);
    expect(
      (await f.logs()).filter(
        (row) => row.kind === "request" && row.method === "tools/list",
      ),
    ).toHaveLength(4);
    expect(host.status()[0]!.tools).toHaveLength(2);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(0);
  },
  fixtureBudget({ connections: 2, polls: 1, controls: 2 }),
);
it.each(["2025-11-25", "2026-07-28"])(
  "aborts actual hanging HTTP I/O at the %s operation deadline",
  async (protocol) => {
    const f = await fixture("http", protocol, { hold: true });
    const host = await f.open({ timeoutMs: 500 });
    const result = await invoke(host);
    expect(result).toMatchObject({ status: "unknown" });
    await expect
      .poll(
        async () =>
          (await f.logs()).filter(
            (row) =>
              row.kind === "network-close" && row.method === "tools/call",
          ).length,
        wait,
      )
      .toBe(1);
    await f.update({ release: true });
    await expect
      .poll(
        async () =>
          (await f.logs()).filter((row) => row.kind === "returned").length,
        wait,
      )
      .toBe(1);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
  },
  fixtureBudget({
    connections: 1,
    calls: 1,
    polls: 2,
    controls: 1,
    timeoutMs: 500,
  }),
);

it("reaps the ordinary stdio descendant process group on unload", async () => {
  const f = await fixture("stdio", "2025-11-25", { worker: true });
  const host = await f.open();
  expect(await invoke(host)).toMatchObject({ status: "succeeded" });
  const worker = (await f.logs()).find((row) => row.kind === "worker").pid;
  await host.close();
  await expect
    .poll(() => {
      try {
        process.kill(worker, 0);
        return false;
      } catch {
        return true;
      }
    }, wait)
    .toBe(true);
  expect(await readdir(join(f.root, "owned"))).toHaveLength(0);
});
it.each(["2025-11-25", "2026-07-28"])(
  "accepts actual %s HTTP SSE responses without a listen stream",
  async (protocol) => {
    const f = await fixture("http", protocol, { sse: true });
    const host = await f.open();
    expect(await invoke(host)).toMatchObject({ status: "succeeded" });
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
    expect(
      (await f.logs()).some(
        (row) => row.kind === "http" && row.method === "GET",
      ),
    ).toBe(false);
  },
);
it("releases earlier connections when a later stdio server cannot start", async () => {
  const f = await fixture("stdio");
  const config = f.configuration.connections[0]!;
  await expect(
    McpHost.open(
      {
        version: 1,
        connections: [
          config,
          {
            ...config,
            id: "bad",
            transport: {
              type: "stdio",
              command: join(f.root, "missing"),
              args: [],
              envRefs: {},
            },
          },
        ],
      },
      () => "synthetic-secret",
      { ownershipDirectory: join(f.root, "owned") },
    ),
  ).rejects.toThrow();
  const pid = (await f.logs()).find((row) => row.kind === "start").pid;
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await readdir(join(f.root, "owned"))).toHaveLength(0);
});

it("settles a close that arrives during stdio ownership setup before any spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaguya-mcp-start-race-"));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const transport = new SingleProcessStdio({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    env: {},
    maxBytes: 1024,
    ownershipDirectory: root,
    beforeSpawn: async () => {
      entered();
      await gate;
    },
  });
  const opening = transport.start();
  const settled = Promise.allSettled([opening]);
  let closing: Promise<void> | undefined;
  try {
    await Promise.race([
      started,
      opening.then(() => {
        throw new Error("stdio start missed its barrier");
      }),
      new Promise<never>((_resolve, reject) =>
        AbortSignal.timeout(8000).addEventListener(
          "abort",
          () => reject(new Error("stdio setup barrier timed out")),
          { once: true },
        ),
      ),
    ]);
    closing = transport.close();
    expect(transport.pid).toBeNull();
    release();
    await closing;
    expect((await settled)[0]).toMatchObject({ status: "rejected" });
    expect(transport.pid).toBeNull();
    expect(await readdir(root)).toHaveLength(0);
  } finally {
    release();
    await Promise.allSettled([opening, closing, transport.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
it("locates and handles descendants after the stdio root exits", async () => {
  const f = await fixture("stdio", "2025-06-18", { worker: true, exit: true });
  const host = await f.open();
  expect(await invoke(host)).toMatchObject({ status: "unknown" });
  const worker = (await f.logs()).find((row) => row.kind === "worker").pid;
  if (process.platform === "win32") {
    await expect(host.close()).rejects.toThrow("mcp-cleanup-failed");
    expect(await readdir(join(f.root, "owned"))).toHaveLength(1);
    f.acknowledgeUnconfirmedClose();
  } else {
    await host.close();
    expect(() => process.kill(worker, 0)).toThrow();
    expect(await readdir(join(f.root, "owned"))).toHaveLength(0);
  }
});

it("refuses a wrong owner tag for an actual controlled process and preserves its record", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaguya-mcp-identity-"));
  let allow = false;
  const transport = new SingleProcessStdio({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    env: {},
    maxBytes: 1024,
    ownershipDirectory: root,
    verifyGroup: (group, tag, deadline) =>
      verifyOwnedGroup(group, allow ? tag : "wrong-owner", deadline),
  });
  let controlledPid: number | null = null;
  let exited = false;
  transport.onclose = () => {
    exited = true;
  };
  try {
    await transport.start();
    controlledPid = transport.pid;
    const pid = transport.pid!;
    if (process.platform === "win32") {
      // Windows 的生产分支使用 taskkill；这里验证真实进程配合拒绝 guard 绝不发送 POSIX 信号。
      await expect(
        signalOwnedGroup(
          pid,
          "wrong-owner",
          "SIGTERM",
          Date.now() + 1000,
          async () => false,
        ),
      ).rejects.toThrow("identity-unconfirmed");
    } else {
      await expect(transport.close()).rejects.toThrow("identity-unconfirmed");
    }
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(await readdir(root)).toHaveLength(1);
    allow = true;
    await transport.close();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readdir(root)).toHaveLength(0);
  } finally {
    allow = true;
    const failures: unknown[] = [];
    try {
      await transport.close();
    } catch (error) {
      failures.push(error);
    }
    // 独立兜底只针对本实例实际创建的根进程；不以再次调用被测 close 成功作为清理前提。
    const pid = controlledPid ?? transport.pid;
    try {
      if (pid && !exited) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (pid)
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH")
                return true;
              throw error;
            }
          }, wait)
          .toBe(true);
    } catch (error) {
      failures.push(error);
    }
    try {
      if (!failures.length) await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        `controlled stdio cleanup failed; diagnostics retained at ${root}`,
      );
  }
});
it("bounds and reaps a non-exiting Windows tree helper using a real child", async () => {
  let pid: number | undefined;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const work = runTreeHelper(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    Date.now() + 1000,
    (value) => {
      pid = value;
      entered();
    },
  );
  const settled = Promise.allSettled([work]);
  try {
    await Promise.race([ready, work]);
    await expect(work).rejects.toThrow("mcp-tree-helper-unconfirmed");
    expect(pid).toBeDefined();
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    await settled;
    if (pid)
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ESRCH"
        ))
          throw error;
      }
  }
});

it(
  "keeps late RPC identities local to each connection generation and ignores unknown IDs",
  async () => {
    const f = await fixture("stdio", "2026-07-28", {
      hold: true,
      echoSecret: true,
    });
    const host = await f.open({ timeoutMs: 16000 });
    for (let index = 0; index < 2; index++) {
      const input = execution(host);
      input.attemptId = `attempt-${index}`;
      input.intentId = `intent-${index}`;
      input.operationId = input.intent.operationId = `operation-${index}`;
      const work = invoke(host, input);
      await expect
        .poll(
          async () =>
            (await f.logs()).filter((row) => row.kind === "effect").length,
          wait,
        )
        .toBe(index + 1);
      await host.snapshot().actionProviders[0]!.cancel!(input);
      expect(await work).toMatchObject({ status: "unknown" });
      await f.update({ release: true, unknownReply: true });
      await expect.poll(() => f.lateResults.length, wait).toBe(index + 1);
      expect(f.lateResults[index]!.envelope.requests[0]).toMatchObject({
        intentId: input.intentId,
        attemptId: input.attemptId,
        operationId: input.operationId,
      });
      expect(JSON.stringify(f.lateResults[index])).not.toContain(
        "synthetic-secret",
      );
      if (index === 0) {
        await f.update({ release: false, unknownReply: false });
        await host.reconnect("test");
      }
    }
    const [first, second] = f.lateResults.map((item) => item.envelope);
    expect(first!.requests[0]!.rpcId).toBe(second!.requests[0]!.rpcId);
    expect(first!.source.transportGeneration).not.toBe(
      second!.source.transportGeneration,
    );
    await host.close();
    expect(f.lateResults).toHaveLength(2);
  },
  fixtureBudget({ connections: 2, calls: 2, polls: 4, controls: 3, closes: 1 }),
);
it(
  "retains a failed late-result observation with the same ID until close can persist it",
  async () => {
    let failing = true;
    const attempts: string[] = [];
    const f = await fixture(
      "stdio",
      "2026-07-28",
      { hold: true },
      async (_envelope, id) => {
        attempts.push(id);
        if (failing) throw new Error("synthetic evidence persistence failure");
      },
    );
    const host = await f.open({ timeoutMs: 16000 });
    const input = execution(host),
      work = invoke(host, input);
    await expect
      .poll(
        async () =>
          (await f.logs()).filter((row) => row.kind === "effect").length,
        wait,
      )
      .toBe(1);
    await host.snapshot().actionProviders[0]!.cancel!(input);
    expect(await work).toMatchObject({ status: "unknown" });
    await f.update({ release: true });
    await expect.poll(() => attempts.length, wait).toBe(1);
    await expect(host.close()).rejects.toThrow("mcp-cleanup-failed");
    failing = false;
    await host.close();
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts).size).toBe(1);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(1);
  },
  fixtureBudget({ connections: 1, calls: 1, polls: 2, controls: 1, closes: 2 }),
);

it.each(["stdio", "http"] as const)(
  "releases a held %s RPC by ACK even when the state file publication is incomplete and no watch event is used",
  async (mode) => {
    const f = await fixture(mode, "2026-07-28", { hold: true });
    const host = await f.open({ timeoutMs: 16000 });
    const work = invoke(host);
    const observed = Promise.allSettled([work]);
    await withSyntheticRelease(
      async () => {
        await expect
          .poll(
            async () =>
              (await f.logs()).filter(
                (row) => row.kind === "held" && row.method === "tools/call",
              ).length,
            wait,
          )
          .toBe(1);
        // 确定性复现旧控制回调遇到半份 JSON 的输入；IPC 应不再依赖该文件或文件系统通知。
        await writeFile(join(f.root, "state.json"), "{");
        const ack = await applySyntheticControl(join(f.root, "journal.jsonl"), {
          protocol: "2026-07-28",
          hold: true,
          release: true,
        });
        const held = (await f.logs()).find(
          (row) => row.kind === "held" && row.method === "tools/call",
        );
        expect(ack.released).toEqual([
          { method: "tools/call", rpcId: held.rpcId },
        ]);
        expect(await work).toMatchObject({ status: "succeeded" });
        expect(
          (await f.logs()).filter((row) => row.kind === "released"),
        ).toHaveLength(1);
        expect(
          (await f.logs()).filter((row) => row.kind === "effect"),
        ).toHaveLength(1);
      },
      () => f.update({ release: true }),
      observed,
    );
  },
  fixtureBudget({ connections: 1, calls: 1, polls: 1, controls: 2 }),
);
it(
  "settles actual held discovery and preserves both errors when an inspection fails and its applied release ACK is lost",
  async () => {
    const f = await fixture("http");
    const host = await f.open({ timeoutMs: 16000 });
    await f.update({ holdList: true });
    const reconnect = host.reconnect("test");
    const observed = Promise.allSettled([reconnect]);
    let error: AggregateError | undefined;
    try {
      await withSyntheticRelease(
        async () => {
          await expect
            .poll(
              async () =>
                (await f.logs()).filter(
                  (row) => row.kind === "held" && row.method === "tools/list",
                ).length,
              wait,
            )
            .toBe(1);
          throw new Error("synthetic inspection failure");
        },
        () => f.update({ release: true, dropControlAck: true }),
        observed,
      );
    } catch (caught) {
      error = caught as AggregateError;
    }
    expect(error).toBeInstanceOf(AggregateError);
    expect(error!.errors.map((item) => item.message)).toEqual([
      "synthetic inspection failure",
      "synthetic-control-closed-before-ack",
    ]);
    expect(await observed).toEqual([{ status: "fulfilled", value: undefined }]);
    expect(host.status()[0]!.tools).toHaveLength(2);
    expect(
      (await f.logs()).filter((row) => row.kind === "effect"),
    ).toHaveLength(0);
    await f.update({ release: true, dropControlAck: false });
  },
  fixtureBudget({ connections: 2, polls: 1, controls: 3 }),
);
