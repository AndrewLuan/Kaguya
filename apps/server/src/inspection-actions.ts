/**
 * 功能概述：读取 W3 原行动及全部有界回执，分别解释当前状态、取消请求、核对与迟到 MCP 证据。
 * actionSummary 不从模型完成推断效果；verifiedReceipt 校验持久 intent/attempt/result 摘要；
 * late evidence 必须匹配 scope、连接版本、类型化 RPC 与原操作身份，不会修改 unknown/partial。
 * 代码库关系：inspection-domain 使用本模块，读取现有 action 表与 Information；返回内容统一清理。
 */
import { createHash } from "node:crypto";
import {
  actionDigest,
  type InspectionFact,
  type InspectionRow,
} from "@kaguya/database";
import {
  inspectionActionPageSchema,
  inspectionActionDetailSchema,
} from "@kaguya/schema";
import {
  DomainReader,
  denied,
  object,
  text,
  list,
  reference,
  hasReference,
  serialMap,
} from "./inspection-domain-common.js";

export const actionSummary = (row: InspectionRow, at: string) => ({
  intentId: row.intent_id,
  at,
  state: row.state,
  runInformationId: row.input.runInformationId,
  decisionInformationId: row.input.decisionInformationId,
  observationId: row.input.dependencies.observationId,
  toolName: row.input.toolName,
  attemptId: row.attempt_id,
  receiptId: row.receipt_id,
  cancellationId: row.cancellation_id,
});
export function verifiedReceipt(f: InspectionFact, row: InspectionRow) {
  const p = f.payload;
  return (
    ["core.action.result.v1", "core.action.reconciled.v1"].includes(f.kind) &&
    hasReference(f, row.intent_id, "core:uses-context") &&
    p.intentId === row.intent_id &&
    p.attemptId === row.attempt_id &&
    actionDigest(p.intent) === actionDigest(row.input) &&
    p.resultHash ===
      actionDigest({
        result: p.outcome?.result,
        artifacts: p.outcome?.artifacts,
      })
  );
}
export function verifiedLate(
  f: InspectionFact,
  row: InspectionRow,
  scope: string,
) {
  const p = f.payload,
    e = object(p.envelope),
    s = object(e.source),
    target = object(row.input.target),
    requests = list(e.requests);
  return (
    p.scopeKey === scope &&
    s.scope === scope &&
    s.trust === "untrusted-mcp-data" &&
    typeof s.transportGeneration === "string" &&
    s.transportGeneration.length > 0 &&
    typeof target.connectionId === "string" &&
    typeof target.connectionRevision === "string" &&
    typeof target.definitionRevision === "string" &&
    typeof target.protocol === "string" &&
    e.value !== undefined &&
    s.connectionId === target.connectionId &&
    s.connectionRevision === target.connectionRevision &&
    s.definitionRevision === target.definitionRevision &&
    s.protocol === target.protocol &&
    hasReference(f, row.intent_id, "core:caused-by") &&
    p.responseDigest ===
      createHash("sha256").update(JSON.stringify(e.value)).digest("hex") &&
    requests.some(
      (t) =>
        t.method === "tools/call" &&
        ["number", "string"].includes(typeof t.rpcId) &&
        t.intentId === row.intent_id &&
        t.attemptId === row.attempt_id &&
        t.operationId === row.input.operationId &&
        t.modelToolCallId === (row.input.toolCallId ?? null),
    )
  );
}
export function actionInspection(d: DomainReader) {
  return {
    actions: (input: unknown) =>
      d.read(input, "actions", async (r, q, meta, before, cursor) => {
        const facts = await r.facts(
            ["core.action.intent.v1"],
            q.scope,
            before,
            q.limit + 1,
          ),
          page = facts.slice(0, q.limit);
        const items = [];
        for (const f of page) {
          const row = await r.action(f.id, q.scope);
          if (row) items.push(actionSummary(row, f.at));
        }
        return inspectionActionPageSchema.parse({
          ...meta,
          items,
          nextCursor:
            facts.length > q.limit ? cursor(page.at(-1)!.position) : null,
          truncated: facts.length > q.limit,
        });
      }),
    action: (id: string, input: unknown) =>
      d.read(input, `action:${id}`, async (r, q, meta) => {
        const row = await r.action(id, q.scope),
          root = await r.fact(id);
        if (!row || root?.kind !== "core.action.intent.v1") throw denied();
        const receipts = await r.receipts(id),
          late = await r.related(
            id,
            ["mcp.client.late-result.v1"],
            "core:caused-by",
          );
        const valid = receipts
          .slice(0, 100)
          .filter((f) => verifiedReceipt(f, row));
        const evidence = late
          .slice(0, 100)
          .filter((f) => verifiedLate(f, row, q.scope));
        return inspectionActionDetailSchema.parse({
          ...meta,
          action: actionSummary(row, root.at),
          intent: d.safe(row.input),
          receipts: valid.map((f) => {
            const p = f.payload,
              o = p.outcome;
            return {
              informationId: f.id,
              at: f.at,
              attemptId: p.attemptId ?? null,
              reconcilesReceiptId: p.reconcilesReceiptId ?? null,
              status: o.status,
              evidence: o.evidence,
              providerReceiptId:
                o.providerReceiptId == null
                  ? null
                  : d.safe(o.providerReceiptId).value,
              environmentValidation: o.environmentValidation ?? null,
              resultHash: p.resultHash,
              truncated: o.truncated ?? false,
              content: d.safe(o),
            };
          }),
          receiptsTruncated: receipts.length > 100,
          lateEvidence: evidence.map((f) => ({
            informationId: f.id,
            at: f.at,
            responseDigest: f.payload.responseDigest,
            source: d.safe(f.payload.envelope.source),
            requests: d.safe(f.payload.envelope.requests),
            value: d.safe(f.payload.envelope.value),
          })),
          lateEvidenceTruncated: late.length > 100,
          rejectedEvidenceCount:
            Math.min(receipts.length, 100) -
            valid.length +
            Math.min(late.length, 100) -
            evidence.length,
          references: await serialMap(
            [
              row.input.runInformationId,
              row.input.decisionInformationId,
              row.started_id,
              row.cancellation_id,
            ].filter(Boolean),
            (id) => reference(r, q.scope, id, "action-evidence"),
          ),
        });
      }),
  };
}
