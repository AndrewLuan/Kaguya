/**
 * 功能概述：把显式宿主配置的 Linux shell 工具接入 W4 原生目录和 W3/W6 执行边界。
 * LinuxToolsHost 延迟 acquire 并在 bind 前 renew；同一环境的绑定串行，保持秘密仅在 client 内存。
 * snapshot 提供 shell.exec 的有界 schema、scope/target 授权与 broker provider，不另建工具循环。
 * close 释放所持 lease，W6 负责物理隔离；失败保留 owner 以便再次清理，禁止盲目 recover。
 * 代码库关系：Server 从敏感 linux-tools.json 构建此宿主；init/helper 实现 job 与真实 verify。
 */
import { z } from "@kaguya/schema";
import {
  LinuxEnvironmentClient,
  type ActionEnvironment,
} from "./environment.js";
import type { NativeToolLoopOptions } from "./native-tool-loop.js";

const text = z.string().min(1).max(4096);
const jobId = z.string().regex(/^[a-f0-9]{64}$/);
const original = z.object({ operationId: text, attemptId: text }).strict();
export const linuxShellSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("start"),
      argv: z.array(z.string().max(32768)).min(1).max(128),
      cwd: text.default("."),
      env: z.record(z.string(), z.string()).default({}),
    })
    .strict(),
  z.object({ mode: z.literal("query"), jobId }).strict(),
  z.object({ mode: z.literal("stop"), jobId }).strict(),
  z
    .object({
      mode: z.literal("verify"),
      original,
      jobId: jobId.optional(),
      path: text.optional(),
    })
    .strict()
    .refine((v) => Boolean(v.jobId) !== Boolean(v.path)),
  z
    .object({
      mode: z.literal("export"),
      jobId: jobId.optional(),
      stream: z.enum(["stdout", "stderr"]).optional(),
      path: text.optional(),
      mime: text.optional(),
      offset: z.number().int().nonnegative().optional(),
      maxBytes: z.number().int().min(1).max(16777216).optional(),
      sha256: jobId.optional(),
    })
    .strict()
    .refine((v) => Boolean(v.jobId && v.stream) !== Boolean(v.path)),
]);
export const linuxToolsConfigurationSchema = z
  .object({
    version: z.literal(1),
    revision: text,
    bindings: z
      .array(
        z
          .object({ scope: text, environmentId: text, workflowId: text })
          .strict(),
      )
      .max(2),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.bindings.map((b) => b.scope)).size === v.bindings.length &&
      new Set(v.bindings.map((b) => b.environmentId)).size ===
        v.bindings.length,
  );
export type LinuxToolsConfiguration = z.infer<
  typeof linuxToolsConfigurationSchema
>;

export class LinuxToolsHost {
  private readonly leases = new Map<string, ActionEnvironment>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly unavailable = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(
    readonly configuration: LinuxToolsConfiguration,
    readonly client = new LinuxEnvironmentClient(),
    private readonly ttlSeconds = 120,
  ) {
    linuxToolsConfigurationSchema.parse(configuration);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300)
      throw new Error("invalid-host-lease-ttl");
    this.timer = setInterval(
      () => {
        void this.maintain();
      },
      (ttlSeconds * 1000) / 3,
    );
    this.timer.unref();
  }
  async maintain() {
    if (this.closed) return;
    await Promise.allSettled(
      [...this.leases.keys()]
        .filter((scope) => !this.unavailable.has(scope))
        .map((scope) =>
          this.bind(scope).catch(() => {
            this.unavailable.add(scope);
          }),
        ),
    );
  }
  async recover(
    scope: string,
    generation: number,
    controlAuthorizationId: string,
  ) {
    const config = this.configuration.bindings.find((b) => b.scope === scope);
    if (!config || this.closed) throw new Error("linux-tools-scope-denied");
    await this.locks.get(scope)?.catch(() => undefined);
    await this.client.recover({
      environmentId: config.environmentId,
      scope,
      generation,
      controlAuthorizationId,
    });
    this.leases.delete(scope);
    this.unavailable.delete(scope);
  }
  async bind(scope: string): Promise<ActionEnvironment> {
    const config = this.configuration.bindings.find((b) => b.scope === scope);
    if (!config || this.closed || this.unavailable.has(scope))
      throw new Error("linux-tools-scope-denied");
    const previous = this.locks.get(scope) ?? Promise.resolve();
    const work = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.closed) throw new Error("linux-tools-closed");
        let reference = this.leases.get(scope);
        reference = reference
          ? await this.client.renew(
              config.environmentId,
              scope,
              this.ttlSeconds,
            )
          : await this.client.acquire({
              ...config,
              ttlSeconds: this.ttlSeconds,
            });
        this.leases.set(scope, reference);
        return structuredClone(reference);
      });
    this.locks.set(scope, work);
    return work;
  }
  snapshot() {
    const provider = this.client.provider();
    const tools: NativeToolLoopOptions = {
      registrations: this.configuration.bindings.length
        ? [
            {
              id: "shell.exec",
              version: "1",
              description:
                "在独立 Linux workspace 启动持久 shell job，查询/停止 job，或核对/导出文件。start 的 accepted 不代表命令已退出；query 不续 job 许可，超期自动停止全树。",
              providerId: provider.id,
              providerVersion: provider.version,
              executor: "linux",
              readonly: false,
              independent: false,
              policyVersion: this.configuration.revision,
              inputSchema: linuxShellSchema,
              bind: async ({ scope }) => ({
                target: { scope, revision: this.configuration.revision },
                environment: await this.bind(scope),
              }),
              authorize: async ({ intent }) =>
                !this.closed &&
                this.configuration.bindings.some(
                  (b) =>
                    b.scope === intent.scope &&
                    b.environmentId === intent.environment?.environmentId &&
                    b.workflowId === intent.environment.workflowId,
                ) &&
                intent.target.scope === intent.scope &&
                intent.target.revision === this.configuration.revision &&
                intent.providerId === provider.id &&
                intent.executor === "linux",
            },
          ]
        : [],
      tasks: this.configuration.bindings.length
        ? [
            {
              definitionId: "agent.heavy",
              taskId: "agent.heavy.respond",
              toolIds: ["shell.exec"],
            },
          ]
        : [],
    };
    return {
      nativeTools: tools,
      actionProviders: tools.registrations.length ? [provider] : [],
      actionEnvironment: this.client.actionHooks,
    };
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.locks.values());
    const results = await Promise.allSettled(
      [...this.leases].map(async ([scope, ref]) => {
        await this.client.release(ref.environmentId, scope);
        this.leases.delete(scope);
      }),
    );
    if (results.some((r) => r.status === "rejected"))
      throw new Error("linux-tools-cleanup-unconfirmed");
  }
}
