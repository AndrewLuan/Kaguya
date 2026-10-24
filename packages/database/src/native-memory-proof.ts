/**
 * 功能概述：为 native 发布和旧节点读取解析指定来源的身份依赖，不扫描无关来源。
 * 主要职责：sourceProofOwners 在发布事务内读取持久来源与原始消息绑定；persistedSourceProofOwners
 * 只投影来源 ID/owner，读取时受 publication 上界约束，返回 owner→source 映射。
 * 代码库关系：由 native-memory.publish 在发布事务内调用；native-memory-history 读取已保存的映射，
 * 不按当前绑定回填历史。未正规化的入站消息支持首次接触摘要，其他来源必须先正规化。
 * 输入输出与副作用：只读指定 sourceIds；保留已拆分身份的绑定，防止重新发布绕过失效；
 * 无法验证的来源不返回证明，由发布边界拒绝。无绑定入站消息属于其实际会话。
 */
import { canonicalMemorySourceId } from "@kaguya/memory";
import type { SqlTransaction } from "./driver.js";

/** 旧节点只使用持久化归属补证；历史读取只接受上界内已提交的正规来源。 */
export async function persistedSourceProofOwners(
  db: SqlTransaction,
  sourceIds: string[],
  upper?: string,
) {
  const owners = new Map<string, Set<string>>();
  if (!sourceIds.length) return owners;
  const rows = await db.query<{
    id: string;
    owner: string;
    storage_id: string;
    canonical: boolean;
  }>(
    `SELECT a.payload->'memorySource'->>'id' id,a.payload->'memorySource'->>'ownerId' owner,a.information_id storage_id,true canonical FROM information_atoms a
      JOIN information_lifecycle l USING(information_id)
      WHERE a.information_id=ANY($1::text[]) AND a.kind='memory.native.source.v1'
        AND jsonb_typeof(a.payload->'memorySource'->'id')='string' AND jsonb_typeof(a.payload->'memorySource'->'ownerId')='string'
        AND ($3::bigint IS NULL OR l.position<=$3::bigint)
    UNION ALL SELECT source->>'id',source->>'ownerId',id,false FROM memory_native_sources WHERE id=ANY($2::text[]) AND $3::bigint IS NULL
      AND jsonb_typeof(source->'id')='string' AND jsonb_typeof(source->'ownerId')='string'`,
    [sourceIds.map(canonicalMemorySourceId), sourceIds, upper ?? null],
  );
  for (const row of rows.rows) {
    if (
      !sourceIds.includes(row.id) ||
      row.storage_id !==
        (row.canonical ? canonicalMemorySourceId(row.id) : row.id) ||
      typeof row.owner !== "string" ||
      !row.owner.trim()
    )
      continue;
    const { owner: ownerId, id } = row;
    if (!owners.has(ownerId)) owners.set(ownerId, new Set());
    owners.get(ownerId)!.add(id);
  }
  return owners;
}

export async function sourceProofOwners(
  db: SqlTransaction,
  sourceIds: string[],
) {
  const owners = await persistedSourceProofOwners(db, sourceIds);
  const add = (owner: string, source: string) => {
    if (!owners.has(owner)) owners.set(owner, new Set());
    owners.get(owner)!.add(source);
  };
  if (!sourceIds.length) return owners;
  const normalized = new Set([...owners.values()].flatMap((ids) => [...ids]));
  const raw = await db.query<{
    information_id: string;
    payload: Record<string, any>;
    person_ids: string[];
  }>(
    `SELECT a.information_id,a.payload,ARRAY(
      SELECT DISTINCT b.payload->>'personInformationId' FROM information_atoms account
      JOIN information_references r ON r.target_information_id=account.information_id AND r.relation='core:binds'
      JOIN information_atoms b ON b.information_id=r.information_id
      WHERE account.kind='memory.identity.platform.account.entity' AND b.kind='memory.identity.platform.account.binding'
        AND account.payload->>'platform'=a.payload->'source'->>'platform'
        AND account.payload->>'adapterId'=a.payload->'source'->>'adapterId'
        AND account.payload->>'accountId'=a.payload->'source'->>'senderId'
        AND COALESCE(b.payload->>'personInformationId','')<>'') person_ids
    FROM information_atoms a WHERE a.information_id=ANY($1::text[]) AND a.kind='core.message.inbound.text'`,
    [sourceIds],
  );
  for (const { information_id: id, payload, person_ids } of raw.rows) {
    const address = payload.source,
      d = address?.destination;
    if (
      typeof payload.text !== "string" ||
      !payload.text.trim() ||
      typeof address?.platform !== "string" ||
      typeof address.adapterId !== "string" ||
      typeof address.senderId !== "string" ||
      !d ||
      typeof d.kind !== "string"
    )
      continue;
    // 正规来源也保留实际原文绑定；people() 会过滤拆分身份，不能用于证明归属。
    for (const person of person_ids) add(`person:${person}`, id);
    if (!normalized.has(id) && !person_ids.length) {
      add(
        address.sender?.isSelf || address.senderId === address.selfId
          ? "self:kaguya"
          : `conversation:${JSON.stringify([address.platform, address.adapterId, d.kind, d.userId ?? d.groupId ?? d.conversationId ?? null])}`,
        id,
      );
    }
  }
  return owners;
}
