/**
 * 功能概述：用真实 Core、ModelTaskClient、W3 及两种数据库验证原生工具循环持久窗口。
 * fixture 固定 observation 与 Memory，上游模型为合成单步生成器；外部效果由受控 provider 计数。
 * 同一用例检查实际 requested、dispatch、call→intent→receipt、下一步 messages 与停止状态。
 * barrier 控制取消/重启窗口；恢复复用持久证据，清理释放所有后台任务后关闭 Core 和数据库。
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  createTestingDatabase,
  createPostgresTestingDatabaseScope,
} from "@kaguya/database/testing";
import { KaguyaDatabase } from "@kaguya/database";
import { InformationCore, InformationKindRegistry } from "@kaguya/engine";
import { createNativeMemoryAccess } from "@kaguya/memory";
import { createStructuredOutputPromptRenderer } from "@kaguya/llm";
import {
  z,
  freezeInformationAtom,
  informationAtomSchema,
  type NativeToolCall,
} from "@kaguya/schema";
import {
  defineInformationKind,
  nativeToolInformationKinds,
  actionDecisionInformationKind,
  type ActionProvider,
  type ActionOutcome,
} from "@kaguya/sdk";
import {
  modelTaskInformationKinds,
  runtimeContextInformationKind,
} from "./information-kinds.js";
import { ModelTaskClient, type ModelTaskRequest } from "./model-task.js";
import {
  NativeToolLoop,
  nativeToolWireName,
  fitToolTranscript,
  type NativeToolRegistration,
} from "./native-tool-loop.js";
import { createNativeMemoryTools } from "./native-memory-tools.js";
import { ActionExecutor } from "./action.js";
const url = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !url)
  throw new Error("PostgreSQL test URL required");
const backends = [false, ...(url ? [true] : [])];
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  const errors = [];
  for (const cleanup of cleanups.splice(0).reverse())
    try {
      await cleanup();
    } catch (e) {
      errors.push(e);
    }
  vi.restoreAllMocks();
  if (errors.length)
    throw new AggregateError(errors, "Native loop cleanup failed");
});
const sourceKind = defineInformationKind({
  kind: "test.native.source",
  displayName: "原生测试来源",
  description: "宿主持久来源",
  payloadSchema: z
    .object({ turn: z.object({ claimInformationId: z.string() }).strict() })
    .strict(),
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: { enabled: false },
});
const outcome: ActionOutcome = {
  status: "succeeded",
  evidence: "effect-verified",
  result: { value: 7 },
  artifacts: [],
  truncated: false,
};
const call = (id: string, tool = "test.tool", input: unknown = {}) =>
  ({
    toolCallId: id,
    toolName: nativeToolWireName(tool, "1"),
    rawInput: JSON.stringify(input),
    input,
    validation: "valid",
  }) as NativeToolCall;
async function fixture(
  postgres: boolean,
  options: { budget?: any; memory?: boolean; noMemory?: boolean } = {},
) {
  const pg = postgres
    ? await createPostgresTestingDatabaseScope(url!)
    : undefined;
  if (pg) cleanups.push(() => pg.close());
  let db = pg ? await pg.connect() : await createTestingDatabase();
  if (!pg) cleanups.push(() => db.close());
  await db.prepareSchema();
  const append = async (
    kind: string,
    payload: any = {},
    refs: string[] = [],
    relation = "core:uses-context",
  ) => {
    await db.information.synchronizeKinds([kind]);
    const id = randomUUID();
    await db.information.append(
      freezeInformationAtom(
        informationAtomSchema.parse({
          informationId: id,
          kind,
          payload,
          source: "test:native",
          occurredAt: new Date().toISOString(),
          references: refs.map((informationId) => ({
            relation,
            informationId,
          })),
        }),
      ),
      [{ relation, required: false, multiple: true }],
    );
    return id;
  };
  const address = {
      platform: "qq",
      adapterId: "native",
      destination: { kind: "group" as const, groupId: "g" },
    },
    scope = JSON.stringify(["qq", "native", "group", "g"]);
  const original = await append("core.message.inbound.text", {
      text: "本轮证据",
      source: { ...address, senderId: "u" },
    }),
    actionRun = await append("agent.router.turn.claimed");
  const memory = await createNativeMemoryAccess({
    enabled: true,
    store: db.memoryGraph.native,
  }).freeze({
    scope,
    owners: [`conversation:${scope}`, "self:kaguya"],
    asOf: new Date().toISOString(),
    query: "本轮",
  });
  const content = {
    background: { evidence: [{ id: original }] },
    ...(options.noMemory ? {} : { memory }),
  };
  const turn = await append("agent.router.turn.context.completed", {
    source: { ...address, senderId: "u" },
    claimInformationId: actionRun,
    observedThroughInformationId: original,
    inputs: [
      {
        informationId: original,
        text: "本轮证据",
        source: { ...address, senderId: "u" },
      },
    ],
  });
  const frozen = await append(
    "agent.situation.frozen",
    { turnInformationId: turn, frame: content },
    [turn],
  );
  const observation = (await db.observations.freezeNext({
    consumerId: "agent.situation",
    policyVersion: "observation.v1",
    address,
    kinds: ["core.message.inbound.text"],
    senderId: "u",
    resultKind: "agent.observation.completed.v1",
    operationKey: "native",
    manifest: {
      version: 1,
      runInformationId: actionRun,
      frozenInformationId: frozen,
      sourceInformationIds: [original],
      knowledgeCutoff: {
        informationId: frozen,
        ...(options.noMemory
          ? {}
          : { memoryPublicationPosition: memory.cutoff!.publicationPosition }),
        memoryRevisions: [],
      },
      content,
    },
  }))!;
  const registry = new InformationKindRegistry();
  registry.registerBuiltin(runtimeContextInformationKind);
  for (const kind of modelTaskInformationKinds) registry.registerBuiltin(kind);
  for (const kind of [
    ...nativeToolInformationKinds,
    actionDecisionInformationKind,
  ])
    registry.register(kind);
  registry.register(sourceKind);
  let core = new InformationCore({
    registry,
    store: db.information,
    nextInformationId: randomUUID,
  });
  cleanups.push(() => core.close());
  await core.start();
  const context = await core.register(runtimeContextInformationKind, {
    payload: {},
    source: "test:native",
    occurredAt: new Date().toISOString(),
    references: [],
  });
  const source = await core.register(sourceKind, {
    payload: { turn: { claimInformationId: actionRun } },
    source: "test:native",
    occurredAt: new Date().toISOString(),
    references: [
      { relation: "core:context", informationId: context.informationId },
    ],
  });
  const request: ModelTaskRequest<string> = {
    task: {
      taskId: "agent.heavy.respond",
      outputMode: "text",
      outputSchema: z.string(),
      allowedTiers: ["heavy"],
    },
    activation: { instanceId: "heavy", definitionId: "agent.heavy" },
    selectionPolicy: { tier: "heavy" },
    sourceInformationId: source.informationId,
    contextInformationId: context.informationId,
    contextAtoms: [source],
    prompt: {
      kind: "message",
      text: "执行授权工具",
      templateId: "test.native",
      templates: [{ name: "main", content: "执行授权工具" }],
      variables: [],
    },
  };
  let effects = 0,
    providerCalls = 0,
    requests: any[] = [];
  let behavior = async () => {
    effects++;
    return outcome;
  };
  let generate = async (_request: any): Promise<NativeToolCall[] | string> =>
    requests.length === 1 ? [call("call-1")] : "完成";
  const provider: ActionProvider = {
    id: "test",
    version: "1",
    capabilities: {
      cancellation: "request-confirm",
      idempotency: "operation",
      reconciliation: false,
      successEvidence: "effect-verified",
      fencing: "none",
    },
    execute: () => {
      providerCalls++;
      return behavior();
    },
    cancel: async () => undefined,
  };
  let environmentValidation: (() => boolean) | undefined;
  const tool: NativeToolRegistration = {
    id: "test.tool",
    version: "1",
    description: "受控测试工具",
    inputSchema: z.object({}).strict(),
    providerId: "test",
    providerVersion: "1",
    executor: "test:host",
    policyVersion: "1",
    readonly: false,
    independent: false,
    bind: async () => ({ target: { resource: "test" } }),
    authorize: async () => true,
  };
  let executor: ActionExecutor;
  const createLoop = () => {
    const memoryTools = options.memory
      ? createNativeMemoryTools(db)
      : undefined;
    executor = new ActionExecutor({
      store: db.actions,
      resolveLeaseCredential: async () => ({ token: "synthetic" }),
      validateEnvironment: async (_i, mode) =>
        mode !== "result" || !environmentValidation || environmentValidation(),
      providers: [provider, ...(memoryTools ? [memoryTools.provider] : [])],
    });
    cleanups.push(() => executor.close());
    const model = new ModelTaskClient({
      core,
      renderStructuredOutputPrompt:
        createStructuredOutputPromptRenderer("{{json_schema}}"),
      resolveModel: () => ({ providerId: "test", modelId: "native" }),
      admitNativeDispatch: (id, step) =>
        db.nativeTools.admitModel(
          step.runInformationId,
          step.stepIndex,
          id,
          core.executionClaim,
        ),
      client: {
        generate: async (r: any) => {
          requests.push(r);
          const output = await generate(r);
          return typeof output === "string"
            ? {
                kind: "final",
                output,
                native: {
                  version: 1,
                  messages: [{ role: "assistant", content: output }],
                  reasoning: [],
                },
                durationMs: 1,
              }
            : {
                kind: "tool-calls",
                output: null,
                calls: output,
                native: {
                  version: 1,
                  messages: [
                    {
                      role: "assistant",
                      content: output.map((c) => ({
                        type: "tool-call",
                        toolCallId: c.toolCallId,
                        toolName: c.toolName,
                        input: c.input,
                      })),
                    },
                  ],
                  reasoning: [],
                },
                durationMs: 1,
              };
        },
      } as any,
    });
    return new NativeToolLoop({
      db,
      core,
      actions: executor,
      model,
      options: {
        registrations: [tool, ...(memoryTools?.registrations ?? [])],
        tasks: [
          {
            taskId: request.task.taskId,
            definitionId: "agent.heavy",
            toolIds: [
              tool.id,
              ...(memoryTools?.registrations.map((t) => t.id) ?? []),
            ],
          },
        ],
        budget: options.budget,
      },
    });
  };
  let loop = createLoop();
  return {
    get db() {
      return db;
    },
    get core() {
      return core;
    },
    get loop() {
      return loop;
    },
    request,
    scope,
    original,
    actionRun,
    observation,
    tool,
    requests,
    effects: () => effects,
    provider,
    providerCalls: () => providerCalls,
    environmentFenced: () => {
      provider.capabilities.fencing = "environment";
      tool.bind = async () => ({
        target: { resource: "test" },
        environment: {
          environmentId: "env",
          generation: 1,
          workspaceId: "workspace",
          resourceIds: [],
          workflowId: "workflow",
          leaseId: "lease",
          fencing: "1",
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        },
      });
      environmentValidation = () => false;
    },
    behavior: (b: typeof behavior) => (behavior = b),
    generate: (g: typeof generate) => (generate = g),
    append,
    alternate: async () => {
      const src = await append("core.message.inbound.text", {
          text: "另一观察",
          source: { ...address, senderId: "v" },
        }),
        run = await append("agent.router.turn.claimed");
      const mem = await createNativeMemoryAccess({
        enabled: true,
        store: db.memoryGraph.native,
      }).freeze({
        scope,
        owners: [`conversation:${scope}`, "self:kaguya"],
        asOf: new Date().toISOString(),
        query: "另一观察",
      });
      const frame = { background: { evidence: [{ id: src }] }, memory: mem };
      const turn = await append("agent.router.turn.context.completed", {
        source: { ...address, senderId: "v" },
        claimInformationId: run,
        observedThroughInformationId: src,
        inputs: [
          {
            informationId: src,
            text: "另一观察",
            source: { ...address, senderId: "v" },
          },
        ],
      });
      const frozen = await append(
        "agent.situation.frozen",
        { turnInformationId: turn, frame },
        [turn],
      );
      const observation = (await db.observations.freezeNext({
        consumerId: "agent.situation",
        policyVersion: "observation.v1",
        address,
        kinds: ["core.message.inbound.text"],
        senderId: "v",
        resultKind: "agent.observation.completed.v1",
        operationKey: "alternate",
        manifest: {
          version: 1,
          runInformationId: run,
          frozenInformationId: frozen,
          sourceInformationIds: [src],
          knowledgeCutoff: {
            informationId: frozen,
            memoryPublicationPosition: mem.cutoff!.publicationPosition,
            memoryRevisions: [],
          },
          content: frame,
        },
      }))!;
      const next = await core.register(sourceKind, {
        payload: { turn: { claimInformationId: run } },
        source: "test:native",
        occurredAt: new Date().toISOString(),
        references: [
          { relation: "core:context", informationId: context.informationId },
        ],
      });
      return {
        observation,
        request: {
          ...request,
          sourceInformationId: next.informationId,
          contextAtoms: [next],
        },
      };
    },
    restart: async () => {
      await executor.close();
      await core.close();
      if (pg) {
        await db.close();
        db = await pg.reconnect();
      } else db = new KaguyaDatabase(db.sql);
      core = new InformationCore({
        registry,
        store: db.information,
        nextInformationId: randomUUID,
      });
      await core.start();
      loop = createLoop();
    },
    withdraw: () =>
      db.memoryGraph.native.publish({
        operationId: "withdraw",
        actor: "manual",
        nodes: [],
        invalidations: [
          { kind: "source-withdrawal", targetId: original, reason: "测试撤回" },
        ],
      }),
  };
}
for (const postgres of backends)
  describe(postgres ? "native PostgreSQL" : "native PGlite", () => {
    it("runs a real model-task → W3 receipt → paired next step and replays without effects", async () => {
      const f = await fixture(postgres);
      const result = await f.loop.execute(f.request);
      expect(result).toMatchObject({ status: "completed", output: "完成" });
      expect(f.effects()).toBe(1);
      expect(f.requests).toHaveLength(2);
      const calls = (
        await f.db.sql.query<any>("SELECT * FROM information_native_tool_calls")
      ).rows;
      expect(calls).toHaveLength(1);
      expect(calls[0].intent_id).toBeTruthy();
      expect(calls[0].result_id).toBeTruthy();
      const pair = (await f.core.get(calls[0].result_id))!.payload;
      const receipt = await f.core.get(String(pair.receiptId));
      const head = (
        await f.db.sql.query<any>(
          "SELECT * FROM information_action_heads WHERE intent_id=$1",
          [calls[0].intent_id],
        )
      ).rows[0];
      expect(receipt!.payload.intentId).toBe(head.intent_id);
      expect(receipt!.payload.attemptId).toBe(head.attempt_id);
      expect(pair.intentId).toBe(head.intent_id);
      expect((receipt!.payload.intent as any).toolCallId).toBe(
        calls[0].call_id,
      );
      const messages = f.requests[1].messages;
      expect(
        messages
          .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
          .find((p: any) => p.type === "tool-result").output.value,
      ).toEqual(pair.value);
      expect(
        messages.flatMap((m: any) =>
          Array.isArray(m.content) ? m.content : [],
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool-result",
            toolCallId: "call-1",
          }),
        ]),
      );
      await f.restart();
      expect(await f.loop.execute(f.request)).toEqual(result);
      expect(f.effects()).toBe(1);
      expect(f.requests).toHaveLength(2);
    });
    it.each(["unknown", "partial"] as const)(
      "stops after %s without another provider/model call",
      async (status) => {
        const f = await fixture(postgres);
        f.behavior(async () => ({
          ...outcome,
          status,
          evidence: status === "unknown" ? "unconfirmed" : "observed",
        }));
        expect((await f.loop.execute(f.request)).status).toBe("failed");
        expect(f.requests).toHaveLength(1);
        expect(f.providerCalls()).toBe(1);
        await f.restart();
        await f.loop.execute(f.request);
        expect(f.requests).toHaveLength(1);
        expect(f.providerCalls()).toBe(1);
      },
    );
    it("pairs invalid and unknown calls without inventing action receipts", async () => {
      const f = await fixture(postgres);
      f.generate(async () =>
        f.requests.length === 1
          ? [
              {
                ...call("bad"),
                rawInput: "{",
                input: null,
                validation: "invalid-input",
              },
              { ...call("missing"), toolName: "unknown" },
            ]
          : "结束",
      );
      expect((await f.loop.execute(f.request)).status).toBe("completed");
      expect(f.effects()).toBe(0);
      const results = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.result.v1'",
        )
      ).rows;
      expect(results).toHaveLength(2);
      expect(
        results.every(
          (r) =>
            r.payload.receiptId === null &&
            r.payload.value.evidence === "not-executed",
        ),
      ).toBe(true);
    });
    it("enforces cumulative call budget before dispatch", async () => {
      const f = await fixture(postgres, { budget: { maxCalls: 1 } });
      f.generate(async () => [call("a"), call("b")]);
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.effects()).toBe(0);
      expect(f.requests).toHaveLength(1);
    });
    it("checks original source withdrawal immediately before W3 admission", async () => {
      const f = await fixture(postgres);
      f.generate(async () => {
        if (f.requests.length === 1) {
          await f.withdraw();
          return [call("withdrawn")];
        }
        return "结束";
      });
      await f.loop.execute(f.request);
      expect(f.effects()).toBe(0);
      const receipts = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='core.action.result.v1'",
        )
      ).rows;
      expect(receipts[0]?.payload.outcome.status).toBe("rejected");
    });
    it.each([false, true])(
      "preserves ordinary receipt dependencies with Memory absent; withdrawal=%s",
      async (withdrawn) => {
        const f = await fixture(postgres, { noMemory: true });
        f.generate(async () => {
          if (f.requests.length === 1) return [call("first")];
          if (f.requests.length === 2) {
            const receipt = (
              await f.db.sql.query<any>(
                "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.result.v1'",
              )
            ).rows[0].payload.receiptId;
            if (withdrawn)
              await f.db.memoryGraph.native.publish({
                operationId: "withdraw-receipt",
                actor: "manual",
                nodes: [],
                invalidations: [
                  {
                    kind: "source-withdrawal",
                    targetId: receipt,
                    reason: "测试撤回回执",
                  },
                ],
              });
            return [call("second")];
          }
          return "结束";
        });
        await f.loop.execute(f.request);
        expect(f.effects()).toBe(withdrawn ? 1 : 2);
      },
    );
    it("recovers an already paired fenced receipt without resuming the model", async () => {
      const f = await fixture(postgres);
      f.environmentFenced();
      await f.restart();
      const stop = vi
        .spyOn(f.db.nativeTools, "stop")
        .mockRejectedValueOnce(new Error("simulated crash before stop"));
      await expect(f.loop.execute(f.request)).rejects.toThrow(
        "simulated crash",
      );
      stop.mockRestore();
      await f.restart();
      await f.loop.execute(f.request);
      expect(f.requests).toHaveLength(1);
      expect(
        (await f.db.sql.query("SELECT * FROM information_native_tool_steps"))
          .rows,
      ).toHaveLength(1);
    });
    it("recovers an actual receipt after projection failure without reexecuting", async () => {
      const f = await fixture(postgres);
      const project = vi
        .spyOn(f.db.nativeTools, "result")
        .mockRejectedValueOnce(new Error("projection failed"));
      await expect(f.loop.execute(f.request)).rejects.toThrow(
        "projection failed",
      );
      expect(f.effects()).toBe(1);
      project.mockRestore();
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("completed");
      expect(f.effects()).toBe(1);
      expect(f.requests).toHaveLength(2);
    });
    it("rejects a changed frozen execution policy before using the old run", async () => {
      const f = await fixture(postgres);
      const project = vi
        .spyOn(f.db.nativeTools, "result")
        .mockRejectedValueOnce(new Error("projection failed"));
      await expect(f.loop.execute(f.request)).rejects.toThrow();
      project.mockRestore();
      f.tool.policyVersion = "2";
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.requests).toHaveLength(1);
      expect(f.effects()).toBe(1);
    });
    it.each(["dispatch", "bind"] as const)(
      "rolls back %s if the real claim expires before the outer transaction returns",
      async (phase) => {
        const f = await fixture(postgres);
        await f.db.information.reliable.configureSubscriptions([
          { subscriptionId: "test.native.claim", kind: sourceKind.kind },
        ]);
        // 配置在 source 之后，因此显式保存一个新的待处理投递，仍由真实 claim 取得 token。
        await f.db.sql.query(
          "INSERT INTO information_deliveries(subscription_id,information_id,state,attempts) VALUES($1,$2,'pending',0) ON CONFLICT DO NOTHING",
          ["test.native.claim", f.request.sourceInformationId],
        );
        const claim = (await f.db.information.reliable.claim(
          "test.native.claim",
          1200,
        ))!;
        expect(claim).toBeTruthy();
        const transact = f.db.sql.transaction.bind(f.db.sql);
        let crossed = false;
        const spy = vi
          .spyOn(f.db.sql, "transaction")
          .mockImplementation(async (run) =>
            transact(async (tx) =>
              run({
                exec: tx.exec.bind(tx),
                query: async <Row extends Record<string, unknown>>(
                  sql: string,
                  params?: readonly unknown[],
                ) => {
                  const result = await tx.query<Row>(sql, params);
                  if (
                    !crossed &&
                    sql.includes(
                      phase === "dispatch"
                        ? "SET steps_count=steps_count+1"
                        : "UPDATE information_native_tool_calls SET intent_id",
                    )
                  ) {
                    crossed = true;
                    await vi.waitFor(
                      async () => {
                        const row = (
                          await tx.query<{ expired: boolean }>(
                            "SELECT lease_until<=clock_timestamp() expired FROM information_deliveries WHERE subscription_id=$1 AND information_id=$2",
                            [claim.subscriptionId, claim.informationId],
                          )
                        ).rows[0];
                        expect(row?.expired).toBe(true);
                      },
                      { timeout: 8000, interval: 20 },
                    );
                  }
                  return result;
                },
              }),
            ),
          );
        const work = f.core.withClaim(claim, new AbortController().signal, () =>
          f.loop.execute(f.request),
        );
        await expect(work).rejects.toThrow();
        spy.mockRestore();
        expect(crossed).toBe(true);
        expect(f.providerCalls()).toBe(0);
        const runs = (
          await f.db.sql.query<any>(
            "SELECT * FROM information_native_tool_runs",
          )
        ).rows;
        expect(runs[0].steps_count).toBe(phase === "dispatch" ? 0 : 1);
        expect(
          (
            await f.db.sql.query(
              "SELECT * FROM information_native_tool_calls WHERE intent_id IS NOT NULL",
            )
          ).rows,
        ).toHaveLength(0);
        if (phase === "dispatch")
          expect(
            (
              await f.db.sql.query(
                "SELECT * FROM information_native_tool_steps WHERE dispatched_id IS NOT NULL",
              )
            ).rows,
          ).toHaveLength(0);
      },
    );
    it("rejects the wire input budget including the registered JSON schema", async () => {
      const f = await fixture(postgres, { budget: { maxContextBytes: 8000 } });
      f.tool.inputSchema = z
        .object({ value: z.string().describe("long-schema".repeat(2000)) })
        .strict();
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.requests).toHaveLength(0);
      expect(f.providerCalls()).toBe(0);
      expect(
        (
          await f.db.sql.query(
            "SELECT * FROM information_native_tool_steps WHERE dispatched_id IS NOT NULL",
          )
        ).rows,
      ).toHaveLength(0);
    });
    it("bounds each request while accepting a ten minute run budget", async () => {
      const f = await fixture(postgres, { budget: { maxDurationMs: 600000 } });
      expect((await f.loop.execute(f.request)).status).toBe("completed");
      expect(f.requests.every((r) => r.timeoutMs <= 300000)).toBe(true);
    });
    it("stops admission and invokes W3 cancellation for a running tool", async () => {
      const f = await fixture(postgres);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let entered = false;
      f.behavior(async () => {
        entered = true;
        await gate;
        return outcome;
      });
      const cancel = vi.spyOn(f.provider, "cancel");
      const work = f.loop.execute(f.request);
      const settled = Promise.allSettled([work]);
      cleanups.push(async () => {
        release();
        await settled;
      });
      await vi.waitFor(() => expect(entered).toBe(true), {
        timeout: 8000,
        interval: 20,
      });
      const row = (
        await f.db.sql.query<any>(
          "SELECT run_id FROM information_native_tool_runs",
        )
      ).rows[0];
      await f.loop.cancel(row.run_id, f.request.sourceInformationId);
      release();
      await work;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(f.providerCalls()).toBe(1);
      expect(f.requests).toHaveLength(1);
      await f.restart();
      await f.loop.execute(f.request);
      expect(f.requests).toHaveLength(1);
      expect(f.providerCalls()).toBe(1);
    });
    it("never repeats an unconfirmed model dispatch after terminal persistence fails", async () => {
      const f = await fixture(postgres);
      const spy = vi
        .spyOn(f.core, "commitTerminal")
        .mockImplementationOnce(async () => {
          throw new Error("model terminal storage failed");
        });
      await expect(f.loop.execute(f.request)).rejects.toThrow();
      spy.mockRestore();
      expect(f.requests).toHaveLength(1);
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.requests).toHaveLength(1);
      expect(f.providerCalls()).toBe(0);
    });
    it("preserves the raw JSON Schema and delegates validation to the host", async () => {
      const f = await fixture(postgres);
      const raw = {
        type: "object",
        properties: { value: { $ref: "#/$defs/value" } },
        required: ["value"],
        additionalProperties: false,
        $defs: { value: { type: "string", pattern: "^approved$" } },
      };
      delete (f.tool as any).inputSchema;
      (f.tool as any).jsonSchema = raw;
      const validate = vi.fn((value: any) => value.value === "approved");
      (f.tool as any).validateInput = validate;
      f.generate(async () =>
        f.requests.length === 1
          ? [call("validated", "test.tool", { value: "approved" })]
          : "完成",
      );
      await f.restart();
      expect((await f.loop.execute(f.request)).status).toBe("completed");
      expect(validate).toHaveBeenCalledOnce();
      expect(f.requests[0].tools[0].inputSchema).toEqual(raw);
      expect(f.providerCalls()).toBe(1);
    });
    it("rejects completed_B as evidence for observation_A while allowing B's own successor", async () => {
      const f = await fixture(postgres);
      await f.loop.execute(f.request);
      const b = await f.alternate();
      f.generate(async () =>
        f.requests.length === 3 ? [call("b-call")] : "B 完成",
      );
      const completed = await f.loop.execute(b.request);
      expect(completed.status).toBe("completed");
      await expect(
        f.db.actions.dependenciesFor(
          f.observation.observationId,
          completed.terminalInformationId,
        ),
      ).rejects.toThrow("action-native-observation-mismatch");
      const dependencies = await f.db.actions.dependenciesFor(
        b.observation.observationId,
        completed.terminalInformationId,
      );
      expect(
        await f.db.memoryGraph.native.checkDependencies(dependencies),
      ).toMatchObject({ valid: true });
    });
    it("rejects replacement of the step-zero Memory snapshot before dispatch", async () => {
      const f = await fixture(postgres);
      const freeze = f.db.nativeTools.freeze.bind(f.db.nativeTools);
      const spy = vi
        .spyOn(f.db.nativeTools, "freeze")
        .mockImplementationOnce((p, guard) =>
          freeze(
            { ...p, memory: { ...p.memory!, owners: ["forged-owner"] } },
            guard,
          ),
        );
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.requests).toHaveLength(0);
      expect(f.providerCalls()).toBe(0);
      expect(
        (await f.db.sql.query("SELECT * FROM information_native_tool_steps"))
          .rows,
      ).toHaveLength(0);
      spy.mockRestore();
    });
    it("keeps exact read/history revisions and permits a corrected successor without rewriting old knowledge", async () => {
      const f = await fixture(postgres, { memory: true });
      let nodeId = "";
      f.generate(async () => {
        switch (f.requests.length) {
          case 1:
            return [call("effect")];
          case 2: {
            const receipt = (
              await f.db.sql.query<any>(
                "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.result.v1'",
              )
            ).rows[0].payload.receiptId;
            return [
              call("record", "memory.record", {
                content: "第一次工具观察",
                receiptIds: [receipt],
              }),
            ];
          }
          case 3:
            nodeId = (
              await f.db.sql.query<any>(
                "SELECT id FROM memory_nodes WHERE metadata->>'kind'='experience'",
              )
            ).rows[0].id;
            return [call("read", "memory.read", { id: nodeId, revision: 1 })];
          case 4:
            return [
              call("correct", "memory.correct", {
                id: nodeId,
                revision: 1,
                content: "修订后的工具观察",
                receiptIds: [],
              }),
            ];
          case 5:
            return [
              call("history", "memory.history", {
                id: nodeId,
                limit: 10,
                cursor: null,
              }),
            ];
          case 6:
            return [call("final-effect")];
          default:
            return "完成";
        }
      });
      const final = await f.loop.execute(f.request);
      expect(final.status).toBe("completed");
      expect(
        f.effects(),
        JSON.stringify(
          (
            await f.db.sql.query(
              "SELECT payload FROM information_atoms WHERE kind='core.action.result.v1'",
            )
          ).rows.map((r: any) => ({
            tool: r.payload.intent.toolName,
            outcome: r.payload.outcome,
          })),
        ),
      ).toBe(2);
      const history = (
        await f.db.sql.query<any>(
          "SELECT a.payload FROM information_native_tool_calls c JOIN information_atoms a ON a.information_id=c.result_id WHERE c.call_id='history'",
        )
      ).rows[0].payload.value.result;
      expect(history.items.map((i: any) => i.node.metadata.revision)).toEqual([
        2, 1,
      ]);
      expect(
        history.memorySnapshots.map(
          (s: any) => s.recalled[0].node.metadata.revision,
        ),
      ).toEqual([2, 1]);
      const read = (
        await f.db.sql.query<any>(
          "SELECT a.payload FROM information_native_tool_calls c JOIN information_atoms a ON a.information_id=c.result_id WHERE c.call_id='read'",
        )
      ).rows[0].payload.value.result;
      expect(read.items[0].node.content).toBe("第一次工具观察");
      expect(
        (
          await f.db.sql.query<any>(
            "SELECT metadata FROM memory_nodes WHERE id=$1",
            [nodeId],
          )
        ).rows[0].metadata.revision,
      ).toBe(2);
    });
    it("preserves the full receipt but stops when its projected output exceeds the budget", async () => {
      const f = await fixture(postgres, {
        budget: { maxToolOutputBytes: 256 },
      });
      f.behavior(async () => ({
        ...outcome,
        result: { text: "x".repeat(2000) },
      }));
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.requests).toHaveLength(1);
      expect(f.providerCalls()).toBe(1);
      const result = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.result.v1'",
        )
      ).rows[0].payload;
      expect(result.value.status).toBe("output-budget");
      const receipt = await f.core.get(result.receiptId);
      expect((receipt!.payload.outcome as any).result.text).toHaveLength(2000);
    });
    it("rejects duplicate native call IDs before any action is registered", async () => {
      const f = await fixture(postgres);
      f.generate(async () => [call("same"), call("same")]);
      expect((await f.loop.execute(f.request)).status).toBe("failed");
      expect(f.providerCalls()).toBe(0);
      expect(
        (await f.db.sql.query("SELECT * FROM information_action_heads")).rows,
      ).toHaveLength(0);
    });
    it("queries Memory through model call and freezes the actual receipt snapshot", async () => {
      const f = await fixture(postgres, { memory: true });
      f.generate(async () =>
        f.requests.length === 1
          ? [call("memory-query", "memory.query", { query: "本轮" })]
          : "完成",
      );
      const result = await f.loop.execute(f.request);
      expect(
        result,
        JSON.stringify(
          (
            await f.db.sql.query(
              "SELECT kind,payload FROM information_atoms WHERE kind LIKE 'core.action.%' OR kind='agent.heavy.tool.terminal.v1'",
            )
          ).rows,
        ),
      ).toMatchObject({ status: "completed" });
      const steps = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.step.frozen.v1' ORDER BY payload->>'stepIndex'",
        )
      ).rows;
      expect(steps).toHaveLength(2);
      expect(steps[1].payload.supplements).toHaveLength(1);
      expect(steps[1].payload.receiptIds).toHaveLength(1);
      expect(JSON.stringify(f.requests[1].messages)).toContain(
        "工具步骤冻结依据",
      );
    });
    it("publishes a selected action receipt and makes its new cutoff available only in the successor", async () => {
      const f = await fixture(postgres, { memory: true });
      let frozenOriginal = "";
      f.generate(async () => {
        if (f.requests.length === 1) {
          frozenOriginal = JSON.stringify(
            (
              await f.db.sql.query<any>(
                "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.step.frozen.v1'",
              )
            ).rows[0].payload,
          );
          return [call("effect")];
        }
        if (f.requests.length === 2) {
          const receipt = (
            await f.db.sql.query<any>(
              "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.result.v1'",
            )
          ).rows[0].payload.receiptId;
          return [
            call("record", "memory.record", {
              content: "工具返回了数值 7",
              receiptIds: [receipt],
            }),
          ];
        }
        return "完成";
      });
      const result = await f.loop.execute(f.request);
      expect(
        result,
        JSON.stringify(
          (
            await f.db.sql.query(
              "SELECT kind,payload FROM information_atoms WHERE kind LIKE 'core.action.%' OR kind='agent.heavy.tool.terminal.v1'",
            )
          ).rows,
        ),
      ).toMatchObject({ status: "completed" });
      expect(f.effects()).toBe(1);
      const proof = await f.db.actions.dependenciesFor(
        f.observation.observationId,
        result.terminalInformationId,
      );
      expect(
        await f.db.memoryGraph.native.checkDependencies(proof),
      ).toMatchObject({ valid: true });
      const nodes = (
        await f.db.sql.query<any>(
          "SELECT metadata,content FROM memory_nodes WHERE metadata->>'kind'='experience'",
        )
      ).rows;
      expect(nodes).toHaveLength(1);
      expect(nodes[0].metadata.ownerId).toBe("self:kaguya");
      expect(
        nodes[0].metadata.proofOwners.some(
          (p: any) => p.ownerId === `conversation:${f.scope}`,
        ),
      ).toBe(true);
      const steps = (
        await f.db.sql.query<any>(
          "SELECT payload FROM information_atoms WHERE kind='agent.heavy.tool.step.frozen.v1' ORDER BY (payload->>'stepIndex')::int",
        )
      ).rows;
      expect(steps).toHaveLength(3);
      expect(JSON.stringify(steps[0].payload)).toBe(frozenOriginal);
      expect(steps[1].payload.memory.cutoff).toEqual(
        steps[0].payload.memory.cutoff,
      );
      expect(
        BigInt(steps[2].payload.memory.cutoff.publicationPosition),
      ).toBeGreaterThan(
        BigInt(steps[0].payload.memory.cutoff.publicationPosition),
      );
      await f.withdraw();
      const snapshot = await createNativeMemoryAccess({
        enabled: true,
        store: f.db.memoryGraph.native,
      }).freeze({
        scope: f.scope,
        owners: ["self:kaguya"],
        asOf: new Date().toISOString(),
        query: "数值",
        explicitIds: [
          nodes[0].metadata.id ??
            (
              await f.db.sql.query<any>(
                "SELECT id FROM memory_nodes WHERE metadata->>'kind'='experience'",
              )
            ).rows[0].id,
        ],
      });
      expect(snapshot.recalled).toHaveLength(0);
    });
  });
it("aliases are stable, collision-separated and provider-safe", () => {
  expect(nativeToolWireName("a.b", "1")).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  expect(nativeToolWireName("a.b", "1")).not.toBe(
    nativeToolWireName("a_b", "1"),
  );
});
it("drops only complete interactions and rejects orphan tool results", () => {
  const pair: any[] = [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "a", toolName: "t", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "a",
          toolName: "t",
          output: { type: "json", value: 1 },
        },
      ],
    },
  ];
  const last: any = { role: "user", content: "new" };
  expect(fitToolTranscript([...pair, last], 50)).toEqual([last]);
  expect(() => fitToolTranscript([pair[1]], 1000)).toThrow(
    "native-orphan-result",
  );
});
