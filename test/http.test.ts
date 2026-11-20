import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/index.js';
import type { ChangeProposal } from '../src/domain/types.js';

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mapping-http-'));
  app = await buildApp(join(dir, 'db.json'));
  await app.inject({ method: 'POST', url: '/api/sources', payload: { id: 'src_a', name: '来源A' } });
});

after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await app.close();
});

async function post(url: string, payload: object) {
  return app.inject({ method: 'POST', url, payload });
}

test('完整 HTTP 流程：发现 -> 阻断裁决 -> 并行双审批 -> 发布 -> 重放 -> 回滚', async () => {
  // 1. 初始发现并发布 v1
  let r = await post('/api/sources/src_a/discovery', {
    observed: [
      { sourceField: 'order_id', type: 'string' },
      { sourceField: 'amount', type: 'number', enumValues: [] },
    ],
    requiredApprovals: 1,
  });
  assert.equal(r.statusCode, 201);
  const v1Change = r.json<{ proposal: ChangeProposal }>().proposal;
  r = await post(`/api/changes/${v1Change.id}/approve`, { approver: 'alice' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json<ChangeProposal>().status, 'published');

  // 2. 上报缩窄类型 + 字段消失 -> 阻断单
  r = await post('/api/sources/src_a/discovery', { observed: [{ sourceField: 'order_id', type: 'string' }] });
  assert.equal(r.statusCode, 201);
  const blocked = r.json<{ proposal: ChangeProposal }>().proposal;
  assert.ok(blocked.ops.some((o) => o.analysis.level === 'blocked'));

  // 3. 阻断状态下审批 => 422
  r = await post(`/api/changes/${blocked.id}/approve`, { approver: 'alice' });
  assert.equal(r.statusCode, 422);

  // 4. 全部切兼容模式
  for (let i = 0; i < blocked.ops.length; i++) {
    const rr = await post(`/api/changes/${blocked.id}/compat`, { opIndex: i, compatMode: true });
    assert.equal(rr.statusCode, 200);
  }

  // 5. 并行双审批（requiredApprovals 默认 2）：两个请求同时发出
  const [a, b] = await Promise.all([
    post(`/api/changes/${blocked.id}/approve`, { approver: 'alice' }),
    post(`/api/changes/${blocked.id}/approve`, { approver: 'bob' }),
  ]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  const finalChange = a.json<ChangeProposal>().status === 'published' ? a.json() : b.json();
  assert.equal(finalChange.status, 'published');

  // 6. 重复审批（已发布）=> 409
  r = await post(`/api/changes/${blocked.id}/approve`, { approver: 'carol' });
  assert.equal(r.statusCode, 409);

  // 7. 版本时间轴 + 重放：用 v1 生效时刻重放含 amount 的旧数据
  const versions = (await app.inject('/api/sources/src_a/versions')).json<Array<{ version: number; effectiveAt: number }>>();
  assert.equal(versions.length, 2);
  const replay = await post('/api/sources/src_a/replay', {
    records: [{ order_id: 'o-1', amount: 9.9 }],
    at: versions[0]!.effectiveAt + 1,
  });
  assert.equal(replay.statusCode, 200);
  const replayBody = replay.json();
  assert.equal(replayBody.usedVersion, 1);
  assert.equal(replayBody.mapped[0].amount, 9.9);

  // 8. 回滚到 v1
  const rollback = await post('/api/sources/src_a/rollback', { toVersion: 1, actor: 'ops', note: '紧急回滚演练' });
  assert.equal(rollback.statusCode, 201);
  assert.equal(rollback.json().version.version, 3);
  assert.equal(rollback.json().version.rolledBackFromVersion, 1);

  // 9. 批次审计
  const batches = (await app.inject('/api/batches')).json();
  assert.ok(batches.length >= 3);

  // 10. 差异视图
  const diff = await app.inject('/api/sources/src_a/diff?from=1&to=2');
  assert.equal(diff.statusCode, 200);
});

test('并行相同审批人请求只有一个成功，审批计数不重复', async () => {
  const r = await post('/api/sources/src_a/discovery', {
    observed: [{ sourceField: 'x', type: 'string' }],
    requiredApprovals: 2,
  });
  const change = r.json<{ proposal: ChangeProposal }>().proposal;

  const results = await Promise.all([
    post(`/api/changes/${change.id}/approve`, { approver: 'alice' }),
    post(`/api/changes/${change.id}/approve`, { approver: 'alice' }),
    post(`/api/changes/${change.id}/approve`, { approver: 'alice' }),
  ]);
  const ok = results.filter((x) => x.statusCode === 200);
  const conflict = results.filter((x) => x.statusCode === 409);
  assert.equal(ok.length, 1);
  assert.equal(conflict.length, 2);

  const fresh = (await app.inject(`/api/changes/${change.id}`)).json<ChangeProposal>();
  assert.equal(fresh.approvals.length, 1);
  assert.equal(fresh.status, 'pending');
});

test('重复发布：幂等键相同返回原批次，不同键返回 409；定时到期可发布', async () => {
  const r = await post('/api/sources/src_a/proposals', {
    title: '定时单',
    ops: [{ kind: 'add', sourceField: 'sched', type: 'string' }],
    effectiveAt: Date.now() + 3600_000,
    requiredApprovals: 1,
  });
  const change = r.json<ChangeProposal>();
  await post(`/api/changes/${change.id}/approve`, { approver: 'alice' });
  assert.equal((await app.inject(`/api/changes/${change.id}`)).json<ChangeProposal>().status, 'scheduled');

  // 未到期发布 => 412
  let pr = await post(`/api/changes/${change.id}/publish`, { actor: 'ops', idempotencyKey: 'k1' });
  assert.equal(pr.statusCode, 412);

  // 模拟到期后由调度器发布
  const store = (app as unknown as { store: { read: () => { changes: ChangeProposal[] } } }).store;
  store.read().changes.find((c) => c.id === change.id)!.effectiveAt = Date.now() - 1;
  const tick = await post('/api/scheduler/tick', {});
  assert.equal(tick.statusCode, 200);
  assert.equal(tick.json().published.length, 1);

  // 已发布后再次发布：
  //  - 未使用过的键 => 事后补绑并返回原批次（200，重试安全）
  pr = await post(`/api/changes/${change.id}/publish`, { actor: 'ops', idempotencyKey: 'k1' });
  assert.equal(pr.statusCode, 200);
  const fresh = (await app.inject(`/api/changes/${change.id}`)).json<ChangeProposal>();
  assert.equal(pr.json().batch.id, fresh.publishedBatchId); // 返回原批次
  //  - 同键重放 => 仍然是原批次
  const replay = await post(`/api/changes/${change.id}/publish`, { actor: 'ops', idempotencyKey: 'k1' });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().batch.id, fresh.publishedBatchId);
  //  - 无键 => 409
  const noKey = await post(`/api/changes/${change.id}/publish`, { actor: 'ops' });
  assert.equal(noKey.statusCode, 409);

  // 另一个定时单：审批后进入 scheduled，显式发布时占用 k2
  const other = await post('/api/sources/src_a/proposals', {
    title: '第二个单',
    ops: [{ kind: 'add', sourceField: 'other', type: 'string' }],
    requiredApprovals: 1,
    effectiveAt: Date.now() + 3600_000,
  });
  const otherChange = other.json<ChangeProposal>();
  await post(`/api/changes/${otherChange.id}/approve`, { approver: 'alice' });
  // 到期后用 k2 发布
  store.read().changes.find((c) => c.id === otherChange.id)!.effectiveAt = Date.now() - 1;
  const pub2 = await post(`/api/changes/${otherChange.id}/publish`, { actor: 'ops', idempotencyKey: 'k2' });
  assert.equal(pub2.statusCode, 200);
  // 再拿已被其他批次占用的 k2 重试本单 => 409
  const foreignKey = await post(`/api/changes/${change.id}/publish`, { actor: 'ops', idempotencyKey: 'k2' });
  assert.equal(foreignKey.statusCode, 409);
});

test('校验错误返回 400，来源不存在返回 404', async () => {
  const bad = await post('/api/sources/nope/discovery', { observed: [] });
  assert.equal(bad.statusCode, 400); // observed 为空先触发 schema
  const notFound = await app.inject('/api/sources/nope/versions');
  assert.equal(notFound.statusCode, 404);
});
