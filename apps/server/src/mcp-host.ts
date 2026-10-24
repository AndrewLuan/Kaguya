/**
 * 功能概述：在 Server 生命周期中打开 MCP，合并已有 Memory 工具路由并提供管理端按需读取入口。
 * openServerMcp 缺省关闭；mcpRuntimeOptions 复用 W4 注册/W3 provider，不创建第二个执行循环。
 * registerMcpRoutes 每个请求验证 Gateway management token；prompt 展开仅由明确用户 POST 创建选择。
 * 连接目标和凭据引用来自敏感 mcp.json，HTTP 请求只能给出已配置连接、scope、资源 URI 或 prompt 参数。
 * 返回值保留不可信来源；异常只返回稳定代码，停用和清理由 server.ts 按 Runtime→MCP 顺序负责。
 */
import { isDeepStrictEqual } from "node:util";
import { createRuntimeKindRegistry } from "@kaguya/runtime";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import {
  McpHost,
  McpError,
  loadMcpConfiguration,
  mcpResourcesCapability,
  mcpPromptsCapability,
  mcpLateResultInformationKind,
  type McpEnvelope,
} from "@kaguya/mcp";
import {
  z,
  freezeInformationAtom,
  informationAtomSchema,
} from "@kaguya/schema";
import type { KaguyaDatabase } from "@kaguya/database";
import type {
  NativeToolLoopOptions,
  RuntimeCapabilities,
  RuntimeCapabilityContext,
} from "@kaguya/runtime";
import type { GatewayAuthenticator } from "./gateway-auth.js";

export function createMcpLateResultRecorder(database: KaguyaDatabase) {
  return async (envelope: McpEnvelope, informationId: string) => {
    const trace = envelope.requests.find(
      (request) => request.method === "tools/call",
    );
    if (!trace?.intentId || !trace.attemptId || !trace.operationId)
      throw new McpError("mcp-late-result-unmapped");
    const action = await database.actions.read(
      trace.intentId,
      envelope.source.scope,
    );
    const target = action.intent.target;
    if (
      action.attemptId !== trace.attemptId ||
      action.intent.operationId !== trace.operationId ||
      (action.intent.toolCallId ?? null) !== trace.modelToolCallId ||
      target.connectionId !== envelope.source.connectionId ||
      target.connectionRevision !== envelope.source.connectionRevision ||
      target.definitionRevision !== envelope.source.definitionRevision ||
      target.protocol !== envelope.source.protocol
    )
      throw new McpError("mcp-late-result-unmapped");
    const atom = freezeInformationAtom(
      informationAtomSchema.parse({
        informationId,
        kind: mcpLateResultInformationKind.kind,
        source: "mcp:client",
        occurredAt: envelope.source.observedAt,
        payload: {
          scopeKey: envelope.source.scope,
          responseDigest: createHash("sha256")
            .update(JSON.stringify(envelope.value))
            .digest("hex"),
          envelope: JSON.parse(JSON.stringify(envelope)),
        },
        references: [
          { relation: "core:caused-by", informationId: trace.intentId },
        ],
      }),
    );
    const existing = await database.information.get(informationId);
    if (existing) {
      if (
        existing.kind !== atom.kind ||
        existing.source !== atom.source ||
        existing.occurredAt !== atom.occurredAt ||
        !isDeepStrictEqual(existing.payload, atom.payload) ||
        !isDeepStrictEqual(existing.references, atom.references)
      )
        throw new McpError("mcp-late-result-identity-conflict");
      return;
    }
    await database.information.append(atom, [
      { relation: "core:caused-by", required: true, multiple: false },
    ]);
  };
}
export async function openServerMcp(root: string, database: KaguyaDatabase) {
  await database.information.synchronizeKinds(
    [mcpLateResultInformationKind.kind],
    [mcpLateResultInformationKind],
  );
  return McpHost.open(
    await loadMcpConfiguration(root),
    (reference) => process.env[reference],
    {
      ownershipDirectory: join(root, "mcp-processes"),
      recordLateResult: createMcpLateResultRecorder(database),
    },
  );
}
export function mcpRuntimeOptions(
  host: McpHost,
  existing?: NativeToolLoopOptions,
) {
  const snapshot = host.snapshot();
  if (!snapshot.nativeTools.registrations.length)
    return {
      actionProviders: snapshot.actionProviders,
      ...(existing ? { nativeTools: existing } : {}),
    };
  const tasks = [...(existing?.tasks ?? []), ...snapshot.nativeTools.tasks];
  const combined = new Map<string, (typeof tasks)[number]>();
  for (const task of tasks) {
    const key = JSON.stringify([task.definitionId, task.taskId, task.routeId]);
    const previous = combined.get(key);
    combined.set(key, {
      ...task,
      toolIds: [...new Set([...(previous?.toolIds ?? []), ...task.toolIds])],
    });
  }
  return {
    actionProviders: snapshot.actionProviders,
    nativeTools: {
      ...existing,
      registrations: [
        ...(existing?.registrations ?? []),
        ...snapshot.nativeTools.registrations,
      ],
      tasks: [...combined.values()],
    },
  };
}
export function withServerMcp<
  T extends {
    nativeTools?: NativeToolLoopOptions;
    capabilities?: RuntimeCapabilities;
  },
>(host: McpHost, composition: T) {
  return {
    ...composition,
    ...mcpRuntimeOptions(host, composition.nativeTools),
    capabilities: (context: RuntimeCapabilityContext) => [
      ...(typeof composition.capabilities === "function"
        ? composition.capabilities(context)
        : (composition.capabilities ?? [])),
      {
        capability: mcpResourcesCapability,
        value: {
          list: host.listResources.bind(host),
          templates: host.listResourceTemplates.bind(host),
          read: host.readResource.bind(host),
        },
      },
      {
        capability: mcpPromptsCapability,
        value: {
          list: host.listPrompts.bind(host),
          get: host.getPrompt.bind(host),
        },
      },
    ],
  };
}
const requestSchema = z
  .object({
    connectionId: z.string().min(1),
    scope: z.string().min(1),
    kind: z.enum(["resources", "templates", "prompts", "resource", "prompt"]),
    uri: z.string().optional(),
    name: z.string().optional(),
    arguments: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export function registerMcpRoutes(
  app: FastifyInstance,
  getHost: () => McpHost | undefined,
  auth: GatewayAuthenticator,
) {
  app.post(
    "/api/mcp/read",
    {
      onRequest: async (request, reply) => {
        const token =
          /^Bearer[ \t]+(.+)$/i.exec(
            request.headers.authorization ?? "",
          )?.[1] ?? "";
        if (!(await auth.authorize(token, "management")))
          return reply.code(401).send({ error: "unauthorized" });
      },
    },
    async (request, reply) => {
      const parsed = requestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "mcp-request-invalid" });
      const host = getHost();
      if (!host) return reply.code(409).send({ error: "mcp-unavailable" });
      const input = parsed.data;
      try {
        switch (input.kind) {
          case "resources":
            return await host.listResources(input.connectionId, input.scope);
          case "templates":
            return await host.listResourceTemplates(
              input.connectionId,
              input.scope,
            );
          case "prompts":
            return await host.listPrompts(input.connectionId, input.scope);
          case "resource":
            if (!input.uri) throw new McpError("mcp-uri-required");
            return await host.readResource(
              input.connectionId,
              input.scope,
              input.uri,
            );
          case "prompt":
            if (!input.name) throw new McpError("mcp-prompt-name-required");
            return await host.getPrompt(
              host.selectPrompt({
                connectionId: input.connectionId,
                scope: input.scope,
                name: input.name,
                arguments: input.arguments ?? {},
              }),
            );
        }
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof McpError ? error.code : "mcp-request-failed",
        });
      }
    },
  );
}

/** 沿用已加载模块的所有 Kind 对象，在预检封锁前构建包含宿主 MCP 事实的新 Registry。 */
export function withMcpKindRegistry<
  T extends {
    catalog: Parameters<typeof createRuntimeKindRegistry>[0];
    kindRegistry: ReturnType<typeof createRuntimeKindRegistry>;
  },
>(snapshot: T): T {
  return {
    ...snapshot,
    kindRegistry: createRuntimeKindRegistry(snapshot.catalog, [
      ...snapshot.kindRegistry.definitions(),
      mcpLateResultInformationKind,
    ]),
  };
}
