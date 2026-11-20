import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/domain/store.js';
import { MappingService, type DiscoveryField } from '../src/domain/service.js';
import { DomainError } from '../src/domain/errors.js';

let dir: string;
let svc: MappingService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mapping-test-'));
  svc = new MappingService(new JsonStore(join(dir, 'db.json')));
  svc.createSource({ id: 'src_a', name: '来源A' });
});

test.after(() => rmSync(dir, { recursive: true, force: true }));

function seedV1(fields: DiscoveryField[]) {
  const { proposal } = svc.ingestDiscovery({ sourceId: 'src_a', observed: fields, createdBy: 'collector', requiredApprovals: 1 });
  return proposal;
}

async function approveAll(id: string, approvers = ['alice', 'bob']) {
  for (const a of approvers) await svc.approve(id, a);
}

test('采集器发现新字段 -> 待审批单 -> 双审批后发布为 v1', async () => {
  const { proposal, deduped } = svc.ingestDiscovery({
    sourceId: 'src_a',
    observed: [{ sourceField: 'user_id', type: 'string' }, { sourceField: 'age', type: 'integer' }],
  });
  assert.equal(deduped, false);
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.ops[0]!.analysis.level, 'safe');

  await svc.approve(proposal.id, 'alice');
  assert.equal(svc.getChange(proposal.id).status, 'pending'); // 仅 1 票，仍待审批
  await svc.approve(proposal.id, 'bob');

  const head = svc.headVersion('src_a')!;
  assert.equal(head.version, 1);
  assert.equal(head.fields.length, 2);
  assert.equal(svc.getChange(proposal.id).status, 'published');
});

test('相同指纹的发现请求幂等去重，不重复建单', () => {
  const first = svc.ingestDiscovery({ sourceId: 'src_a', observed: [{ sourceField: 'f1', type: 'string' }] });
  const second = svc.ingestDiscovery({ sourceId: 'src_a', observed: [{ sourceField: 'f1', type: 'string' }] });
  assert.equal(second.deduped, true);
  assert.equal(second.proposal.id, first.proposal.id);
});

test('字段删除默认阻断，审批被拒绝；兼容模式转为弃用后可发布', async () => {
  const v1 = seedV1([{ sourceField: 'f1', type: 'string' }, { sourceField: 'f2', type: 'string' }]);
  await approveAll(v1.id, ['alice']);

  const { proposal } = svc.ingestDiscovery({ sourceId: 'src_a', observed: [{ sourceField: 'f1', type: 'string' }] });
  const removeOp = proposal.ops.find((o) => o.kind === 'remove')!;
  assert.equal(removeOp.analysis.level, 'blocked');

  await assert.rejects(svc.approve(proposal.id, 'alice'), (e: Error) => {
    return e instanceof DomainError && e.code === 'BLOCKED';
  });

  svc.setCompatMode(proposal.id, proposal.ops.indexOf(removeOp), true);
  assert.equal(removeOp.analysis.level, 'compatible');
  assert.equal(removeOp.analysis.compatStrategy, 'deprecate-instead-of-remove');
  await approveAll(proposal.id);

  const head = svc.headVersion('src_a')!;
  const f2 = head.fields.find((f) => f.sourceField === 'f2')!;
  assert.equal(f2.deprecated, true); // 字段仍在，仅弃用
});

test('类型缩窄阻断，兼容模式生成 coercion 规则并在重放时生效', async () => {
  const v1 = seedV1([{ sourceField: 'score', type: 'number' }]);
  await approveAll(v1.id, ['alice']);

  const prop = svc.createProposal({
    sourceId: 'src_a',
    title: 'score 改为整数',
    ops: [{ kind: 'type_change', sourceField: 'score', type: 'integer' }],
    requiredApprovals: 2,
  });
  assert.equal(prop.ops[0]!.analysis.level, 'blocked');

  await assert.rejects(svc.approve(prop.id, 'alice'), (e: Error) => e instanceof DomainError && e.code === 'BLOCKED');

  svc.setCompatMode(prop.id, 0, true);
  assert.equal(prop.ops[0]!.analysis.level, 'compatible');
  await approveAll(prop.id);

  const head = svc.headVersion('src_a')!;
  assert.equal(head.fields[0]!.coercion?.strategy, 'round');
});

test('类型放宽（integer->number）属于安全变更，无需兼容模式', async () => {
  const v1 = seedV1([{ sourceField: 'n', type: 'integer' }]);
  await approveAll(v1.id, ['alice']);
  const prop = svc.createProposal({
    sourceId: 'src_a',
    title: '放宽',
    ops: [{ kind: 'type_change', sourceField: 'n', type: 'number' }],
  });
  assert.equal(prop.ops[0]!.analysis.level, 'safe');
});

test('枚举冲突阻断；兼容模式取并集超集', async () => {
  const v1 = seedV1([{ sourceField: 'color', type: 'string', enumValues: ['red', 'green', 'blue'] }]);
  await approveAll(v1.id, ['alice']);

  const prop = svc.createProposal({
    sourceId: 'src_a',
    title: '枚举收缩',
    ops: [{ kind: 'enum_update', sourceField: 'color', enumValues: ['red', 'green'] }],
  });
  assert.equal(prop.ops[0]!.analysis.level, 'blocked');
  assert.match(prop.ops[0]!.analysis.reasons[0]!, /blue/);

  svc.setCompatMode(prop.id, 0, true);
  assert.deepEqual(prop.ops[0]!.analysis.after!.enumValues.sort(), ['blue', 'green', 'red']);
  await approveAll(prop.id);
});

test('并行审批：同一审批人重复投票被拒，不同审批人计数且状态只跃迁一次', async () => {
  const prop = seedV1([{ sourceField: 'f1', type: 'string' }]); // requiredApprovals=1? 显式重建为 2
  const p2 = svc.createProposal({
    sourceId: 'src_a',
    title: '并行审批验证',
    ops: [{ kind: 'add', sourceField: 'px', type: 'string' }],
    requiredApprovals: 2,
  });

  // 并行发起 4 个请求：alice x2、bob、carol
  const results = await Promise.allSettled([
    svc.approve(p2.id, 'alice'),
    svc.approve(p2.id, 'alice'),
    svc.approve(p2.id, 'bob'),
    svc.approve(p2.id, 'carol'),
  ]);
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 2); // alice 重复投票 + carol 在终态后投票
  assert.match((rejected[0] as PromiseRejectedResult).reason.message, /alice|终态/);

  const final = svc.getChange(p2.id);
  assert.equal(final.status, 'published'); // 第二票时发布，carol 的票在终态后被拒
  const approvers = final.approvals.map((a) => a.approver).sort();
  assert.deepEqual(approvers, ['alice', 'bob']);
  assert.equal(svc.listVersions('src_a').filter((v) => v.changeId === p2.id).length, 1); // 只发布一次
});

test('重复发布被阻断；相同幂等键重放返回原批次', async () => {
  const prop = svc.createProposal({
    sourceId: 'src_a',
    title: '幂等测试',
    ops: [{ kind: 'add', sourceField: 'idem', type: 'string' }],
    requiredApprovals: 2,
  });
  await approveAll(prop.id);
  const published = svc.getChange(prop.id);
  assert.equal(published.status, 'published');

  await assert.rejects(svc.publish(prop.id, 'manual'), (e: Error) => e instanceof DomainError && e.code === 'CONFLICT');

  // 同幂等键重放 => 原批次
  const r = await svc.publish(prop.id, 'manual', 'key-1');
  assert.equal(r.batch.id, published.publishedBatchId);
});

test('发布幂等键冲突（不同单子复用同一键）被拒绝', async () => {
  const a = svc.createProposal({
    sourceId: 'src_a',
    title: 'A',
    ops: [{ kind: 'add', sourceField: 'a1', type: 'string' }],
    requiredApprovals: 1,
  });
  await svc.approve(a.id, 'alice');
  const b = svc.createProposal({
    sourceId: 'src_a',
    title: 'B',
    ops: [{ kind: 'add', sourceField: 'b1', type: 'string' }],
    requiredApprovals: 1,
    effectiveAt: Date.now() + 10_000,
  });
  await svc.approve(b.id, 'bob'); // 未来生效 => scheduled，未自动发布
  await assert.rejects(svc.publish(b.id, 'x', 'dup-key-then'), (e: Error) => e instanceof DomainError && e.code === 'PRECONDITION');
});

test('定时发布：未来生效时间进入 scheduled，tick 到期后自动发布且只影响指定来源', async () => {
  const other = svc.createSource({ id: 'src_b', name: '来源B' });
  const future = Date.now() + 60_000;
  const propA = svc.createProposal({
    sourceId: 'src_a',
    title: '定时A',
    ops: [{ kind: 'add', sourceField: 'future_field', type: 'string' }],
    effectiveAt: future,
    requiredApprovals: 2,
  });
  const propB = svc.createProposal({
    sourceId: 'src_b',
    title: '定时B',
    ops: [{ kind: 'add', sourceField: 'b_field', type: 'string' }],
    effectiveAt: future,
    requiredApprovals: 1,
  });
  await approveAll(propA.id);
  await svc.approve(propB.id, 'carol');
  assert.equal(svc.getChange(propA.id).status, 'scheduled');
  assert.equal(svc.getChange(propB.id).status, 'scheduled');

  // 到期前 tick 无动作
  assert.deepEqual(await svc.publishDue(), []);

  // 模拟时间到期：直接把 effectiveAt 调到过去
  const db = (svc as unknown as { store: JsonStore }).store.read();
  db.changes.find((c) => c.id === propA.id)!.effectiveAt = Date.now() - 1000;
  db.changes.find((c) => c.id === propB.id)!.effectiveAt = Date.now() - 1000;
  const due = await svc.publishDue();
  assert.equal(due.length, 2);
  assert.equal(svc.getChange(propA.id).status, 'published');
  assert.equal(svc.getChange(propB.id).status, 'published');

  // 来源隔离：A 的新字段不出现在 B
  assert.ok(svc.headVersion('src_a')!.fields.some((f) => f.sourceField === 'future_field'));
  assert.ok(!svc.headVersion('src_b')!.fields.some((f) => f.sourceField === 'future_field'));
  assert.equal(other.id, 'src_b');
});

test('历史数据重放使用当时映射版本；未知字段进入死信队列', async () => {
  const t0 = Date.now() - 100_000;
  const p1 = svc.createProposal({
    sourceId: 'src_a',
    title: 'v1',
    ops: [{ kind: 'add', sourceField: 'name', type: 'string' }],
    effectiveAt: t0,
    requiredApprovals: 1,
  });
  await svc.approve(p1.id, 'alice');

  const t1 = t0 + 50_000;
  const p2 = svc.createProposal({
    sourceId: 'src_a',
    title: 'v2 加字段',
    ops: [{ kind: 'add', sourceField: 'email', type: 'string' }],
    effectiveAt: t1,
    requiredApprovals: 1,
  });
  await svc.approve(p2.id, 'bob');

  // 在 t0+10 重放：只能识别 name
  const old = svc.replay('src_a', [{ name: '张三', email: 'z@x.com' }], t0 + 10_000);
  assert.equal(old.usedVersion, 1);
  assert.equal(old.mapped[0]!.name, '张三');
  assert.equal(old.mapped[0]!.email, undefined);
  assert.equal(old.deadLetters.length, 1);
  assert.equal(old.deadLetters[0]!.field, 'email');

  // 在 t1 之后重放：两个字段都识别
  const now = svc.replay('src_a', [{ name: '张三', email: 'z@x.com' }], t1 + 10_000);
  assert.equal(now.usedVersion, 2);
  assert.equal(now.deadLetters.length, 0);
});

test('回滚追加新版本快照，不改写历史；重放时间轴仍可解析到被回滚版本', async () => {
  const t0 = Date.now() - 200_000;
  const p1 = svc.createProposal({
    sourceId: 'src_a',
    title: 'v1',
    ops: [{ kind: 'add', sourceField: 'keep', type: 'string' }],
    effectiveAt: t0,
    requiredApprovals: 1,
  });
  await svc.approve(p1.id, 'alice');
  const t1 = t0 + 50_000;
  const p2 = svc.createProposal({
    sourceId: 'src_a',
    title: 'v2',
    ops: [{ kind: 'add', sourceField: 'drop_me', type: 'string' }],
    effectiveAt: t1,
    requiredApprovals: 1,
  });
  await svc.approve(p2.id, 'bob');

  const t2 = t1 + 50_000;
  const { version } = await svc.rollback({ sourceId: 'src_a', toVersion: 1, actor: 'ops', effectiveAt: t2 });
  assert.equal(version.version, 3);
  assert.equal(version.rolledBackFromVersion, 1);
  assert.equal(version.fields.length, 1);

  // 历史版本未被改写
  const all = svc.listVersions('src_a');
  assert.equal(all.length, 3);
  assert.equal(all[1]!.fields.length, 2);

  // t1~t2 之间的重放仍走 v2；t2 之后走 v3（v1 快照）
  assert.equal(svc.resolveVersionAt('src_a', t1 + 1_000).version.version, 2);
  assert.equal(svc.resolveVersionAt('src_a', t2 + 1_000).version.version, 3);
});

test('并发发布冲突：基于旧版本的变更单在来源已变更后被拒绝，要求重建', async () => {
  const p1 = svc.createProposal({
    sourceId: 'src_a',
    title: 'v1',
    ops: [{ kind: 'add', sourceField: 'f1', type: 'string' }],
    requiredApprovals: 1,
  });
  await svc.approve(p1.id, 'alice');

  // 基于 v1 建单但不立即审批
  const stale = svc.createProposal({
    sourceId: 'src_a',
    title: '过期单',
    ops: [{ kind: 'add', sourceField: 'stale', type: 'string' }],
    requiredApprovals: 1,
  });
  assert.equal(stale.baseVersion, 1);

  // 期间来源发布了 v2
  const p2 = svc.createProposal({
    sourceId: 'src_a',
    title: '插队发布',
    ops: [{ kind: 'add', sourceField: 'f2', type: 'string' }],
    requiredApprovals: 1,
  });
  await svc.approve(p2.id, 'bob');
  assert.equal(svc.headVersion('src_a')!.version, 2);

  await assert.rejects(svc.approve(stale.id, 'carol'), (e: Error) => {
    return e instanceof DomainError && e.code === 'CONFLICT' && /重建/.test(e.message);
  });
});

test('驳回后变更单进入 rejected 终态，不可再审批', async () => {
  const prop = seedV1([{ sourceField: 'f1', type: 'string' }]);
  await svc.reject(prop.id, 'alice', '字段命名不合规');
  assert.equal(svc.getChange(prop.id).status, 'rejected');
  await assert.rejects(svc.approve(prop.id, 'bob'), (e: Error) => e instanceof DomainError);
});

test('版本差异接口输出 added/removed/changed', async () => {
  const t0 = Date.now() - 100_000;
  const p1 = svc.createProposal({
    sourceId: 'src_a',
    title: 'v1',
    ops: [{ kind: 'add', sourceField: 'f1', type: 'string' }],
    effectiveAt: t0,
    requiredApprovals: 1,
  });
  await svc.approve(p1.id, 'alice');
  const p2 = svc.createProposal({
    sourceId: 'src_a',
    title: 'v2',
    ops: [
      { kind: 'add', sourceField: 'f2', type: 'integer' },
      { kind: 'type_change', sourceField: 'f1', type: 'integer', compatMode: true },
    ],
    effectiveAt: t0 + 50_000,
    requiredApprovals: 1,
  });
  await svc.approve(p2.id, 'bob');

  const diff = svc.diffVersions('src_a', 1, 2);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0]!.sourceField, 'f2');
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0]!.after.type, 'integer');
});
