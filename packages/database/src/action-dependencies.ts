/**
 * 功能概述：从已验证 observation 与历史 Memory revision 提取行动实际依据，再叠加当前失效事实。
 * 主要职责：checkActionDependencies 校验冻结身份、范围、版本和原始来源，包含尚未形成节点的来源；
 * 历史 R1 的证明不会被当前 R2 移除来源所覆盖。返回诊断，不授予执行资格。
 * 代码库关系：NativeMemoryAccess 的诊断及 ActionRepository 的 admission 共用本实现；
 * admission 在 7149321 锁后使用新 READ COMMITTED 读取，禁止外部 I/O 进入事务。
 */
import {
  actionDependenciesSchema,
  type ActionDependencies,
  type MemoryDependencyCheck,
  observationManifestSchema,
} from "@kaguya/sdk";
import { nativeMemorySnapshotSchema } from "@kaguya/schema";
import { memoryScope } from "@kaguya/memory";
import {
  currentInvalidity,
  memoryUpper,
  readMemoryInvalidations,
  readMemoryView,
} from "./native-memory-history.js";
import {
  persistedSourceProofOwners,
  sourceProofOwners,
} from "./native-memory-proof.js";
import { loadActionProofContext } from "./action-proof-context.js";
import type { SqlTransaction } from "./driver.js";

export async function checkActionDependencies(
  tx: SqlTransaction,
  raw: ActionDependencies,
): Promise<MemoryDependencyCheck> {
  const input = actionDependenciesSchema.parse(raw);
  const checkedPublicationPosition = await memoryUpper(tx);
  const reasons: MemoryDependencyCheck["reasons"] = [];
  const reject = (id: string, reason: string) => reasons.push({ id, reason });
  const record = (
    await tx.query<{
      manifest: unknown;
      complete: boolean;
      replacement: string | null;
      contract: any;
    }>(
      `SELECT o.manifest,o.complete,o.replacement_observation_id replacement,p.contract FROM information_observations o
     JOIN information_observation_progress p USING(stream_id) WHERE observation_id=$1`,
      [input.observationId],
    )
  ).rows[0];
  const parsed = observationManifestSchema.safeParse(record?.manifest);
  if (
    !record ||
    !record.complete ||
    record.replacement ||
    !parsed.success ||
    parsed.data.proofKind === "memory-native"
  ) {
    reject(input.observationId, "observation-not-action-proof");
    return { valid: false, reasons, checkedPublicationPosition };
  }
  const manifest = parsed.data;
  const scope = memoryScope(record.contract.address);
  const memory = nativeMemorySnapshotSchema.safeParse(manifest.content.memory);
  let proof;
  try {
    proof = await loadActionProofContext(
      tx,
      manifest,
      input.evidenceInformationId,
    );
  } catch {
    reject(input.observationId, "supplement-proof-invalid");
    return { valid: false, reasons, checkedPublicationPosition };
  }
  const requiredSources = proof.sourceInformationIds;
  const same = (a: readonly unknown[], b: readonly unknown[]) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (
    !same(input.sourceInformationIds, requiredSources) ||
    !same(
      input.memoryRevisions.map((n) => `${n.id}:${n.revision}`),
      proof.memoryRevisions.map((n) => `${n.id}:${n.revision}`),
    )
  )
    reject(input.observationId, "required-dependencies-omitted-or-expanded");
  const cutoff = manifest.knowledgeCutoff.memoryPublicationPosition;
  if (memory.success && memory.data.cutoff?.publicationPosition !== cutoff)
    reject(input.observationId, "cutoff-mismatch");
  const sources = new Set<string>();
  const owners = new Set<string>();
  const expected = new Map(
    proof.memoryRevisions.map((n) => [n.id, n.revision]),
  );
  if (input.memoryRevisions.length && (!cutoff || !memory.success))
    reject(input.observationId, "memory-proof-missing");
  if (cutoff && memory.success && input.memoryRevisions.length) {
    const view = await readMemoryView(tx, cutoff, {
      ids: input.memoryRevisions.map((n) => n.id),
    });
    for (const ref of input.memoryRevisions) {
      const n = view.nodes.get(ref.id);
      if (
        expected.get(ref.id) !== ref.revision ||
        !n ||
        n.metadata.revision !== ref.revision ||
        view.invalid.has(ref.id)
      ) {
        reject(ref.id, "frozen-revision-invalid");
        continue;
      }
      const frozen = proof.nodes.find((n) => n.id === ref.id);
      if (
        !frozen ||
        frozen.metadata.revision !== ref.revision ||
        n.metadata.scope !== frozen.metadata.scope ||
        n.metadata.ownerId !== frozen.metadata.ownerId
      )
        reject(ref.id, "frozen-node-mismatch");
    }
    // 只展开真实证明边；predecessors 是审计，不将拆分前的所有来源强加给每个输出。
    for (const n of view.nodes.values()) {
      if (!(
        n.metadata.scope === scope ||
        (n.metadata.scope === "shared" &&
          proof.snapshots.some((s) => s.owners.includes(n.metadata.ownerId)) &&
          ["person", "self", "expression"].includes(n.metadata.kind))
      ))
        reject(n.id, "memory-scope-denied");
      owners.add(n.metadata.ownerId);
      n.metadata.sourceIds.forEach((s) => sources.add(s));
      for (const proof of [
        ...(n.metadata.proofOwners ?? []),
        ...(n.metadata.experience?.proofOwners ?? []),
      ])
        if (proof.sourceIds.some((s) => n.metadata.sourceIds.includes(s)))
          owners.add(proof.ownerId);
    }
    const persisted = await persistedSourceProofOwners(
      tx,
      [...sources],
      cutoff,
    );
    for (const owner of persisted.keys()) owners.add(owner);
    const invalid = await currentInvalidity(
      tx,
      input.memoryRevisions.map((n) => n.id),
    );
    for (const id of invalid) reject(id, "current-memory-invalid");
    const current = (
      await tx.query<{ id: string; revision: number }>(
        "SELECT id::text,(metadata->>'revision')::integer revision FROM memory_nodes WHERE id=ANY($1::uuid[])",
        [input.memoryRevisions.map((n) => n.id)],
      )
    ).rows;
    for (const n of input.memoryRevisions)
      if (!current.some((c) => c.id === n.id && c.revision === n.revision))
        reject(n.id, "memory-revision-changed");
  }
  for (const id of input.sourceInformationIds) {
    if (!requiredSources.includes(id)) {
      reject(id, "source-outside-observation");
      continue;
    }
    const row = (
      await tx.query<{ payload: any; kind: string }>(
        `SELECT a.payload,a.kind FROM information_atoms a JOIN information_lifecycle l USING(information_id)
       WHERE a.information_id=$1 AND l.position<=(SELECT position FROM information_lifecycle WHERE information_id=$2)`,
        [id, proof.boundaries.get(id)],
      )
    ).rows[0];
    let source = row?.payload.source;
    if (row?.kind === "core.delivery.delivered" && row.payload.ok === true) {
      const delivery = (
        await tx.query<{ payload: any }>(
          `SELECT req.payload FROM information_references r JOIN information_atoms req ON req.information_id=r.target_information_id WHERE r.information_id=$1 AND r.relation='core:status-of' AND req.kind='core.delivery.requested'`,
          [id],
        )
      ).rows[0];
      if (
        delivery &&
        delivery.payload.adapterId === row.payload.adapterId &&
        delivery.payload.platform === row.payload.platform &&
        JSON.stringify(delivery.payload.destination) ===
          JSON.stringify(row.payload.target)
      )
        source = {
          adapterId: delivery.payload.adapterId,
          platform: delivery.payload.platform,
          destination: delivery.payload.destination,
        };
    }
    if (
      !row ||
      !["core.message.inbound.text", "core.delivery.delivered"].includes(
        row.kind,
      ) ||
      !source ||
      memoryScope(source) !== scope
    ) {
      reject(id, "raw-source-proof-invalid");
      continue;
    }
    sources.add(id);
    const sourceOwners = await sourceProofOwners(tx, [id]);
    if (![...sourceOwners.values()].some((ids) => ids.has(id)))
      reject(id, "source-owner-unproved");
    for (const owner of sourceOwners.keys()) owners.add(owner);
  }
  const effects = await readMemoryInvalidations(
    tx,
    undefined,
    [...owners],
    [...sources],
  );
  for (const id of effects.withdrawn) reject(id, "source-withdrawn");
  for (const id of effects.identities) reject(id, "identity-split");
  return { valid: reasons.length === 0, reasons, checkedPublicationPosition };
}
