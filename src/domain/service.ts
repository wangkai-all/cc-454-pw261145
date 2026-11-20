import { randomUUID } from 'node:crypto';
import { DomainError } from './errors.js';
import { analyzeOp, summarize } from './analyzer.js';
import type {
  ChangeProposal,
  ChangeOp,
  DB,
  FieldDef,
  FieldType,
  MappingVersion,
  PublishBatch,
  Source,
} from './types.js';
import type { JsonStore } from './store.js';

export interface DiscoveryField {
  sourceField: string;
  type: FieldType;
  enumValues?: string[];
  required?: boolean;
  canonicalName?: string;
  description?: string;
}

const uid = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

export class MappingService {
  constructor(private store: JsonStore) {}

  // ---------- 来源 ----------

  createSource(input: { id: string; name: string; description?: string }): Source {
    const db = this.store.read();
    if (db.sources.some((s) => s.id === input.id))
      throw new DomainError('CONFLICT', `来源 ${input.id} 已存在`);
    const source: Source = { id: input.id, name: input.name, description: input.description, createdAt: Date.now() };
    db.sources.push(source);
    return source;
  }

  listSources(): Source[] {
    return this.store.read().sources;
  }

  private requireSource(db: DB, sourceId: string): Source {
    const s = db.sources.find((x) => x.id === sourceId);
    if (!s) throw new DomainError('NOT_FOUND', `来源 ${sourceId} 不存在`);
    return s;
  }

  // ---------- 版本查询 ----------

  listVersions(sourceId: string): MappingVersion[] {
    const db = this.store.read();
    this.requireSource(db, sourceId);
    return db.versions
      .filter((v) => v.sourceId === sourceId)
      .sort((a, b) => a.effectiveAt - b.effectiveAt || a.version - b.version);
  }

  headVersion(sourceId: string): MappingVersion | undefined {
    const vs = this.listVersions(sourceId);
    return vs.at(-1);
  }

  /**
   * 按时间点解析当时生效的映射版本（历史重放的核心）。
   * 时间轴：v(n).effectiveAt <= t < v(n+1).effectiveAt 时使用 v(n)。
   */
  resolveVersionAt(sourceId: string, at: number): { version: MappingVersion; fallback: boolean } {
    const vs = this.listVersions(sourceId);
    if (vs.length === 0) throw new DomainError('NOT_FOUND', `来源 ${sourceId} 尚无任何映射版本`);
    let chosen: MappingVersion | undefined;
    for (const v of vs) if (v.effectiveAt <= at) chosen = v;
    if (!chosen) return { version: vs[0]!, fallback: true }; // 早于首个版本：尽力回退到首版
    return { version: chosen, fallback: false };
  }

  /** 两个版本的字段级差异 */
  diffVersions(sourceId: string, fromVersion: number, toVersion: number) {
    const vs = this.listVersions(sourceId);
    const a = vs.find((v) => v.version === fromVersion);
    const b = vs.find((v) => v.version === toVersion);
    if (!a || !b) throw new DomainError('NOT_FOUND', '指定的版本不存在');
    return this.diffFields(a.fields, b.fields);
  }

  private diffFields(from: FieldDef[], to: FieldDef[]) {
    const mapA = new Map(from.map((f) => [f.sourceField, f]));
    const mapB = new Map(to.map((f) => [f.sourceField, f]));
    const added = to.filter((f) => !mapA.has(f.sourceField));
    const removed = from.filter((f) => !mapB.has(f.sourceField));
    const changed = to
      .filter((f) => mapA.has(f.sourceField))
      .map((f) => ({ before: mapA.get(f.sourceField)!, after: f }))
      .filter(({ before, after }) => JSON.stringify(before) !== JSON.stringify(after));
    return { added, removed, changed };
  }

  // ---------- 采集器发现 → 变更单 ----------

  /**
   * 采集器上报观测到的字段，自动生成待审批变更单。
   * 新字段=add；类型变化=type_change；枚举新值=enum_update；头部存在但未观测到=remove（阻断态，人工裁决）。
   * 相同指纹的待审批单已存在时幂等返回，不重复建单。
   */
  ingestDiscovery(input: {
    sourceId: string;
    observed: DiscoveryField[];
    createdBy?: string;
    effectiveAt?: number;
    requiredApprovals?: number;
  }): { proposal: ChangeProposal; deduped: boolean } {
    const db = this.store.read();
    this.requireSource(db, input.sourceId);
    const head = this.headVersion(input.sourceId);
    const headFields = new Map((head?.fields ?? []).map((f) => [f.sourceField, f]));

    const ops: ChangeOp[] = [];
    const seen = new Set<string>();

    for (const obs of input.observed) {
      seen.add(obs.sourceField);
      const before = headFields.get(obs.sourceField);
      if (!before) {
        ops.push(this.buildOp({ kind: 'add', ...obs }, undefined));
        continue;
      }
      if (before.type !== obs.type) {
        ops.push(this.buildOp({ kind: 'type_change', sourceField: obs.sourceField, type: obs.type }, before));
      }
      if (obs.enumValues) {
        const merged = Array.from(new Set([...before.enumValues, ...obs.enumValues]));
        if (merged.length !== before.enumValues.length) {
          ops.push(this.buildOp({ kind: 'enum_update', sourceField: obs.sourceField, enumValues: merged }, before));
        }
      }
    }
    // 头部有、本次未观测到：疑似删除，生成阻断态 remove 操作
    for (const f of head?.fields ?? []) {
      if (!seen.has(f.sourceField)) {
        ops.push(this.buildOp({ kind: 'remove', sourceField: f.sourceField }, f));
      }
    }

    if (ops.length === 0)
      throw new DomainError('PRECONDITION', '未发现字段差异，无需生成变更单');

    const fingerprint = JSON.stringify(ops.map((o) => ({ k: o.kind, f: o.sourceField, a: o.analysis.after })));
    const existing = db.changes.find(
      (c) => c.sourceId === input.sourceId && c.status === 'pending' && c.idempotencyKey === `disc:${fingerprint}`,
    );
    if (existing) return { proposal: existing, deduped: true };

    const proposal = this.assembleProposal(db, {
      sourceId: input.sourceId,
      title: `采集器发现 ${ops.length} 项字段变更`,
      ops,
      createdBy: input.createdBy ?? 'collector',
      effectiveAt: input.effectiveAt,
      requiredApprovals: input.requiredApprovals ?? 2,
      idempotencyKey: `disc:${fingerprint}`,
    });
    return { proposal, deduped: false };
  }

  /** 手工创建变更单（可携带 compatMode 选择兼容模式） */
  createProposal(input: {
    sourceId: string;
    title: string;
    description?: string;
    ops: Array<Partial<ChangeOp> & { kind: ChangeOp['kind']; sourceField: string }>;
    createdBy?: string;
    effectiveAt?: number;
    requiredApprovals?: number;
  }): ChangeProposal {
    const db = this.store.read();
    this.requireSource(db, input.sourceId);
    const headFields = new Map((this.headVersion(input.sourceId)?.fields ?? []).map((f) => [f.sourceField, f]));
    const ops = input.ops.map((raw) => this.buildOp(raw, headFields.get(raw.sourceField)));
    return this.assembleProposal(db, {
      sourceId: input.sourceId,
      title: input.title,
      description: input.description,
      ops,
      createdBy: input.createdBy ?? 'manual',
      effectiveAt: input.effectiveAt,
      requiredApprovals: input.requiredApprovals ?? 2,
    });
  }

  private buildOp(raw: Partial<ChangeOp> & { kind: ChangeOp['kind']; sourceField: string }, before: FieldDef | undefined): ChangeOp {
    const op: ChangeOp = {
      kind: raw.kind,
      sourceField: raw.sourceField,
      canonicalName: raw.canonicalName,
      type: raw.type,
      required: raw.required,
      enumValues: raw.enumValues,
      description: raw.description,
      compatMode: raw.compatMode ?? false,
      analysis: { level: 'safe', reasons: [] },
    };
    op.analysis = analyzeOp(op, before);
    return op;
  }

  private assembleProposal(
    db: DB,
    input: {
      sourceId: string;
      title: string;
      description?: string;
      ops: ChangeOp[];
      createdBy: string;
      effectiveAt?: number;
      requiredApprovals: number;
      idempotencyKey?: string;
    },
  ): ChangeProposal {
    const head = this.headVersion(input.sourceId);
    const proposal: ChangeProposal = {
      id: uid('CH'),
      sourceId: input.sourceId,
      title: input.title,
      description: input.description,
      ops: input.ops,
      status: 'pending',
      baseVersion: head?.version ?? 0,
      requiredApprovals: Math.max(1, input.requiredApprovals),
      approvals: [],
      effectiveAt: input.effectiveAt,
      idempotencyKey: input.idempotencyKey,
      createdAt: Date.now(),
      createdBy: input.createdBy,
    };
    db.changes.push(proposal);
    return proposal;
  }

  /** 切换某个操作的兼容模式并重新分析 */
  setCompatMode(changeId: string, opIndex: number, compatMode: boolean): ChangeProposal {
    const db = this.store.read();
    const change = this.requireChange(db, changeId);
    if (change.status !== 'pending')
      throw new DomainError('CONFLICT', `变更单当前状态 ${change.status}，不可修改兼容模式`);
    const op = change.ops[opIndex];
    if (!op) throw new DomainError('NOT_FOUND', '操作序号不存在');
    op.compatMode = compatMode;
    const head = this.headVersion(change.sourceId);
    const before = head?.fields.find((f) => f.sourceField === op.sourceField);
    op.analysis = analyzeOp(op, before);
    return change;
  }

  // ---------- 审批流（支持并行审批） ----------

  listChanges(sourceId?: string): ChangeProposal[] {
    const db = this.store.read();
    return (sourceId ? db.changes.filter((c) => c.sourceId === sourceId) : db.changes).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  }

  getChange(changeId: string): ChangeProposal {
    return this.requireChange(this.store.read(), changeId);
  }

  private requireChange(db: DB, id: string): ChangeProposal {
    const c = db.changes.find((x) => x.id === id);
    if (!c) throw new DomainError('NOT_FOUND', `变更单 ${id} 不存在`);
    return c;
  }

  /**
   * 审批通过。互斥区保证并行请求串行落库：
   *  - 同一审批人重复审批 => 409
   *  - 不同审批人计数；达到 requiredApprovals 后状态只跃迁一次
   *  - 含 blocked 操作的单子不可审批
   *  - 最后一票且无未来生效时间 => 立即发布；未来生效 => scheduled 等待定时发布
   */
  async approve(changeId: string, approver: string, comment?: string): Promise<ChangeProposal> {
    return this.store.mutate((db) => {
      const change = this.requireChange(db, changeId);
      if (change.status === 'rejected' || change.status === 'published')
        throw new DomainError('CONFLICT', `变更单已终态（${change.status}），不可审批`);
      if (change.approvals.some((a) => a.approver === approver && a.decision === 'approve'))
        throw new DomainError('CONFLICT', `审批人 ${approver} 已审批过该变更单，不可重复审批`);
      const summary = summarize(change.ops);
      if (summary.blockedCount > 0)
        throw new DomainError(
          'BLOCKED',
          `存在 ${summary.blockedCount} 项阻断操作，请先拒绝或切换为兼容模式`,
        );
      change.approvals.push({ approver, at: Date.now(), decision: 'approve', comment });

      const distinct = new Set(change.approvals.filter((a) => a.decision === 'approve').map((a) => a.approver)).size;
      if (distinct >= change.requiredApprovals) {
        const due = change.effectiveAt === undefined || change.effectiveAt <= Date.now();
        if (due) {
          this.publishInternal(db, change, approver);
        } else {
          change.status = 'scheduled';
        }
      }
      return change;
    });
  }

  async reject(changeId: string, approver: string, reason?: string): Promise<ChangeProposal> {
    return this.store.mutate((db) => {
      const change = this.requireChange(db, changeId);
      if (change.status === 'published' || change.status === 'rejected')
        throw new DomainError('CONFLICT', `变更单已终态（${change.status}），不可驳回`);
      change.approvals.push({ approver, at: Date.now(), decision: 'reject', comment: reason });
      change.status = 'rejected';
      change.rejectReason = reason ?? '审批驳回';
      return change;
    });
  }

  // ---------- 发布 / 生效批次 / 幂等 ----------

  /** 显式发布（已审批通过、或定时到期的单子）。幂等键防重复发布。 */
  async publish(changeId: string, actor: string, idempotencyKey?: string): Promise<{ batch: PublishBatch; change: ChangeProposal }> {
    return this.store.mutate((db) => {
      const change = this.requireChange(db, changeId);
      if (change.status === 'published') {
        // 重复发布：
        //  - 不带幂等键 => 拒绝
        //  - 键已绑定到其他批次 => 拒绝（键被别的发布占用）
        //  - 键未使用或已绑定本批次 => 返回原批次（重试语义，并允许事后补绑幂等键）
        if (!idempotencyKey)
          throw new DomainError('CONFLICT', `变更单 ${changeId} 已发布于批次 ${change.publishedBatchId}，禁止重复发布`);
        const key = `pub:${change.sourceId}:${idempotencyKey}`;
        const bound = db.idempotency[key];
        if (bound && bound !== change.publishedBatchId)
          throw new DomainError('CONFLICT', `幂等键 ${idempotencyKey} 已被其他批次 ${bound} 使用`);
        if (!bound) db.idempotency[key] = change.publishedBatchId!;
        return { batch: db.batches.find((b) => b.id === change.publishedBatchId)!, change };
      }
      if (change.status !== 'approved' && change.status !== 'scheduled')
        throw new DomainError('PRECONDITION', `变更单状态为 ${change.status}，不满足发布条件`);
      if (change.effectiveAt && change.effectiveAt > Date.now())
        throw new DomainError('PRECONDITION', '生效时间未到，不能提前发布');
      if (idempotencyKey) {
        const key = `pub:${change.sourceId}:${idempotencyKey}`;
        if (db.idempotency[key])
          throw new DomainError('CONFLICT', `幂等键 ${idempotencyKey} 已被批次 ${db.idempotency[key]} 使用`);
        db.idempotency[key] = '(pending)';
        const batch = this.publishInternal(db, change, actor);
        db.idempotency[key] = batch.id;
        return { batch, change };
      }
      const batch = this.publishInternal(db, change, actor);
      return { batch, change };
    });
  }

  /** 定时扫描：发布所有到期的 scheduled 变更单（每来源独立，互不影响） */
  async publishDue(): Promise<ChangeProposal[]> {
    return this.store.mutate((db) => {
      const now = Date.now();
      const due = db.changes.filter((c) => c.status === 'scheduled' && (c.effectiveAt ?? 0) <= now);
      for (const change of due) this.publishInternal(db, change, 'scheduler');
      return due;
    });
  }

  /**
   * 发布内部实现：
   * 1) 并发冲突检测——baseVersion 之后若同一字段被其他版本改过，拒绝并要求重建变更单
   * 2) 在当前头部字段集上重放 ops 的 after 快照，生成新版本
   * 3) 仅影响该来源；effectiveAt 决定时间轴位置
   */
  private publishInternal(db: DB, change: ChangeProposal, actor: string): PublishBatch {
    this.requireSource(db, change.sourceId);
    const versions = db.versions
      .filter((v) => v.sourceId === change.sourceId)
      .sort((a, b) => a.version - b.version);
    const head = versions.at(-1);

    if (head && head.version !== change.baseVersion) {
      // 进一步定位冲突字段
      const base = versions.find((v) => v.version === change.baseVersion);
      const drifted: string[] = [];
      if (base) {
        const baseMap = new Map(base.fields.map((f) => [f.sourceField, f]));
        const headMap = new Map(head.fields.map((f) => [f.sourceField, f]));
        for (const op of change.ops) {
          const a = baseMap.get(op.sourceField);
          const b = headMap.get(op.sourceField);
          if (JSON.stringify(a) !== JSON.stringify(b)) drifted.push(op.sourceField);
        }
      }
      throw new DomainError(
        'CONFLICT',
        `来源 ${change.sourceId} 在变更单创建后已发布 v${head.version}（当前基于 v${change.baseVersion}），冲突字段：${drifted.join(', ') || '未知'}，请基于最新版本重建变更单`,
      );
    }

    const fields = structuredClone(head?.fields ?? []);
    const index = new Map(fields.map((f, i) => [f.sourceField, i]));
    for (const op of change.ops) {
      if (op.analysis.level === 'blocked')
        throw new DomainError('BLOCKED', `字段 ${op.sourceField} 仍为阻断态，不能发布`);
      const after = op.analysis.after;
      if (!after) continue;
      const i = index.get(op.sourceField);
      if (i === undefined) {
        fields.push(structuredClone(after));
        index.set(op.sourceField, fields.length - 1);
      } else {
        fields[i] = structuredClone(after);
      }
    }

    const nextVersion = (head?.version ?? 0) + 1;
    const version: MappingVersion = {
      id: uid('V'),
      sourceId: change.sourceId,
      version: nextVersion,
      fields,
      effectiveAt: change.effectiveAt ?? Date.now(),
      createdAt: Date.now(),
      changeId: change.id,
      batchId: '',
      note: change.title,
    };
    const batch: PublishBatch = {
      id: uid('B'),
      createdAt: Date.now(),
      createdBy: actor,
      note: `发布 ${change.sourceId} v${nextVersion}：${change.title}`,
      entries: [
        {
          sourceId: change.sourceId,
          changeId: change.id,
          version: nextVersion,
          effectiveAt: version.effectiveAt,
        },
      ],
    };
    version.batchId = batch.id;
    db.versions.push(version);
    db.batches.push(batch);
    change.status = 'published';
    change.publishedVersion = nextVersion;
    change.publishedBatchId = batch.id;
    change.publishedAt = Date.now();
    return batch;
  }

  listBatches(): PublishBatch[] {
    return this.store.read().batches.sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---------- 回滚：追加快照版本，永不改写历史 ----------

  async rollback(input: {
    sourceId: string;
    toVersion: number;
    actor: string;
    effectiveAt?: number;
    note?: string;
  }): Promise<{ version: MappingVersion; batch: PublishBatch }> {
    return this.store.mutate((db) => {
      this.requireSource(db, input.sourceId);
      const versions = db.versions
        .filter((v) => v.sourceId === input.sourceId)
        .sort((a, b) => a.version - b.version);
      const target = versions.find((v) => v.version === input.toVersion);
      if (!target) throw new DomainError('NOT_FOUND', `目标版本 v${input.toVersion} 不存在`);
      const head = versions.at(-1)!;
      if (target.version === head.version)
        throw new DomainError('PRECONDITION', '目标版本即当前头部版本，无需回滚');

      const nextVersion = head.version + 1;
      const version: MappingVersion = {
        id: uid('V'),
        sourceId: input.sourceId,
        version: nextVersion,
        fields: structuredClone(target.fields),
        effectiveAt: input.effectiveAt ?? Date.now(),
        createdAt: Date.now(),
        changeId: '',
        batchId: '',
        note: `回滚至 v${target.version} 的字段快照${input.note ? `：${input.note}` : ''}`,
        rolledBackFromVersion: target.version,
      };
      // 审计用变更单（自动通过的紧急操作）
      const auditChange: ChangeProposal = {
        id: uid('CH'),
        sourceId: input.sourceId,
        title: `紧急回滚至 v${target.version}`,
        ops: [],
        status: 'published',
        baseVersion: head.version,
        requiredApprovals: 1,
        approvals: [{ approver: input.actor, at: Date.now(), decision: 'approve', comment: input.note ?? '回滚操作' }],
        createdAt: Date.now(),
        createdBy: input.actor,
        publishedVersion: nextVersion,
        publishedAt: Date.now(),
      };
      const batch: PublishBatch = {
        id: uid('B'),
        createdAt: Date.now(),
        createdBy: input.actor,
        note: version.note,
        entries: [
          { sourceId: input.sourceId, changeId: auditChange.id, version: nextVersion, effectiveAt: version.effectiveAt },
        ],
      };
      version.batchId = batch.id;
      auditChange.publishedBatchId = batch.id;
      version.changeId = auditChange.id;
      db.changes.push(auditChange);
      db.versions.push(version);
      db.batches.push(batch);
      return { version, batch };
    });
  }

  // ---------- 历史数据重放：使用当时的映射版本 ----------

  replay(sourceId: string, records: Record<string, unknown>[], at: number) {
    const { version, fallback } = this.resolveVersionAt(sourceId, at);
    const fieldMap = new Map(version.fields.map((f) => [f.sourceField, f]));
    const mapped: Array<Record<string, unknown>> = [];
    const deadLetters: Array<{ recordIndex: number; field: string; reason: string; raw: unknown }> = [];

    records.forEach((record, recordIndex) => {
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(record)) {
        const def = fieldMap.get(key);
        if (!def) {
          deadLetters.push({ recordIndex, field: key, reason: '当时映射中不存在该字段', raw });
          continue;
        }
        const value = this.coerceValue(def, raw, (reason) =>
          deadLetters.push({ recordIndex, field: key, reason, raw }),
        );
        out[def.canonicalName] = value;
      }
      mapped.push(out);
    });

    return {
      usedVersion: version.version,
      versionId: version.id,
      effectiveAt: version.effectiveAt,
      fallback,
      mapped,
      deadLetters,
    };
  }

  private coerceValue(
    def: FieldDef,
    raw: unknown,
    dead: (reason: string) => void,
  ): unknown {
    // 枚举校验（兼容模式保留的旧值仍可通过，因为它仍在 enumValues 并集里）
    if (def.enumValues.length > 0 && typeof raw === 'string' && !def.enumValues.includes(raw)) {
      dead(`枚举值 "${raw}" 不在当前版本允许集合内`);
    }
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return raw;
    if (!def.coercion) return raw;
    const { to, strategy } = def.coercion;
    try {
      if (to === 'integer') return Math.round(Number(raw));
      if (to === 'number') return Number(raw);
      if (to === 'boolean') return Boolean(raw);
      if (to === 'string') return String(raw);
      if (to === 'date') return new Date(raw as string).toISOString();
      if (strategy === 'stringify') return JSON.stringify(raw);
    } catch {
      dead('强制转换失败');
    }
    return raw;
  }
}
