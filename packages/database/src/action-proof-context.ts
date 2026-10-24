/**
 * 功能概述：从持久输出的因果链重建实际送入模型的补充 Memory 证据。
 * 主要职责：沿 caused-by/status-of 找到模型请求，核对 memory_recall 变量与原召回事实；
 * 返回固定快照及登记上界，供宿主签发授权和 admission 同锁复验共用。
 * 代码库关系：不重新检索 Memory，不调用模型；W4 工具决策和消息桥接复用同一入口。
 */
import { nativeMemorySnapshotSchema, type z } from "@kaguya/schema";
type NativeMemorySnapshot = z.infer<typeof nativeMemorySnapshotSchema>;
import type { SqlTransaction } from "./driver.js";

export async function actionProofSnapshots(
  tx: SqlTransaction,
  evidenceId?: string,
): Promise<{ snapshot: NativeMemorySnapshot; boundary: string }[]> {
  if (!evidenceId) return [];
  const rows = (
    await tx.query<{
      information_id: string;
      kind: string;
      payload: any;
      depth: number;
    }>(
      `
    WITH RECURSIVE chain(information_id,depth,path) AS (
      SELECT $1::text,0,ARRAY[$1::text]
      UNION ALL
      SELECT r.target_information_id,c.depth+1,c.path||r.target_information_id
      FROM chain c JOIN information_atoms a USING(information_id)
      JOIN information_references r USING(information_id)
      WHERE c.depth<32 AND a.kind<>'core.model.task.requested'
        AND (r.relation IN ('core:caused-by','core:status-of') OR (c.depth=0 AND r.relation='core:uses-context'))
        AND NOT r.target_information_id=ANY(c.path)
    ) SELECT DISTINCT a.information_id,a.kind,a.payload,c.depth FROM chain c JOIN information_atoms a USING(information_id) LIMIT 4097`,
      [evidenceId],
    )
  ).rows;
  if (!rows.length || rows.length > 4096 || rows.some((r) => r.depth === 32))
    throw new Error("action-proof-chain-invalid");
  const snapshots: { snapshot: NativeMemorySnapshot; boundary: string }[] = [];
  for (const row of rows.filter(
    (r) => r.kind === "core.model.task.requested",
  )) {
    for (const variable of row.payload.prompt?.variables ?? []) {
      if (variable.name === "native_memory")
        snapshots.push({
          snapshot: nativeMemorySnapshotSchema.parse(
            JSON.parse(variable.content),
          ),
          boundary: row.information_id,
        });
      if (variable.name !== "memory_recall") continue;
      const results = JSON.parse(variable.content).results;
      if (
        !Array.isArray(results) ||
        !Array.isArray(variable.informationIds) ||
        results.length !== variable.informationIds.length
      )
        throw new Error("action-recall-proof-invalid");
      for (let i = 0; i < results.length; i++) {
        const saved = (
          await tx.query<{ payload: any }>(
            `SELECT a.payload FROM information_atoms a JOIN information_lifecycle l USING(information_id)
          WHERE a.information_id=$1 AND a.kind='agent.heavy.recall.completed'
          AND l.position<(SELECT position FROM information_lifecycle WHERE information_id=$2)
          AND a.payload->'snapshot'=$3::jsonb AND a.payload->>'status'=$4`,
            [
              variable.informationIds[i],
              row.information_id,
              JSON.stringify(results[i].snapshot),
              results[i].status,
            ],
          )
        ).rows[0];
        if (!saved) throw new Error("action-recall-proof-invalid");
        if (results[i].snapshot)
          snapshots.push({
            snapshot: nativeMemorySnapshotSchema.parse(results[i].snapshot),
            boundary: row.information_id,
          });
      }
    }
  }
  return snapshots;
}

export async function loadActionProofContext(
  tx: SqlTransaction,
  manifest: import("@kaguya/sdk").ObservationManifest,
  evidenceId?: string,
) {
  const base = nativeMemorySnapshotSchema.safeParse(manifest.content.memory);
  const extra = await actionProofSnapshots(tx, evidenceId);
  const snapshots = [
    ...(base.success ? [base.data] : []),
    ...extra.map((e) => e.snapshot),
  ];
  for (const { snapshot } of extra)
    if (
      snapshot.cutoff?.publicationPosition !==
        manifest.knowledgeCutoff.memoryPublicationPosition ||
      (base.success && snapshot.scope !== base.data.scope)
    )
      throw new Error("action-supplement-boundary-mismatch");
  const revisions = new Map(
    manifest.knowledgeCutoff.memoryRevisions.map((r) => [r.id, r.revision]),
  );
  const nodes = snapshots.flatMap((s) => [
    ...s.fixed,
    ...s.recalled.map((r) => r.node),
    ...(s.personCandidates ?? []).map((p) => p.summary),
  ]);
  for (const node of nodes) {
    if (
      revisions.has(node.id) &&
      revisions.get(node.id) !== node.metadata.revision
    )
      throw new Error("action-supplement-revision-conflict");
    revisions.set(node.id, node.metadata.revision);
  }
  const boundaries = new Map(
    manifest.sourceInformationIds.map((id) => [
      id,
      manifest.frozenInformationId,
    ]),
  );
  for (const { snapshot, boundary } of [
    ...(base.success
      ? [{ snapshot: base.data, boundary: manifest.frozenInformationId }]
      : []),
    ...extra,
  ])
    for (const e of snapshot.pendingEvidence ?? [])
      if (!boundaries.has(e.informationId))
        boundaries.set(e.informationId, boundary);
  return {
    snapshots,
    nodes,
    boundaries,
    memoryRevisions: [...revisions].map(([id, revision]) => ({ id, revision })),
    sourceInformationIds: [...boundaries.keys()],
  };
}
