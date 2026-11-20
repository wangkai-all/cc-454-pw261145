// 领域核心类型定义

export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'json';

/** 字段定义（映射版本中的条目） */
export interface FieldDef {
  /** 来源侧原始字段名 */
  sourceField: string;
  /** 归一化后的标准字段名 */
  canonicalName: string;
  type: FieldType;
  required: boolean;
  /** 枚举允许值；为空表示非枚举 */
  enumValues: string[];
  /** 已弃用：仍可被旧数据/重放使用，但新数据不再推荐写入 */
  deprecated: boolean;
  description?: string;
  /** 兼容模式下的类型转换规则 */
  coercion?: TypeCoercion;
}

/** 兼容模式：类型缩窄时记录的强制转换规则 */
export interface TypeCoercion {
  from: FieldType;
  to: FieldType;
  strategy: 'truncate' | 'round' | 'parse' | 'stringify';
  note: string;
}

/** 不可变映射版本（同一来源的版本链节点） */
export interface MappingVersion {
  id: string;
  sourceId: string;
  version: number;
  fields: FieldDef[];
  /** 生效时间（毫秒时间戳）：该版本在 [effectiveAt, 下一版本.effectiveAt) 内有效 */
  effectiveAt: number;
  createdAt: number;
  /** 发布该版本的变更单 */
  changeId: string;
  /** 发布批次 id */
  batchId: string;
  note: string;
  /** 回滚来源版本（仅回滚产生的版本有值） */
  rolledBackFromVersion?: number;
}

export type ChangeKind = 'add' | 'remove' | 'deprecate' | 'type_change' | 'enum_update';
export type ChangeStatus = 'pending' | 'approved' | 'rejected' | 'published' | 'scheduled';
export type SafetyLevel = 'safe' | 'blocked' | 'compatible';

/** 变更单中的单字段操作 */
export interface ChangeOp {
  kind: ChangeKind;
  sourceField: string;
  canonicalName?: string;
  type?: FieldType;
  required?: boolean;
  enumValues?: string[];
  description?: string;
  /** 针对阻断项选择的处理方式：阻断（默认）或兼容模式 */
  compatMode?: boolean;
  /** 分析结论（生成时计算并固化） */
  analysis: OpAnalysis;
}

export interface OpAnalysis {
  level: SafetyLevel;
  reasons: string[];
  compatStrategy?: string;
  before?: FieldDef;
  after?: FieldDef;
}

export interface ApprovalRecord {
  approver: string;
  at: number;
  decision: 'approve' | 'reject';
  comment?: string;
}

/** 待审批/已审批变更单 */
export interface ChangeProposal {
  id: string;
  sourceId: string;
  title: string;
  description?: string;
  ops: ChangeOp[];
  status: ChangeStatus;
  /** 创建时来源当前版本号，用于乐观并发控制 */
  baseVersion: number;
  requiredApprovals: number;
  approvals: ApprovalRecord[];
  /** 期望生效时间；为空表示审批通过后立即发布 */
  effectiveAt?: number;
  /** 发布幂等键：同一 sourceId + idempotencyKey 只发布一次 */
  idempotencyKey?: string;
  createdAt: number;
  createdBy: string;
  /** 发布后回填 */
  publishedVersion?: number;
  publishedBatchId?: string;
  publishedAt?: number;
  rejectReason?: string;
}

/** 生效批次：一次发布动作的审计单元，可跨来源 */
export interface PublishBatch {
  id: string;
  createdAt: number;
  createdBy: string;
  note: string;
  entries: Array<{
    sourceId: string;
    changeId: string;
    version: number;
    effectiveAt: number;
  }>;
}

export interface Source {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
}

export interface DB {
  sources: Source[];
  versions: MappingVersion[];
  changes: ChangeProposal[];
  batches: PublishBatch[];
  idempotency: Record<string, string>; // key -> batchId
  /** 乐观版本号：任何写操作 +1，用于并行审批的冲突检测 */
  rev: number;
}
