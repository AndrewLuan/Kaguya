/**
 * 功能概述：验证 native 历史上界、来源失效、经历事务、分页及真实 PostgreSQL 提交可见性。
 * 主要职责：双数据库用例保留原文/epoch/哈希；真实 PG barrier 将 publication 停在提交前，
 * 证明较晚冻结不会因较早分配 position 而吸入未见知识。所有阻塞在 finally 释放后再关闭连接。
 * 代码库关系：直接调用生产 NativeMemoryStore/Access，仅向量候选使用离线替身；不调用外部模型。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeMemoryAccess,
  type NativeMemoryNode,
} from "@kaguya/memory";
import { freezeInformationAtom, informationAtomSchema } from "@kaguya/schema";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "./testing.js";
import { KaguyaDatabase } from "./index.js";
import type { SqlDatabase } from "./driver.js";
import { observationManifestSchema } from "@kaguya/sdk";
const opened: KaguyaDatabase[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    opened.splice(0).map((db) => db.close()),
  );
  const errors = results
    .filter((r) => r.status === "rejected")
    .map((r) => (r as PromiseRejectedResult).reason);
  if (errors.length)
    throw new AggregateError(errors, "Database cleanup failed");
});
const url = process.env.KAGUYA_TEST_DATABASE_URL;
const backends = [
  { name: "PGlite", create: createTestingDatabase },
  ...(url
    ? [{ name: "PostgreSQL", create: () => createPostgresTestingDatabase(url) }]
    : []),
];
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = JSON.stringify(["qq", "qq", "group", "G"]);
const input = {
  scope,
  owners: ["person:a"],
  asOf: "2030-01-01T00:00:00Z",
  query: "钢琴",
  explicitIds: [id(2)],
};
const node = (
  n: number,
  level = 1,
  sourceIds: string[] = [],
): NativeMemoryNode => ({
  id: id(n),
  content: `钢琴经历${n}`,
  metadata: {
    system: "native-v1",
    kind: "person",
    ownerId: "person:a",
    scope,
    level,
    revision: 1,
    status: "active",
    locked: false,
    sourceIds,
    aliases: ["阿同"],
    tags: [],
    occurredAt: "2026-01-01T00:00:00Z",
  },
});
async function source(
  db: KaguyaDatabase,
  sourceId: string,
  text = "原文",
  occurredAt = "2020-01-01T00:00:00Z",
) {
  await db.information.synchronizeKinds(["core.message.inbound.text"]);
  await db.information.append(
    freezeInformationAtom(
      informationAtomSchema.parse({
        informationId: sourceId,
        kind: "core.message.inbound.text",
        occurredAt,
        source: "test:memory",
        payload: {
          text,
          source: {
            platform: "qq",
            adapterId: "qq",
            senderId: "a",
            selfId: "bot",
            destination: { kind: "group", groupId: "G" },
          },
        },
        references: [],
      }),
    ),
    [],
  );
}
async function setup(create: () => Promise<KaguyaDatabase>) {
  const db = await create();
  opened.push(db);
  await db.prepareSchema();
  return db;
}
const put = (
  db: KaguyaDatabase,
  operationId: string,
  nodes: NativeMemoryNode[],
  extra = {},
) =>
  db.memoryGraph.native.publish({
    operationId,
    actor: "manual",
    nodes: nodes.map((n) => ({
      node: n,
      expectedRevision: n.metadata.revision - 1,
    })),
    ...extra,
  });

describe.each(backends)("native revision boundary ($name)", ({ create }) => {
  it("keeps historical text and edges while current revisions change", async () => {
    const db = await setup(create),
      a = node(1, 0),
      b = node(2),
      c = node(3);
    await put(db, "first", [a, b, c], {
      edges: [{ sourceId: a.id, targetId: b.id, relation: "related" }],
    });
    const access = createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    });
    const old = await access.freeze(input);
    await put(
      db,
      "second",
      [{ ...b, content: "新的结论", metadata: { ...b.metadata, revision: 2 } }],
      {
        expectedVersions: { [a.id]: 1, [c.id]: 1 },
        removeEdges: [{ sourceId: a.id, targetId: b.id, relation: "related" }],
        edges: [{ sourceId: a.id, targetId: c.id, relation: "related" }],
      },
    );
    expect(
      (
        await db.memoryGraph.native.current({ ...input, cutoff: old.cutoff! }, [
          b.id,
        ])
      )[0]!.content,
    ).toBe(b.content);
    expect(
      (
        await db.memoryGraph.native.expand({ ...input, cutoff: old.cutoff! }, [
          a.id,
        ])
      ).map((x) => x.node.id),
    ).toEqual([b.id]);
    expect(
      (await db.memoryGraph.native.expand(input, [a.id])).map((x) => x.node.id),
    ).toEqual([c.id]);
    expect(old.recalled.find((x) => x.node.id === b.id)?.node.content).toBe(
      b.content,
    );
  });
  it("withdraws proof descendants on every read and rechecks stale auxiliary candidates", async () => {
    const db = await setup(create);
    await source(db, "S");
    const a = node(1, 0),
      b = node(2, 1, ["S"]),
      c = node(3, 1),
      other = {
        ...node(4, 0),
        metadata: { ...node(4, 0).metadata, ownerId: "person:b" },
      };
    await put(db, "first", [a, b, c, other], {
      edges: [
        { sourceId: a.id, targetId: b.id, relation: "summarizes" },
        { sourceId: b.id, targetId: c.id, relation: "related" },
      ],
    });
    const prior = await createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    }).freeze(input);
    const access = createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
      retrievers: [
        {
          identity: "stale",
          role: "semantic",
          search: async () => {
            await put(db, "withdraw", [], {
              invalidations: [
                {
                  kind: "source-withdrawal",
                  targetId: "S",
                  reason: "原作者撤回",
                },
              ],
            });
            return [a, b];
          },
        },
      ],
    });
    const fresh = await access.freeze(input);
    expect(fresh.fixed).toEqual([]);
    expect(fresh.recalled.some((r) => [a.id, b.id].includes(r.node.id))).toBe(
      false,
    );
    expect(
      (await db.memoryGraph.native.candidates(input)).every(
        (r) => ![a.id, b.id].includes(r.node.id),
      ),
    ).toBe(true);
    expect(await db.memoryGraph.native.expand(input, [a.id, b.id])).toEqual([]);
    expect(await db.memoryGraph.native.current(input, [b.id])).toEqual([]);
    expect(await db.memoryGraph.native.current(input, [c.id])).toHaveLength(1);
    expect(
      (
        await db.memoryGraph.native.personCandidates({ ...input, owners: [] })
      ).map((x) => x.summary.id),
    ).toEqual([other.id]);
    expect(prior.fixed.map((n) => n.id)).toContain(a.id);
    expect(
      (
        await db.memoryGraph.native.readFixed({
          ...input,
          cutoff: prior.cutoff!,
        })
      ).map((n) => n.id),
    ).toContain(a.id);
    await put(db, "split-identity", [], {
      invalidations: [
        { kind: "identity-split", targetId: "person:b", reason: "账号拆分" },
      ],
    });
    expect(
      await db.memoryGraph.native.personCandidates({ ...input, owners: [] }),
    ).toEqual([]);
  });
  it("pages over 100 revisions at a fixed upper without exposing co-published nodes", async () => {
    const db = await setup(create),
      n = node(1),
      secret = node(2);
    await put(db, "r1", [n, secret]);
    const hash = (
      await db.sql.query<{ input_hash: string }>(
        "SELECT input_hash FROM memory_native_publications WHERE operation_id='r1'",
      )
    ).rows[0]!.input_hash;
    for (let revision = 2; revision <= 105; revision++)
      await put(db, `r${revision}`, [
        {
          ...n,
          content: `修订${revision}`,
          metadata: { ...n.metadata, revision },
        },
      ]);
    let page = await db.memoryGraph.native.historyPage(n.id, { limit: 17 });
    const upper = page.upper;
    const revisions = page.items.map((r) => r.node.metadata.revision);
    await put(db, "r106", [
      { ...n, metadata: { ...n.metadata, revision: 106 } },
    ]);
    while (page.nextCursor) {
      page = await db.memoryGraph.native.historyPage(n.id, {
        limit: 17,
        cursor: page.nextCursor,
      });
      expect(page.upper).toBe(upper);
      expect(page.items.every((r) => r.node.id === n.id)).toBe(true);
      revisions.push(...page.items.map((r) => r.node.metadata.revision));
    }
    expect(revisions).toEqual(Array.from({ length: 105 }, (_, i) => 105 - i));
    expect(
      JSON.stringify(await db.memoryGraph.native.history(n.id)),
    ).not.toContain(secret.content);
    await db.prepareSchema();
    expect(
      (
        await db.sql.query<{ input_hash: string }>(
          "SELECT input_hash FROM memory_native_publications WHERE operation_id='r1'",
        )
      ).rows[0]!.input_hash,
    ).toBe(hash);
    expect(await put(db, "r1", [n, secret])).toEqual([n, secret]);
  }, 30000);
  it("merges and splits explicit evidence atomically and rejects scope or stale revision changes", async () => {
    const db = await setup(create);
    await source(db, "S1");
    await source(db, "S2");
    const experience = (n: number, sources: string[]): NativeMemoryNode => ({
      ...node(n, 1, sources),
      metadata: {
        ...node(n, 1, sources).metadata,
        kind: "experience",
        experience: {
          state: "open",
          policyVersion: "manual.v1",
          predecessors: [],
        },
      },
    });
    const e1 = experience(1, ["S1"]),
      e2 = experience(2, ["S2"]);
    await put(db, "initial", [e1, e2]);
    const archive = (n: NativeMemoryNode) => ({
      ...n,
      metadata: {
        ...n.metadata,
        revision: n.metadata.revision + 1,
        status: "archived" as const,
      },
    });
    const e3 = experience(3, ["S1", "S2"]);
    e3.metadata.experience!.predecessors = [e1.id, e2.id];
    const merge = {
      experienceOperation: {
        kind: "merge",
        inputIds: [e1.id, e2.id],
        outputIds: [e3.id],
      },
    };
    await expect(
      put(
        db,
        "private-merge",
        [
          archive(e1),
          archive(e2),
          { ...e3, metadata: { ...e3.metadata, scope: "other-private" } },
        ],
        merge,
      ),
    ).rejects.toThrow("memory_experience_scope");
    await put(db, "merge", [archive(e1), archive(e2), e3], merge);
    await expect(put(db, "stale", [archive(e1)])).rejects.toThrow(
      "memory_revision_conflict",
    );
    const e4 = experience(4, ["S1"]),
      e5 = experience(5, ["S2"]);
    e4.metadata.experience!.predecessors = [e3.id];
    e5.metadata.experience!.predecessors = [e3.id];
    await put(db, "split", [archive(e3), e4, e5], {
      experienceOperation: {
        kind: "split",
        inputIds: [e3.id],
        outputIds: [e4.id, e5.id],
      },
    });
    expect(
      (
        await db.memoryGraph.native.current(input, [
          e1.id,
          e2.id,
          e3.id,
          e4.id,
          e5.id,
        ])
      ).map((n) => n.id),
    ).toEqual([e4.id, e5.id]);
    expect(await db.memoryGraph.native.history(e1.id)).toHaveLength(2);
    const sealed = {
      ...e4,
      metadata: {
        ...e4.metadata,
        revision: 2,
        experience: { ...e4.metadata.experience!, state: "sealed" as const },
      },
    };
    await put(db, "seal", [sealed], {
      experienceOperation: {
        kind: "seal",
        inputIds: [e4.id],
        outputIds: [e4.id],
      },
    });
    await put(
      db,
      "reopen",
      [
        {
          ...sealed,
          metadata: {
            ...sealed.metadata,
            revision: 3,
            experience: { ...sealed.metadata.experience!, state: "open" },
          },
        },
      ],
      {
        experienceOperation: {
          kind: "reopen",
          inputIds: [e4.id],
          outputIds: [e4.id],
        },
      },
    );
  });
  it("keeps current read body counts independent of unrelated scope history", async () => {
    const db = await setup(create);
    await put(db, "visible", [node(1)]);
    const bodies: string[] = [];
    const instrument = (
      tx: import("./driver.js").SqlTransaction,
    ): import("./driver.js").SqlTransaction => ({
      exec: tx.exec.bind(tx),
      query: async (sql, values) => {
        const result = await tx.query(sql, values);
        for (const row of result.rows)
          if ("content" in row || "nodes" in row || "node" in row)
            bodies.push(JSON.stringify(row));
        return result as never;
      },
    });
    const measured = new KaguyaDatabase({
      query: instrument(db.sql).query,
      exec: db.sql.exec.bind(db.sql),
      close: async () => {},
      transaction: (run) => db.sql.transaction((tx) => run(instrument(tx))),
    });
    const access = createNativeMemoryAccess({
      enabled: true,
      store: measured.memoryGraph.native,
    });
    await access.freeze(input);
    const count = bodies.length;
    bodies.length = 0;
    for (let revision = 1; revision <= 30; revision++)
      await put(db, `foreign-${revision}`, [
        {
          ...node(9),
          content: "私聊正文不能随A群读取",
          metadata: { ...node(9).metadata, scope: "foreign-private", revision },
        },
      ]);
    await access.freeze(input);
    expect(bodies.length).toBe(count);
    expect(bodies.join("")).not.toContain("私聊正文");
    bodies.length = 0;
    await measured.memoryGraph.native.current(input, [id(1)]);
    expect(bodies).toHaveLength(1);
  }, 20000);
  it("blocks cross-scope proof chains and rejects laundering a withdrawn dependency", async () => {
    const db = await setup(create);
    await source(db, "dependency");
    await source(db, "new-evidence");
    const a = node(1, 0, ["new-evidence"]),
      b = { ...node(2), metadata: { ...node(2).metadata, scope: "private" } },
      c = {
        ...node(3, 1, ["dependency"]),
        metadata: { ...node(3, 1, ["dependency"]).metadata, scope: "private" },
      };
    await put(db, "chain", [a, b, c], {
      edges: [
        { sourceId: a.id, targetId: b.id, relation: "derived-from" },
        { sourceId: b.id, targetId: c.id, relation: "derived-from" },
      ],
    });
    const prior = await createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    }).freeze(input);
    await put(db, "withdraw-chain", [], {
      invalidations: [
        {
          kind: "source-withdrawal",
          targetId: "dependency",
          reason: "原话撤回",
        },
      ],
    });
    expect(await db.memoryGraph.native.readFixed(input)).toEqual([]);
    expect(await db.memoryGraph.native.forFormation(input)).toEqual([]);
    expect(
      (
        await db.memoryGraph.native.readFixed({
          ...input,
          cutoff: prior.cutoff!,
        })
      ).map((n) => n.id),
    ).toEqual([a.id]);
    await expect(
      db.memoryGraph.native.publish({
        operationId: "launder",
        actor: "automatic",
        nodes: [
          {
            node: {
              ...a,
              content: "去掉依赖后的旧结论",
              metadata: { ...a.metadata, revision: 2 },
            },
            expectedRevision: 1,
          },
        ],
        expectedVersions: { [b.id]: 1 },
        removeEdges: [
          { sourceId: a.id, targetId: b.id, relation: "derived-from" },
        ],
      }),
    ).rejects.toThrow("memory_source_invalidated");
  });
  it("does not resurrect a historical revision after its scope changes", async () => {
    const db = await setup(create);
    const n = node(1);
    await put(db, "old-scope", [n]);
    await put(db, "moved", [
      { ...n, metadata: { ...n.metadata, scope: "private", revision: 2 } },
    ]);
    const upper = await db.memoryGraph.native.cutoff(input);
    await put(db, "later", [node(2)]);
    expect(
      await db.memoryGraph.native.current({ ...input, cutoff: upper }, [n.id]),
    ).toEqual([]);
  });
  it("budgets newest pending corrections, marks truncation and preserves source handles", async () => {
    const db = await setup(create);
    for (let i = 0; i < 4; i++)
      await source(
        db,
        `pending-${i}`,
        i === 3 ? "最新更正" + "长".repeat(130000) : "旧".repeat(30000),
      );
    const frozen = await createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    }).freeze(input);
    expect(frozen.pendingEvidence![0]!.informationId).toBe("pending-3");
    expect(frozen.pendingEvidence![0]!.text).toContain("最新更正");
    expect(frozen.pendingEvidence!.every((e) => e.truncated)).toBe(true);
    expect(frozen.evidenceHasMore).toBe(true);
    expect(frozen.budget.dynamicCharacters).toBe(2000);
    expect(frozen.evidenceOmittedInformationIds).toEqual([
      "pending-1",
      "pending-0",
    ]);
    expect(frozen.pendingEvidence![0]!.originalCharacters).toBe(130004);
  });
  it("rejects missing Memory proof, private historical nodes and forged owners", async () => {
    const db = await setup(create);
    await source(db, "proof-source");
    await db.memoryGraph.native.recover();
    const batch = (await db.memoryGraph.native.claim(scope, true))!;
    const owner = batch.sources[0]!.ownerId;
    const secret = {
      ...node(1),
      metadata: { ...node(1).metadata, ownerId: owner, scope: "private-other" },
    };
    await put(db, "secret", [secret]);
    const snapshot = await createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    }).prepare({ ...input, owners: [owner] });
    const contract = {
      consumerId: "memory.native",
      policyVersion: "native-formation.v1",
      address: {
        platform: "qq",
        adapterId: "qq",
        destination: { kind: "group" as const, groupId: "G" },
      },
      kinds: ["memory.native.source.v1"],
      resultKind: "memory.native.observation.completed.v1",
    };
    await expect(db.observations.freezeNext(contract)).rejects.toThrow(
      "Observation contract",
    );
    await db.information.synchronizeKinds([
      "memory.native.formation.requested.v1",
    ]);
    for (const [i, existing] of [
      {
        ...snapshot,
        recalled: [{ node: secret, traces: [], truncated: false }],
      },
      { ...snapshot, owners: [owner, "person:forged"] },
    ].entries()) {
      const requestId = `request-proof-${i}`,
        payload = {
          batchId: batch.id,
          scope,
          sources: batch.sources,
          existing,
        };
      await db.information.append(
        freezeInformationAtom(
          informationAtomSchema.parse({
            informationId: requestId,
            kind: "memory.native.formation.requested.v1",
            source: "test:memory",
            occurredAt: "2026-01-01T00:00:00Z",
            payload,
            references: [],
          }),
        ),
        [],
      );
      const manifest = observationManifestSchema.parse({
        version: 1,
        proofKind: "memory-native",
        runInformationId: requestId,
        frozenInformationId: requestId,
        sourceInformationIds: ["memory-native-source:proof-source"],
        knowledgeCutoff: {
          informationId: requestId,
          memoryPublicationPosition: existing.cutoff!.publicationPosition,
          memoryRevisions: existing.recalled.map((r) => ({
            id: r.node.id,
            revision: r.node.metadata.revision,
          })),
        },
        content: payload,
      });
      await expect(
        db.observations.freezeNext({ ...contract, manifest }),
      ).rejects.toThrow("Observation contract");
    }
  });
});

it.skipIf(!url)(
  "freezes a committed Memory prefix while an earlier position is uncommitted (real PostgreSQL)",
  async () => {
    const db = await setup(() => createPostgresTestingDatabase(url!));
    const n = node(1);
    await put(db, "baseline", [n]);
    let release!: () => void,
      entered = false;
    const gate = new Promise<void>((r) => (release = r));
    const wrapped: SqlDatabase = {
      query: db.sql.query.bind(db.sql),
      exec: db.sql.exec.bind(db.sql),
      close: async () => {},
      transaction: (run) =>
        db.sql.transaction(async (tx) => {
          const result = await run(tx);
          entered = true;
          await gate;
          return result;
        }),
    };
    const writer = new KaguyaDatabase(wrapped);
    const pending = put(writer, "blocked", [
      { ...n, content: "未提交更正", metadata: { ...n.metadata, revision: 2 } },
    ]);
    let publicationError: unknown;
    void pending.catch((error) => {
      publicationError = error;
    });
    try {
      await vi.waitFor(
        () => {
          if (publicationError) throw publicationError;
          expect(entered).toBe(true);
        },
        { timeout: 8000, interval: 20 },
      );
      const access = createNativeMemoryAccess({
        enabled: true,
        store: db.memoryGraph.native,
      });
      const frozen = await access.freeze(input);
      await source(db, "later-K");
      const k = (
        await db.sql.query<{ position: string }>(
          "SELECT position::text FROM information_lifecycle WHERE information_id='later-K'",
        )
      ).rows[0]!.position;
      expect(BigInt(k)).toBeGreaterThan(
        BigInt(frozen.cutoff!.publicationPosition),
      );
      release();
      await pending;
      expect(
        (
          await db.memoryGraph.native.current(
            { ...input, cutoff: frozen.cutoff! },
            [n.id],
          )
        )[0]!.content,
      ).toBe(n.content);
      expect(
        (await access.freeze(input)).fixed
          .concat((await access.freeze(input)).recalled.map((r) => r.node))
          .some((n) => n.content === "未提交更正"),
      ).toBe(true);
      const cursor = Buffer.from(
        JSON.stringify({
          nodeId: n.id,
          upper: frozen.cutoff!.publicationPosition,
          before: k,
        }),
      ).toString("base64url");
      expect(
        (await db.memoryGraph.native.historyPage(n.id, { cursor })).items.map(
          (r) => r.node.metadata.revision,
        ),
      ).toEqual([1]);
    } finally {
      release();
      await pending;
    }
  },
  20000,
);

describe.each(backends)("native inherited evidence ($name)", ({ create }) => {
  it("preserves transitive merge evidence and excludes inherited archive status", async () => {
    const db = await setup(create);
    for (const s of ["S1", "S2", "S3"]) await source(db, s);
    const experience = (n: number, sources: string[]): NativeMemoryNode => ({
      ...node(n, 1, sources),
      metadata: {
        ...node(n, 1, sources).metadata,
        kind: "experience",
        experience: {
          state: "open",
          policyVersion: "manual.v1",
          predecessors: [],
        },
      },
    });
    const a = experience(1, ["S1"]),
      b = experience(2, ["S3"]),
      c = node(3, 2, ["S2"]);
    await put(db, "inputs", [a, b, c], {
      edges: [{ sourceId: a.id, targetId: c.id, relation: "derived-from" }],
    });
    const archive = (n: NativeMemoryNode) => ({
      ...n,
      metadata: { ...n.metadata, revision: 2, status: "archived" as const },
    });
    const d = experience(4, ["S1", "S3"]);
    d.metadata.experience!.predecessors = [a.id, b.id];
    const op = {
      experienceOperation: {
        kind: "merge",
        inputIds: [a.id, b.id],
        outputIds: [d.id],
      },
    };
    await expect(
      put(db, "missing-proof", [archive(a), archive(b), d], op),
    ).rejects.toThrow("memory_experience_sources");
    d.metadata.sourceIds = ["S1", "S2", "S3"];
    await put(db, "merged", [archive(a), archive(b), d], op);
    expect(await db.memoryGraph.native.current(input, [d.id])).toHaveLength(1);
    const upper = await db.memoryGraph.native.cutoff(input);
    await put(db, "withdraw-inherited", [], {
      invalidations: [
        { kind: "source-withdrawal", targetId: "S2", reason: "撤回间接证据" },
      ],
    });
    expect(await db.memoryGraph.native.current(input, [d.id])).toEqual([]);
    expect(
      await db.memoryGraph.native.current({ ...input, cutoff: upper }, [d.id]),
    ).toHaveLength(1);
  });
  it.each(["source-withdrawal", "identity-split"] as const)(
    "keeps the unrelated split branch after %s, including historical reads",
    async (kind) => {
      const db = await setup(create);
      await source(db, "split-S1");
      await source(db, "split-S2");
      const experience = (n: number, sources: string[]): NativeMemoryNode => ({
        ...node(n, 1, sources),
        metadata: {
          ...node(n, 1, sources).metadata,
          kind: "experience",
          experience: {
            state: "open",
            policyVersion: "manual.v1",
            predecessors: [],
          },
        },
      });
      const e = experience(1, ["split-S1", "split-S2"]),
        dependency = {
          ...node(3, 2, ["split-S1"]),
          metadata: {
            ...node(3, 2, ["split-S1"]).metadata,
            ownerId: "person:dependency",
          },
        };
      await put(db, "split-root", [e, dependency], {
        edges: [
          { sourceId: e.id, targetId: dependency.id, relation: "derived-from" },
        ],
      });
      const access = createNativeMemoryAccess({
          enabled: true,
          store: db.memoryGraph.native,
        }),
        before = await access.freeze(input);
      const x = experience(4, ["split-S1"]),
        y = experience(5, ["split-S2"]);
      x.metadata.experience!.predecessors = [e.id];
      y.metadata.experience!.predecessors = [e.id];
      await put(
        db,
        "split-branches",
        [
          {
            ...e,
            metadata: { ...e.metadata, revision: 2, status: "archived" },
          },
          x,
          y,
        ],
        {
          experienceOperation: {
            kind: "split",
            inputIds: [e.id],
            outputIds: [x.id, y.id],
          },
        },
      );
      const frozen = await access.freeze({
          ...input,
          explicitIds: [x.id, y.id],
        }),
        saved = JSON.stringify(frozen);
      const actual = await db.memoryGraph.native.current(input, [x.id, y.id]);
      expect(actual).toHaveLength(2);
      expect(
        actual.find((n) => n.id === x.id)!.metadata.experience!.proofOwners,
      ).toContainEqual({
        ownerId: "person:dependency",
        sourceIds: ["split-S1"],
      });
      expect(
        actual
          .find((n) => n.id === y.id)!
          .metadata.experience!.proofOwners!.some(
            (p) => p.ownerId === "person:dependency",
          ),
      ).toBe(false);
      await put(db, "split-invalidate", [], {
        invalidations: [
          {
            kind,
            targetId:
              kind === "source-withdrawal" ? "split-S1" : "person:dependency",
            reason: "一侧证据失效",
          },
        ],
      });
      expect(
        (await db.memoryGraph.native.current(input, [x.id, y.id])).map(
          (n) => n.id,
        ),
      ).toEqual([y.id]);
      const upper = await db.memoryGraph.native.cutoff(input);
      await put(db, "later-irrelevant", [node(8)]);
      expect(
        (
          await db.memoryGraph.native.current({ ...input, cutoff: upper }, [
            x.id,
            y.id,
          ])
        ).map((n) => n.id),
      ).toEqual([y.id]);
      expect(
        (
          await db.memoryGraph.native.current(
            { ...input, cutoff: frozen.cutoff! },
            [x.id, y.id],
          )
        ).map((n) => n.id),
      ).toEqual([x.id, y.id]);
      expect(
        (
          await db.memoryGraph.native.current(
            { ...input, cutoff: before.cutoff! },
            [e.id],
          )
        )[0]!.metadata.revision,
      ).toBe(1);
      expect(JSON.stringify(frozen)).toBe(saved);
    },
  );
  it("keeps delivered pending evidence attributed to self before normalization", async () => {
    const db = await setup(create),
      destination = { kind: "group", groupId: "G" };
    await db.information.synchronizeKinds([
      "core.delivery.requested",
      "core.delivery.delivered",
    ]);
    const append = async (
      informationId: string,
      kind: string,
      payload: unknown,
      delivered = false,
    ) =>
      db.information.append(
        freezeInformationAtom(
          informationAtomSchema.parse({
            informationId,
            kind,
            payload,
            occurredAt: "2020-01-01T00:00:00Z",
            source: "test:memory",
            references: delivered
              ? [
                  {
                    relation: "core:status-of",
                    informationId: "delivery-request",
                  },
                ]
              : [],
          }),
        ),
        delivered
          ? [{ relation: "core:status-of", required: true, multiple: false }]
          : [],
      );
    await append("delivery-request", "core.delivery.requested", {
      platform: "qq",
      adapterId: "qq",
      destination,
      message: { text: "我会准备材料" },
    });
    await append(
      "delivered",
      "core.delivery.delivered",
      { platform: "qq", adapterId: "qq", target: destination, ok: true },
      true,
    );
    const frozen = await createNativeMemoryAccess({
      enabled: true,
      store: db.memoryGraph.native,
    }).freeze(input);
    expect(frozen.pendingEvidence).toMatchObject([
      {
        informationId: "delivered",
        ownerId: "self:kaguya",
        text: "自身已经发出的消息（不代表已完成其中承诺的行动）：我会准备材料",
      },
    ]);
    await db.memoryGraph.native.recover();
    expect(
      (await db.memoryGraph.native.claim(scope, true))!.sources[0],
    ).toMatchObject({
      id: "delivered",
      ownerId: "self:kaguya",
      sourceType: "delivered",
    });
  });
  it("keeps future occurredAt outside asOf while accepting newly registered earlier evidence", async () => {
    const db = await setup(create),
      access = createNativeMemoryAccess({
        enabled: true,
        store: db.memoryGraph.native,
      });
    await source(db, "before", "此前证据", "2029-12-31T23:59:59Z");
    const frozen = await access.freeze(input);
    await source(db, "future", "下一秒的原话", "2030-01-01T00:00:01Z");
    await source(db, "late", "晚登记的较早更正", "2029-12-31T23:59:58Z");
    const current = await access.freeze(input);
    expect(current.pendingEvidence!.map((e) => e.informationId)).toEqual([
      "late",
      "before",
    ]);
    expect(frozen.pendingEvidence!.map((e) => e.informationId)).toEqual([
      "before",
    ]);
    expect(
      (
        await access.freeze({ ...input, asOf: "2030-01-01T00:00:02Z" })
      ).pendingEvidence!.map((e) => e.informationId),
    ).toContain("future");
  });
});
