/**
 * 功能概述：连接 Linux rootless 环境 broker，将 W3 行动契约接入实际环境入口。
 * 主要职责：createUnixBrokerTransport 提供有界单次 RPC，无自动重试；LinuxEnvironmentClient
 * 管理公开环境引用与私有凭证，提供 lease 管理、ActionProvider 和 ActionExecutor hooks。
 * 代码库关系：宿主通过 RuntimeOptions.actionProviders/actionEnvironment 注入；W7/W8 的镜像
 * helper 由 Python broker 调用。环境管理只提供宿主 API，不自动注册模型工具。
 * 输入输出与副作用：token 仅留宿主内存及 socket 请求；控制调用用新 lease 核对原 attempt。
 * 传输中断不是取消证明；返回已有成功证据时保留 succeeded，不改写成 cancelled。
 */
import { createConnection } from "node:net";
import { z } from "@kaguya/schema";
import {
  actionEnvironmentSchema,
  actionOutcomeSchema,
  type ActionExecution,
  type ActionProvider,
} from "@kaguya/sdk";
import type { ActionExecutorOptions } from "./action.js";

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
    try {
      return await this.#transport("lease.release", {
        environment: binding.environment,
        token: binding.token,
        scope,
      });
    } finally {
      this.#bindings.delete(environmentId);
    }
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
    return this.#transport("environment.resume", input);
  }

  readArtifact(id: string, scope: string) {
    return this.#transport("artifact.read", { id, scope });
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
