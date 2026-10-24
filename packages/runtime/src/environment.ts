/**
 * 功能概述：连接 Linux rootless 环境 broker，将 W3 行动契约接入实际环境入口。
 * 主要职责：createUnixBrokerTransport 提供有界单次 RPC，无自动重试；LinuxEnvironmentClient
 * 管理公开环境引用与私有凭证，提供 lease 管理、ActionProvider 和 ActionExecutor hooks。
 * 代码库关系：宿主通过 RuntimeOptions.actionProviders/actionEnvironment 注入；W7/W8 的镜像
 * helper 由 Python broker 调用。环境管理只提供宿主 API，不自动注册模型工具。
 * 输入输出与副作用：token 仅留宿主内存及 socket 请求；控制调用用新 lease 核对原 attempt。
 * 传输中断不是取消证明；返回已有成功证据时保留 succeeded，不改写成 cancelled。
 * release 仅在确认响应后移除秘密绑定；响应丢失可用同身份读取 broker 幂等释放回执。
 * 人工会话保留独立秘密绑定；接管重试复用同一凭证，输入回执丢失后只查询原 operation。
 */
import { createConnection } from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "@kaguya/schema";
import {
  actionEnvironmentSchema,
  actionOutcomeSchema,
  type ActionExecution,
  type ActionProvider,
} from "@kaguya/sdk";
import type { ActionExecutorOptions } from "./action.js";
import {
  linuxGuiActSchema,
  linuxGuiObserveSchema,
  linuxGuiVerifySchema,
} from "./linux-gui.js";

export type ActionEnvironment = z.infer<typeof actionEnvironmentSchema>;
export type BrokerTransport = (
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export function createUnixBrokerTransport(
  socketPath = "/run/kaguya-tools/broker.sock",
  timeoutMs = 310_000,
): BrokerTransport {
  return (method, params, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("environment-request-aborted"));
        return;
      }
      const request = JSON.stringify({ protocol: 1, method, params }) + "\n";
      if (Buffer.byteLength(request) > 262144) {
        reject(new Error("environment-request-too-large"));
        return;
      }
      const socket = createConnection({ path: socketPath });
      let settled = false;
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const abort = () => finish(new Error("environment-request-aborted"));
      const timer = setTimeout(
        () => finish(new Error("environment-result-unconfirmed")),
        timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => socket.write(request));
      socket.on("error", () =>
        finish(new Error("environment-transport-failed")),
      );
      socket.on("end", () =>
        finish(new Error("environment-result-unconfirmed")),
      );
      socket.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 24 * 1024 ** 2) {
          finish(new Error("environment-response-too-large"));
          return;
        }
        chunks.push(chunk);
        if (!chunk.includes(10)) return;
        try {
          const raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            ok?: unknown;
            result?: unknown;
          };
          // 不转发远端任意 error 文本，避免 provider/凭证被带入宿主日志。
          if (raw.ok !== true)
            finish(new Error("environment-request-rejected"));
          else finish(undefined, raw.result);
        } catch {
          finish(new Error("environment-invalid-response"));
        }
      });
    });
}

const bindingSchema = z
  .object({
    environment: actionEnvironmentSchema,
    token: z.string().min(32).max(256),
  })
  .strict();

interface Binding {
  scope: string;
  environment: ActionEnvironment;
  token: string;
}

export const environmentControlSchema = z.object({
  environmentId: z.string(),
  scope: z.string(),
  generation: z.number().int().nonnegative(),
  state: z.enum([
    "preparing",
    "ready",
    "human",
    "draining",
    "quarantined",
    "isolation_failed",
  ]),
  human: z
    .object({
      sessionId: z.string().regex(/^[a-f0-9]{64}$/),
      expiresAt: z.iso.datetime(),
    })
    .optional(),
  pendingControl: z
    .object({
      mode: z.enum(["human", "automation"]),
      generation: z.number().int(),
    })
    .optional(),
});
export type EnvironmentControl = z.infer<typeof environmentControlSchema>;
interface HumanBinding {
  environmentId: string;
  scope: string;
  generation: number;
  sessionId: string;
  token: string;
}
const humanReceiptSchema = z.object({
  operationId: z.string(),
  attemptId: z.string(),
  outcome: actionOutcomeSchema,
});
export type HumanReceipt = z.infer<typeof humanReceiptSchema>;
export type HumanOperation = {
  environmentId: string;
  scope: string;
  generation: number;
  sessionId: string;
  operationId: string;
  toolName: "gui.observe" | "gui.act" | "gui.verify";
  arguments: unknown;
};

function sameReference(a: ActionEnvironment, b: ActionEnvironment) {
  return (
    a.environmentId === b.environmentId &&
    a.generation === b.generation &&
    a.workspaceId === b.workspaceId &&
    a.workflowId === b.workflowId &&
    a.leaseId === b.leaseId &&
    a.fencing === b.fencing &&
    JSON.stringify(a.resourceIds) === JSON.stringify(b.resourceIds)
  );
}

export class LinuxEnvironmentClient {
  readonly #bindings = new Map<string, Binding>();
  readonly #humans = new Map<string, HumanBinding>();
  readonly #humanControls = new Map<
    string,
    {
      fingerprint: string;
      session: { id: string; token: string; ttlSeconds: number };
    }
  >();
  readonly #humanOperations = new Map<
    string,
    { fingerprint: string; promise: Promise<HumanReceipt> }
  >();
  readonly #transport: BrokerTransport;

  constructor(transport: BrokerTransport = createUnixBrokerTransport()) {
    this.#transport = transport;
  }

  health() {
    return this.#transport("health", {});
  }

  importImage(archiveSha256: string) {
    return this.#transport("image.import", { sha256: archiveSha256 });
  }

  create(input: {
    environmentId: string;
    scope: string;
    workspaceId: string;
    resourceIds: string[];
    image: string;
    network?: "none" | "public-web";
    sandboxPolicy?: "default" | "chromium-v1";
  }) {
    return this.#transport("environment.create", input);
  }

  async acquire(input: {
    environmentId: string;
    scope: string;
    workflowId: string;
    ttlSeconds?: number;
  }): Promise<ActionEnvironment> {
    const response = bindingSchema.parse(
      await this.#transport("lease.acquire", input),
    );
    this.#bindings.set(input.environmentId, {
      ...response,
      scope: input.scope,
    });
    return structuredClone(response.environment);
  }

  async renew(environmentId: string, scope: string, ttlSeconds = 60) {
    const binding = this.#binding(environmentId, scope);
    const environment = actionEnvironmentSchema.parse(
      await this.#transport("lease.renew", {
        environment: binding.environment,
        token: binding.token,
        scope,
        ttlSeconds,
      }),
    );
    this.#bindings.set(environmentId, { ...binding, environment });
    return structuredClone(environment);
  }

  async release(environmentId: string, scope: string) {
    const binding = this.#binding(environmentId, scope);
    const result = await this.#transport("lease.release", {
      environment: binding.environment,
      token: binding.token,
      scope,
    });
    this.#bindings.delete(environmentId);
    return result;
  }

  async recover(input: {
    environmentId: string;
    scope: string;
    generation: number;
    controlAuthorizationId: string;
  }) {
    try {
      return await this.#transport("environment.recover", input);
    } finally {
      this.#bindings.delete(input.environmentId);
      this.#humans.delete(input.environmentId);
    }
  }

  async handoff(input: {
    environmentId: string;
    scope: string;
    generation: number;
    controlAuthorizationId: string;
  }) {
    try {
      return await this.#transport("environment.handoff", input);
    } finally {
      this.#bindings.delete(input.environmentId);
    }
  }

  async resume(input: {
    environmentId: string;
    scope: string;
    generation: number;
    controlAuthorizationId: string;
  }) {
    this.#bindings.delete(input.environmentId);
    this.#humans.delete(input.environmentId);
    return this.#transport("environment.resume", input);
  }

  async inspect(
    environmentId: string,
    scope: string,
  ): Promise<EnvironmentControl> {
    return environmentControlSchema.parse(
      await this.#transport("environment.inspect", { environmentId, scope }),
    );
  }

  async openHuman(input: {
    environmentId: string;
    scope: string;
    generation: number;
    controlAuthorizationId: string;
    ttlSeconds?: number;
  }): Promise<EnvironmentControl> {
    const ttlSeconds = z
      .number()
      .int()
      .min(1)
      .max(300)
      .parse(input.ttlSeconds ?? 60);
    const fingerprint = JSON.stringify({ ...input, ttlSeconds });
    const key = JSON.stringify([
      input.environmentId,
      input.controlAuthorizationId,
    ]);
    let pending = this.#humanControls.get(key);
    if (pending && pending.fingerprint !== fingerprint)
      throw new Error("human-control-conflict");
    if (!pending) {
      if (this.#humanControls.size >= 1024)
        throw new Error("human-control-capacity");
      pending = {
        fingerprint,
        session: {
          id: randomBytes(32).toString("hex"),
          token: randomBytes(32).toString("hex"),
          ttlSeconds,
        },
      };
      this.#humanControls.set(key, pending);
    }
    this.#bindings.delete(input.environmentId);
    this.#humans.delete(input.environmentId);
    const result = environmentControlSchema.parse(
      await this.#transport("environment.handoff", {
        environmentId: input.environmentId,
        scope: input.scope,
        generation: input.generation,
        controlAuthorizationId: input.controlAuthorizationId,
        humanSession: pending.session,
      }),
    );
    if (
      result.environmentId !== input.environmentId ||
      result.scope !== input.scope ||
      result.generation !== input.generation + 1 ||
      result.state !== "human" ||
      result.human?.sessionId !== pending.session.id
    )
      throw new Error("human-handoff-unconfirmed");
    this.#humans.set(input.environmentId, {
      environmentId: input.environmentId,
      scope: input.scope,
      generation: result.generation,
      sessionId: pending.session.id,
      token: pending.session.token,
    });
    return result;
  }

  #human(input: {
    environmentId: string;
    scope: string;
    generation: number;
    sessionId: string;
  }) {
    const binding = this.#humans.get(input.environmentId);
    if (
      !binding ||
      binding.scope !== input.scope ||
      binding.generation !== input.generation ||
      binding.sessionId !== input.sessionId
    )
      throw new Error("human-session-unavailable");
    return binding;
  }

  async renewHuman(input: {
    environmentId: string;
    scope: string;
    generation: number;
    sessionId: string;
    ttlSeconds?: number;
  }) {
    const binding = this.#human(input);
    return environmentControlSchema.parse(
      await this.#transport("human.renew", {
        ...binding,
        ttlSeconds: z
          .number()
          .int()
          .min(1)
          .max(300)
          .parse(input.ttlSeconds ?? 60),
      }),
    );
  }

  async closeHuman(input: {
    environmentId: string;
    scope: string;
    generation: number;
    sessionId: string;
  }) {
    const binding = this.#human(input);
    const result = environmentControlSchema.parse(
      await this.#transport("human.close", { ...binding }),
    );
    if (
      result.state !== "human" ||
      result.human ||
      result.generation !== binding.generation + 1
    )
      throw new Error("human-close-unconfirmed");
    this.#humans.delete(input.environmentId);
    return result;
  }

  async queryHuman(
    environmentId: string,
    scope: string,
    operationId: string,
  ): Promise<HumanReceipt> {
    const result = humanReceiptSchema.parse(
      await this.#transport("human.query", {
        environmentId,
        scope,
        operationId,
      }),
    );
    if (result.operationId !== operationId)
      throw new Error("human-operation-mismatch");
    return result;
  }

  async closeHumans() {
    const results = await Promise.allSettled(
      [...this.#humans.values()].map((binding) => this.closeHuman(binding)),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("human-cleanup-unconfirmed");
  }

  operateHuman(input: HumanOperation): Promise<HumanReceipt> {
    const binding = this.#human(input);
    const args = (
      input.toolName === "gui.observe"
        ? linuxGuiObserveSchema
        : input.toolName === "gui.act"
          ? linuxGuiActSchema
          : linuxGuiVerifySchema
    ).parse(input.arguments);
    z.string().min(1).max(200).parse(input.operationId);
    const fingerprint = JSON.stringify({ ...input, arguments: args });
    const key = JSON.stringify([input.environmentId, input.operationId]);
    const previous = this.#humanOperations.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new Error("human-operation-conflict");
      // 不重发动作；并发调用共用原 Promise，后续状态由 queryHuman 单独核对。
      return previous.promise;
    }
    if (this.#humanOperations.size >= 1024)
      throw new Error("human-operation-capacity");
    const attemptId = randomUUID();
    const request = {
      ...binding,
      operationId: input.operationId,
      attemptId,
      intentId: randomUUID(),
      toolName: input.toolName,
      arguments: args,
      target: {},
      deadline: new Date(Date.now() + 60_000).toISOString(),
      digest: createHash("sha256").update(fingerprint).digest("hex"),
    };
    const promise = Promise.resolve().then(async (): Promise<HumanReceipt> => {
      try {
        const outcome = actionOutcomeSchema.parse(
          await this.#transport("human.execute", request),
        );
        return { operationId: input.operationId, attemptId, outcome };
      } catch {
        return {
          operationId: input.operationId,
          attemptId,
          outcome: {
            status: "unknown",
            evidence: "unconfirmed",
            result: { reason: "human-result-unconfirmed" },
            artifacts: [],
            truncated: false,
          },
        };
      }
    });
    this.#humanOperations.set(key, { fingerprint, promise });
    return promise;
  }

  readArtifact(id: string, scope: string, environmentId?: string) {
    return this.#transport("artifact.read", {
      id,
      scope,
      ...(environmentId ? { environmentId } : {}),
    });
  }

  #binding(environmentId: string, scope: string) {
    const binding = this.#bindings.get(environmentId);
    if (!binding || binding.scope !== scope)
      throw new Error("environment-binding-mismatch");
    return binding;
  }

  #forExecution(
    input: ActionExecution,
    mode: "execute" | "cancel" | "reconcile" | "result",
  ) {
    const original = input.intent.environment;
    if (!original) throw new Error("environment-required");
    const binding = this.#binding(original.environmentId, input.intent.scope);
    const expected =
      mode === "reconcile"
        ? (input.reconciliationEnvironment ?? original)
        : original;
    if (mode !== "cancel" && !sameReference(expected, binding.environment))
      throw new Error("environment-binding-mismatch");
    if (
      (mode === "cancel" || mode === "reconcile") &&
      !input.controlAuthorizationId
    )
      throw new Error("environment-control-authorization-required");
    return binding;
  }

  readonly actionHooks: Required<
    Pick<
      ActionExecutorOptions,
      "resolveLeaseCredential" | "validateEnvironment"
    >
  > = {
    resolveLeaseCredential: async (input, mode) => ({
      token: this.#forExecution(input, mode).token,
    }),
    validateEnvironment: async (input, mode) => {
      try {
        const binding = this.#forExecution(input, mode);
        const result = await this.#transport(
          "lease.validate",
          {
            environment:
              mode === "reconcile"
                ? binding.environment
                : input.intent.environment,
            token: binding.token,
            scope: input.intent.scope,
          },
          input.signal,
        );
        return z.object({ valid: z.literal(true) }).safeParse(result).success;
      } catch {
        return false;
      }
    },
  };

  provider(id = "linux.environment", version = "1"): ActionProvider {
    const call = async (
      input: ActionExecution,
      mode: "execute" | "cancel" | "reconcile",
    ) => {
      const binding = this.#forExecution(input, mode);
      if (input.leaseCredential?.token !== binding.token)
        throw new Error("environment-credential-required");
      const params = {
        environment: input.intent.environment,
        scope: input.intent.scope,
        intentId: input.intentId,
        attemptId: input.attemptId,
        operationId: input.operationId,
        digest: input.digest,
        toolName: input.intent.toolName,
        arguments: input.intent.arguments,
        target: input.intent.target,
        deadline: input.intent.deadline,
        token: binding.token,
        ...(mode !== "execute"
          ? {
              controlEnvironment: binding.environment,
              controlAuthorizationId: input.controlAuthorizationId,
            }
          : {}),
      };
      const result = await this.#transport(
        `operation.${mode}`,
        params,
        input.signal,
      );
      if (JSON.stringify(result)?.includes(binding.token))
        throw new Error("environment-output-rejected");
      return actionOutcomeSchema.parse(result);
    };
    return {
      id,
      version,
      capabilities: {
        cancellation: "request-confirm",
        idempotency: "operation",
        reconciliation: true,
        successEvidence: "returned",
        fencing: "environment",
      },
      execute: (input) => call(input, "execute"),
      cancel: (input) => call(input, "cancel"),
      reconcile: (input) => call(input, "reconcile"),
    };
  }
}
