/**
 * 功能概述：在同一持久事务内裁决工具 run/step、预算、模型 dispatch 和 call→intent 身份。
 * open/freeze 固定不可变上下文，admitModel 在有效 claim 下扣一次步骤预算，calls 固定模型调用顺序。
 * bind 与 W3 register 共用 7149321 锁，stop 阻止后续 admission；结果事实保留实际 receipt，不重执行。
 * Runtime 协调器调用本仓储；模型没有 SQL 或授权入口。所有状态均追加事实并保留原始依据。
 */
import { randomUUID } from "node:crypto";
import {
  freezeInformationAtom,
  nativeMemorySnapshotSchema,
  informationAtomSchema,
  type NativeToolCall,
  type JsonObject,
  type z,
} from "@kaguya/schema";
import {
  nativeToolBudgetSchema,
  nativeToolStepSchema,
  type ActionIntent,
} from "@kaguya/sdk";
import type { InformationClaim } from "@kaguya/engine";
import { assertClaimInTransaction } from "./reliable-repository.js";
import { appendInformationAtom } from "./information-repository.js";
import { PostgresActionStore, actionDigest } from "./action-store.js";
import type { SqlDatabase, SqlTransaction } from "./driver.js";

export interface NativeToolRunRow {
  run_id: string;
  run_key: string;
  spec: JsonObject;
  context_id: string;
  stopped_id: string | null;
  steps_count: number;
  calls_count: number;
  output_bytes: number;
}
export interface NativeToolCallRow {
  run_id: string;
  step_index: number;
  call_index: number;
  call_id: string;
  completed_id: string;
  call: NativeToolCall;
  intent_id: string | null;
  result_id: string | null;
}
export async function prepareNativeToolSchema(db: SqlDatabase) {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(7149321)");
    await tx.exec(`CREATE TABLE IF NOT EXISTS information_native_tool_runs (
      run_id text PRIMARY KEY REFERENCES information_atoms(information_id), run_key text UNIQUE NOT NULL,
      spec jsonb NOT NULL,context_id text NOT NULL REFERENCES information_atoms(information_id),
      stopped_id text REFERENCES information_atoms(information_id),steps_count integer NOT NULL DEFAULT 0,
      calls_count integer NOT NULL DEFAULT 0,output_bytes integer NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS information_native_tool_steps (
      run_id text NOT NULL REFERENCES information_native_tool_runs(run_id), step_index integer NOT NULL,
      frozen_id text NOT NULL REFERENCES information_atoms(information_id), request_id text,
      dispatched_id text REFERENCES information_atoms(information_id), PRIMARY KEY(run_id,step_index));
    CREATE TABLE IF NOT EXISTS information_native_tool_calls (
      run_id text NOT NULL,step_index integer NOT NULL,call_index integer NOT NULL,call_id text NOT NULL,
      completed_id text NOT NULL REFERENCES information_atoms(information_id),call jsonb NOT NULL,
      intent_id text REFERENCES information_action_heads(intent_id),result_id text REFERENCES information_atoms(information_id),
      PRIMARY KEY(run_id,step_index,call_index),UNIQUE(run_id,step_index,call_id),
      FOREIGN KEY(run_id,step_index) REFERENCES information_native_tool_steps(run_id,step_index));`);
  });
}
export class PostgresNativeToolStore {
  constructor(private readonly db: SqlDatabase) {}
  private tx<T>(fn: (tx: SqlTransaction) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.exec("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      await tx.query("SELECT pg_advisory_xact_lock(7149321)");
      return fn(tx);
    });
  }
  private async fact(
    tx: SqlTransaction,
    kind: string,
    payload: unknown,
    context: string,
    refs: string[],
  ) {
    await tx.query(
      "INSERT INTO information_kinds(kind) VALUES($1) ON CONFLICT DO NOTHING",
      [kind],
    );
    const atom = freezeInformationAtom(
      informationAtomSchema.parse({
        informationId: randomUUID(),
        kind,
        source: "runtime:native-tools",
        occurredAt: new Date().toISOString(),
        payload,
        references:
          kind === "core.model.task.dispatched.v1"
            ? [{ relation: "core:caused-by", informationId: refs[0] }]
            : [
                { relation: "core:context", informationId: context },
                ...[...new Set(refs)].map((informationId) => ({
                  relation: "core:uses-context",
                  informationId,
                })),
              ],
      }),
    );
    await appendInformationAtom(
      tx,
      atom,
      kind === "core.model.task.dispatched.v1"
        ? [{ relation: "core:caused-by", required: true, multiple: false }]
        : [
            { relation: "core:context", required: true, multiple: false },
            { relation: "core:uses-context", required: true, multiple: true },
          ],
    );
    return atom;
  }
  private async row(tx: SqlTransaction, id: string) {
    const row = (
      await tx.query<NativeToolRunRow & Record<string, unknown>>(
        "SELECT * FROM information_native_tool_runs WHERE run_id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!row) throw new Error("native-run-missing");
    return row;
  }
  private async active(
    tx: SqlTransaction,
    row: NativeToolRunRow,
    guard?: InformationClaim,
  ) {
    if (guard) await assertClaimInTransaction(tx, guard);
    const action = (
      await tx.query<{ invalidated_id: string | null }>(
        "SELECT invalidated_id FROM information_action_runs WHERE run_id=$1",
        [String(row.spec.actionRunInformationId)],
      )
    ).rows[0];
    if (
      row.stopped_id ||
      action?.invalidated_id ||
      Date.parse(String(row.spec.deadline)) <= Date.now()
    )
      throw new Error("native-run-stopped");
  }
  async open(
    key: string,
    spec: JsonObject,
    context: string,
    refs: string[],
    guard?: InformationClaim,
  ) {
    return this.tx(async (tx) => {
      const old = (
        await tx.query<NativeToolRunRow & Record<string, unknown>>(
          "SELECT * FROM information_native_tool_runs WHERE run_key=$1",
          [key],
        )
      ).rows[0];
      if (old) return old;
      if (guard) await assertClaimInTransaction(tx, guard);
      const atom = await this.fact(
        tx,
        "agent.heavy.tool.run.v1",
        { key, spec },
        context,
        refs,
      );
      await tx.query(
        "INSERT INTO information_native_tool_runs(run_id,run_key,spec,context_id) VALUES($1,$2,$3::jsonb,$4)",
        [atom.informationId, key, JSON.stringify(spec), context],
      );
      return this.row(tx, atom.informationId);
    });
  }
  async read(id: string) {
    return this.tx((tx) => this.row(tx, id));
  }
  async byKey(key: string) {
    return (
      await this.db.query<NativeToolRunRow & Record<string, unknown>>(
        "SELECT * FROM information_native_tool_runs WHERE run_key=$1",
        [key],
      )
    ).rows[0];
  }
  async step(runId: string, index: number, db: SqlTransaction = this.db) {
    const row = (
      await db.query<{
        information_id: string;
        payload: z.infer<typeof nativeToolStepSchema>;
      }>(
        "SELECT a.information_id,a.payload FROM information_native_tool_steps s JOIN information_atoms a ON a.information_id=s.frozen_id WHERE run_id=$1 AND step_index=$2",
        [runId, index],
      )
    ).rows[0];
    return row
      ? { ...row, payload: nativeToolStepSchema.parse(row.payload) }
      : undefined;
  }
  async freeze(
    raw: z.infer<typeof nativeToolStepSchema>,
    guard?: InformationClaim,
  ) {
    const p = nativeToolStepSchema.parse(raw);
    return this.tx(async (tx) => {
      const row = await this.row(tx, p.runInformationId);
      const old = await this.step(p.runInformationId, p.stepIndex, tx);
      if (old) return old;
      await this.active(tx, row, guard);
      if (p.observationId !== row.spec.observationId)
        throw new Error("native-step-observation-mismatch");
      if (
        p.stepIndex === 0 &&
        (p.previousStepInformationId ||
          p.modelCompletedInformationId ||
          p.receiptIds.length ||
          p.supplements.length ||
          actionDigest(p.memory) !== actionDigest(row.spec.memory))
      )
        throw new Error("native-step-memory-mismatch");
      if (p.stepIndex > 0) {
        const previous = (
          await tx.query<{ frozen_id: string }>(
            "SELECT frozen_id FROM information_native_tool_steps WHERE run_id=$1 AND step_index=$2",
            [row.run_id, p.stepIndex - 1],
          )
        ).rows[0];
        const calls = (
          await tx.query<NativeToolCallRow & Record<string, unknown>>(
            "SELECT * FROM information_native_tool_calls WHERE run_id=$1 AND step_index=$2 ORDER BY call_index",
            [row.run_id, p.stepIndex - 1],
          )
        ).rows;
        if (
          !previous ||
          previous.frozen_id !== p.previousStepInformationId ||
          !calls.length ||
          calls.some(
            (c) =>
              !c.result_id || c.completed_id !== p.modelCompletedInformationId,
          )
        )
          throw new Error("native-step-unpaired");
        const resultIds = calls.map((c) => c.result_id!);
        const receipts = (
          await tx.query<{ receipt_id: string }>(
            "SELECT payload->>'receiptId' receipt_id FROM information_atoms WHERE information_id=ANY($1::text[]) AND payload->>'receiptId' IS NOT NULL",
            [resultIds],
          )
        ).rows.map((r) => r.receipt_id);
        if (
          actionDigest([...receipts].sort()) !==
          actionDigest([...p.receiptIds].sort())
        )
          throw new Error("native-step-receipt-mismatch");
        const memoryResults = (
          await tx.query<{ value: any }>(
            `SELECT a.payload->'value' value FROM information_native_tool_calls c JOIN information_atoms a ON a.information_id=c.result_id JOIN information_action_heads h ON h.intent_id=c.intent_id WHERE c.run_id=$1 AND c.step_index=$2 AND h.input->>'providerId'='core.native-memory' ORDER BY c.call_index`,
            [row.run_id, p.stepIndex - 1],
          )
        ).rows;
        const supplements = memoryResults.flatMap((r) => [
          ...(r.value?.result?.memorySnapshot
            ? [nativeMemorySnapshotSchema.parse(r.value.result.memorySnapshot)]
            : []),
          ...(r.value?.result?.memorySnapshots
            ? r.value.result.memorySnapshots.map((s: unknown) =>
                nativeMemorySnapshotSchema.parse(s),
              )
            : []),
        ]);
        const prior = (await this.step(row.run_id, p.stepIndex - 1, tx))!
          .payload.memory;
        const latest = supplements.at(-1);
        const memory =
          latest &&
          (!prior ||
            BigInt(latest.cutoff?.publicationPosition ?? "0") >=
              BigInt(prior.cutoff?.publicationPosition ?? "0"))
            ? latest
            : prior;
        if (
          actionDigest(p.supplements) !== actionDigest(supplements) ||
          actionDigest(p.memory) !== actionDigest(memory)
        )
          throw new Error("native-step-memory-mismatch");
      }
      const atom = await this.fact(
        tx,
        "agent.heavy.tool.step.frozen.v1",
        p,
        row.context_id,
        [
          row.run_id,
          ...p.receiptIds,
          ...(p.previousStepInformationId ? [p.previousStepInformationId] : []),
          ...(p.modelCompletedInformationId
            ? [p.modelCompletedInformationId]
            : []),
        ],
      );
      await tx.query(
        "INSERT INTO information_native_tool_steps(run_id,step_index,frozen_id) VALUES($1,$2,$3)",
        [row.run_id, p.stepIndex, atom.informationId],
      );
      return { information_id: atom.informationId, payload: p };
    });
  }
  async admitModel(
    runId: string,
    index: number,
    requestId: string,
    guard?: InformationClaim,
  ) {
    return this.tx(async (tx) => {
      const row = await this.row(tx, runId);
      await this.active(tx, row, guard);
      const step = (
        await tx.query<{
          dispatched_id: string | null;
          request_id: string | null;
        }>(
          "SELECT dispatched_id,request_id FROM information_native_tool_steps WHERE run_id=$1 AND step_index=$2 FOR UPDATE",
          [runId, index],
        )
      ).rows[0];
      if (!step) throw new Error("native-step-missing");
      if (step.dispatched_id) return false;
      const request = (
        await tx.query<{ payload: any }>(
          "SELECT payload FROM information_atoms WHERE information_id=$1 AND kind='core.model.task.requested'",
          [requestId],
        )
      ).rows[0];
      if (
        !request ||
        request.payload.nativeStep?.runInformationId !== runId ||
        request.payload.nativeStep?.stepIndex !== index ||
        actionDigest(request.payload.tools) !==
          actionDigest(row.spec.declarations)
      )
        throw new Error("native-request-unproved");
      const budget = nativeToolBudgetSchema.parse(row.spec.budget);
      if (row.steps_count >= budget.maxSteps)
        throw new Error("native-step-budget");
      const atom = await this.fact(
        tx,
        "core.model.task.dispatched.v1",
        { requestedInformationId: requestId, nonce: randomUUID() },
        row.context_id,
        [requestId],
      );
      await tx.query(
        "UPDATE information_native_tool_steps SET dispatched_id=$3,request_id=$4 WHERE run_id=$1 AND step_index=$2",
        [runId, index, atom.informationId, requestId],
      );
      await tx.query(
        "UPDATE information_native_tool_runs SET steps_count=steps_count+1 WHERE run_id=$1",
        [runId],
      );
      await this.active(tx, row, guard);
      return true;
    });
  }
  async calls(runId: string, index: number, db: SqlTransaction = this.db) {
    return (
      await db.query<NativeToolCallRow & Record<string, unknown>>(
        "SELECT * FROM information_native_tool_calls WHERE run_id=$1 AND step_index=$2 ORDER BY call_index",
        [runId, index],
      )
    ).rows;
  }
  async registerCalls(
    runId: string,
    index: number,
    completedId: string,
    calls: NativeToolCall[],
    guard?: InformationClaim,
  ) {
    return this.tx(async (tx) => {
      const row = await this.row(tx, runId);
      const old = await this.calls(runId, index, tx);
      if (old.length) {
        if (
          old[0]!.completed_id !== completedId ||
          actionDigest(old.map((c) => c.call)) !== actionDigest(calls)
        )
          throw new Error("native-calls-conflict");
        return old;
      }
      await this.active(tx, row, guard);
      const completed = (
        await tx.query<{ payload: any }>(
          "SELECT payload FROM information_atoms WHERE information_id=$1 AND kind='core.model.task.completed'",
          [completedId],
        )
      ).rows[0];
      const request = (
        await tx.query<{ request_id: string }>(
          "SELECT request_id FROM information_native_tool_steps WHERE run_id=$1 AND step_index=$2 AND dispatched_id IS NOT NULL",
          [runId, index],
        )
      ).rows[0];
      const caused = (
        await tx.query(
          "SELECT 1 FROM information_references WHERE information_id=$1 AND target_information_id=$2 AND relation='core:status-of'",
          [completedId, request?.request_id],
        )
      ).rowCount;
      if (
        !caused ||
        !completed ||
        completed.payload.nativeStep?.runInformationId !== runId ||
        completed.payload.nativeStep?.stepIndex !== index ||
        completed.payload.generationKind !== "tool-calls" ||
        actionDigest(completed.payload.toolCalls) !== actionDigest(calls)
      )
        throw new Error("native-calls-unproved");
      if (
        !calls.length ||
        new Set(calls.map((c) => c.toolCallId)).size !== calls.length
      )
        throw new Error("native-call-id-conflict");
      const budget = nativeToolBudgetSchema.parse(row.spec.budget);
      if (row.calls_count + calls.length > budget.maxCalls)
        throw new Error("native-call-budget");
      for (const [i, c] of calls.entries())
        await tx.query(
          "INSERT INTO information_native_tool_calls(run_id,step_index,call_index,call_id,completed_id,call) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
          [runId, index, i, c.toolCallId, completedId, JSON.stringify(c)],
        );
      await tx.query(
        "UPDATE information_native_tool_runs SET calls_count=calls_count+$2 WHERE run_id=$1",
        [runId, calls.length],
      );
      return this.calls(runId, index, tx);
    });
  }
  async bind(
    call: NativeToolCallRow,
    intent: ActionIntent,
    guard?: InformationClaim,
  ) {
    return this.tx(async (tx) => {
      const row = await this.row(tx, call.run_id);
      await this.active(tx, row, guard);
      const current = (
        await tx.query<{ intent_id: string | null }>(
          "SELECT intent_id FROM information_native_tool_calls WHERE run_id=$1 AND step_index=$2 AND call_index=$3 FOR UPDATE",
          [call.run_id, call.step_index, call.call_index],
        )
      ).rows[0];
      if (!current) throw new Error("native-call-missing");
      if (current.intent_id) return current.intent_id;
      if (intent.toolCallId !== call.call_id)
        throw new Error("native-call-intent-mismatch");
      const action = await new PostgresActionStore(this.db).register(
        intent,
        guard,
        tx,
      );
      await tx.query(
        "UPDATE information_native_tool_calls SET intent_id=$4 WHERE run_id=$1 AND step_index=$2 AND call_index=$3",
        [call.run_id, call.step_index, call.call_index, action.intentId],
      );
      await this.active(tx, row, guard);
      return action.intentId;
    });
  }
  async result(
    call: NativeToolCallRow,
    value: unknown,
    receiptId: string | null,
    authorizationId?: string,
  ) {
    return this.tx(async (tx) => {
      const row = await this.row(tx, call.run_id);
      const current = (
        await tx.query<NativeToolCallRow & Record<string, unknown>>(
          "SELECT * FROM information_native_tool_calls WHERE run_id=$1 AND step_index=$2 AND call_index=$3 FOR UPDATE",
          [call.run_id, call.step_index, call.call_index],
        )
      ).rows[0]!;
      if (
        !current ||
        actionDigest(current.call) !== actionDigest(call.call) ||
        current.call_id !== call.call_id ||
        current.completed_id !== call.completed_id
      )
        throw new Error("native-result-call-mismatch");
      if (current.result_id) return current.result_id;
      if (receiptId) {
        if (!authorizationId || !current.intent_id)
          throw new Error("native-result-receipt-unproved");
        const receipt = await new PostgresActionStore(this.db).readReceipt(
          receiptId,
          String(row.spec.scope),
          authorizationId,
          tx,
        );
        if (
          receipt.intentId !== current.intent_id ||
          receipt.intent.toolCallId !== current.call_id ||
          receipt.intent.runInformationId !== row.spec.actionRunInformationId
        )
          throw new Error("native-result-receipt-mismatch");
        value = {
          ...receipt.outcome,
          receiptId: receipt.receiptId,
          resultHash: receipt.resultHash,
        };
      } else if (current.intent_id) {
        const head = (
          await tx.query<{ state: string }>(
            "SELECT state FROM information_action_heads WHERE intent_id=$1",
            [current.intent_id],
          )
        ).rows[0];
        if (head?.state !== "queued")
          throw new Error("native-result-requires-receipt");
      }
      let projected = value;
      let bytes = Buffer.byteLength(JSON.stringify(value));
      const budget = nativeToolBudgetSchema.parse(row.spec.budget);
      if (
        bytes > budget.maxToolOutputBytes ||
        row.output_bytes + bytes > budget.maxTotalToolOutputBytes
      ) {
        projected = { status: "output-budget", receiptId, truncated: true };
        bytes = Buffer.byteLength(JSON.stringify(projected));
      }
      const atom = await this.fact(
        tx,
        "agent.heavy.tool.result.v1",
        {
          runInformationId: row.run_id,
          stepIndex: call.step_index,
          toolCallId: call.call_id,
          modelCompletedInformationId: call.completed_id,
          intentId: current.intent_id,
          receiptId,
          value: projected,
          outputBytes: bytes,
        },
        row.context_id,
        [row.run_id, call.completed_id, ...(receiptId ? [receiptId] : [])],
      );
      await tx.query(
        "UPDATE information_native_tool_calls SET result_id=$4 WHERE run_id=$1 AND step_index=$2 AND call_index=$3",
        [call.run_id, call.step_index, call.call_index, atom.informationId],
      );
      await tx.query(
        "UPDATE information_native_tool_runs SET output_bytes=output_bytes+$2 WHERE run_id=$1",
        [call.run_id, bytes],
      );
      return atom.informationId;
    });
  }
  async stop(
    runId: string,
    reason: string,
    modelResult: unknown = null,
    causeId?: string,
  ) {
    return this.tx(async (tx) => {
      const row = await this.row(tx, runId);
      if (row.stopped_id) return row.stopped_id;
      const atom = await this.fact(
        tx,
        "agent.heavy.tool.terminal.v1",
        { runInformationId: runId, reason, modelResult },
        row.context_id,
        [runId, ...(causeId ? [causeId] : [])],
      );
      await tx.query(
        "UPDATE information_native_tool_runs SET stopped_id=$2 WHERE run_id=$1",
        [runId, atom.informationId],
      );
      return atom.informationId;
    });
  }
  async requests(runId: string) {
    return (
      await this.db.query<{ request_id: string }>(
        "SELECT request_id FROM information_native_tool_steps WHERE run_id=$1 AND request_id IS NOT NULL ORDER BY step_index",
        [runId],
      )
    ).rows.map((r) => r.request_id);
  }
  async intents(runId: string) {
    return (
      await this.db.query<{ intent_id: string }>(
        "SELECT intent_id FROM information_native_tool_calls WHERE run_id=$1 AND intent_id IS NOT NULL ORDER BY step_index,call_index",
        [runId],
      )
    ).rows.map((r) => r.intent_id);
  }
}
