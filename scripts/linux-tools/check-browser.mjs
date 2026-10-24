/**
 * 功能概述：真实 Chromium DOM provider 专项，使用独立本机站点与持久提交计数作 oracle。
 * 代码库关系：直接消费生产 ToolService/BrowserComponent；W6 外层租约与 journal 另由 broker 验证。
 * 输入输出与副作用：仅 /private 合成 profile/下载/计数；finally 独立关闭 owner 与 HTTP server。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, open, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { BrowserComponent } from "./browser.mjs";
import { ToolService } from "./service.mjs";

const csv = "name,value\nkaguya,42\n";
const ledgerPath = "/private/browser-site-ledger.json";
let submissions = 0;
const persist = async () => {
  await writeFile(ledgerPath, JSON.stringify({ submissions }) + "\n");
  const file = await open(ledgerPath, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
};
const server = createServer(async (request, response) => {
  if (request.url === "/submit" && request.method === "POST") {
    for await (const _ of request) {
      /* drain the synthetic body */
    }
    submissions++;
    await persist();
    response.setHeader("content-type", "text/plain");
    response.end(String(submissions));
  } else if (request.url === "/file.csv") {
    response.writeHead(200, {
      "content-type": "text/csv",
      "content-disposition": 'attachment; filename="actual.csv"',
    });
    response.end(csv);
  } else {
    response.setHeader("content-type", "text/html");
    response.end(
      '<input aria-label="unsaved"><button id="submit">submit once</button><output id="count">0</output><output id="nonce">' +
        randomUUID() +
        '</output><a href="/file.csv">download CSV</a><script>submit.onclick=async()=>{count.textContent=await(await fetch("/submit",{method:"POST",body:document.querySelector("input").value})).text()}</script>',
    );
  }
});
await persist();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = "http://127.0.0.1:" + server.address().port;
const component = new BrowserComponent({ root: "/private/browser-proof" });
const service = new ToolService({
  environmentId: "proof",
  generation: 0,
  components: [component],
});
let generation = 0;
const operation = (toolName, args, ttl = 30) => {
  const id = randomUUID(),
    expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const environment = {
    environmentId: "proof",
    generation,
    leaseId: "lease-" + generation,
    workflowId: "flow",
    fencing: String(generation + 1),
  };
  return service.handle({
    helperProtocolVersion: 1,
    kind: "operation",
    toolName,
    arguments: args,
    environment,
    scope: "ci",
    operationId: id,
    attemptId: id,
    digest: id,
    deadline: expiresAt,
    permit: {
      ...environment,
      expiresAt,
      operationId: id,
      attemptId: id,
      digest: id,
    },
  });
};
const observe = async () => (await operation("browser.observe", {})).result;
const until = async (read, predicate, seconds = 10) => {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (true) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() >= deadline)
      throw new Error("browser-condition-timeout:" + JSON.stringify(last));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const node = (state, name) => {
  const found = state.nodes.find((item) => item.name === name);
  assert.ok(found, name);
  return found.id;
};
let primary;
try {
  await service.ready();
  const initial = await observe();
  const navigate = await operation("browser.act", {
    observation: initial.observation,
    action: "navigate",
    url: address,
  });
  assert.equal(navigate.result.dispatched, true);
  let current = await until(observe, (state) =>
    state.nodes.some((item) => item.name === "unsaved"),
  );
  const target = current.pageId,
    nonce = current.nodes.find(
      (item) => item.tag === "output" && item.text !== "0",
    ).text;
  const fill = await operation("browser.act", {
    observation: current.observation,
    action: "fill",
    nodeId: node(current, "unsaved"),
    value: "retain-me",
  });
  assert.equal(fill.result.dispatched, true);
  current = await observe();
  assert.equal(
    current.nodes.find((item) => item.name === "unsaved").value,
    "retain-me",
  );
  const clickedFrom = current.observation;
  const click = await operation("browser.act", {
    observation: clickedFrom,
    action: "click",
    nodeId: node(current, "submit once"),
  });
  assert.equal(click.result.dispatched, true);
  await assert.rejects(
    operation("browser.act", {
      observation: clickedFrom,
      action: "click",
      nodeId: node(current, "submit once"),
    }),
    /stale/,
  );
  current = await until(observe, (state) =>
    state.nodes.some((item) => item.tag === "output" && item.text === "1"),
  );
  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).submissions, 1);
  const count = current.nodes.find(
    (item) => item.tag === "output" && item.text === "1",
  );
  const verify = await operation("browser.verify", {
    mode: "page",
    original: click.result.original,
    observation: current.observation,
    expectation: { kind: "text", nodeId: count.id, equals: "1" },
  });
  assert.equal(verify.evidence, "verified");
  assert.equal(verify.result.matched, true);
  const download = await operation("browser.act", {
    observation: current.observation,
    action: "click",
    nodeId: node(current, "download CSV"),
  });
  assert.equal(download.result.dispatched, true);
  current = await until(observe, (state) =>
    state.downloads.some((item) => item.state === "completed"),
  );
  const file = current.downloads.find((item) => item.state === "completed");
  assert.equal(file.sha256, createHash("sha256").update(csv).digest("hex"));
  const exported = await operation("browser.verify", {
    mode: "download",
    original: download.result.original,
    observation: current.observation,
    downloadId: file.id,
    sha256: file.sha256,
  });
  assert.equal(
    Buffer.from(exported.artifacts[0].dataBase64, "base64").toString(),
    csv,
  );
  const before = component.identity();
  const handoff = {
    helperProtocolVersion: 1,
    kind: "control",
    action: "handoff",
    environmentId: "proof",
    expectedGeneration: 0,
    generation: 1,
    mode: "human",
    controlOperationId: randomUUID(),
  };
  const ack = await service.handle(handoff);
  assert.equal(ack.automationIsolated, true);
  assert.deepEqual(await service.handle(handoff), ack);
  assert.deepEqual(component.identity(), before);
  generation = 1;
  await assert.rejects(operation("browser.observe", {}), /tool-not-supported/);
  await service.handle({
    ...handoff,
    expectedGeneration: 1,
    generation: 2,
    mode: "automation",
    controlOperationId: randomUUID(),
  });
  generation = 2;
  await assert.rejects(
    operation("browser.act", {
      observation: current.observation,
      action: "click",
      nodeId: node(current, "submit once"),
    }),
    /stale/,
  );
  current = await observe();
  assert.equal(current.pageId, target);
  assert.equal(
    current.nodes.find((item) => item.name === "unsaved").value,
    "retain-me",
  );
  assert.ok(current.nodes.some((item) => item.text === nonce));
  assert.equal(JSON.parse(await readFile(ledgerPath, "utf8")).submissions, 1);
  console.log(
    JSON.stringify({
      browser: component.identity(),
      submissions,
      download: file,
      handoff: ack,
      retainedTarget: target,
      unsavedValueRetained: true,
      domNonceRetained: true,
    }),
  );
} catch (error) {
  primary = error;
}
const cleanup = await Promise.allSettled([
  component.close(),
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  ),
]);
const failures = cleanup
  .filter((item) => item.status === "rejected")
  .map((item) => item.reason);
if (primary || failures.length)
  throw new AggregateError(
    [...(primary ? [primary] : []), ...failures],
    "browser proof failed",
  );
