import type { ChangeOp, FieldDef, FieldType, OpAnalysis } from './types.js';

/**
 * 类型兼容性判定。
 * 缩窄 = 新类型无法无损容纳旧类型的全部取值，必须阻断或进入兼容模式。
 */
const TYPE_WIDTH: Record<FieldType, number> = {
  boolean: 0,
  integer: 1,
  number: 2,
  date: 2,
  string: 3,
  json: 4,
};

export function isTypeNarrowing(from: FieldType, to: FieldType): boolean {
  if (from === to) return false;
  // date 与 number 视为同宽但语义不同：直接互转有风险，按缩窄处理
  if (TYPE_WIDTH[to] < TYPE_WIDTH[from]) return true;
  if ((from === 'date' && to === 'number') || (from === 'number' && to === 'date'))
    return true;
  return false;
}

/** 枚举冲突：新枚举删除了旧枚举中仍在使用的值（这里以旧枚举全集近似“在用值”） */
export function enumConflicts(before: string[], after: string[]): string[] {
  const next = new Set(after);
  return before.filter((v) => !next.has(v));
}

/**
 * 分析单个变更操作，固化结论到 OpAnalysis。
 * 规则：
 *  - add：安全
 *  - remove：阻断；兼容模式 => 转为 deprecate（字段保留、标记弃用，旧数据/重放仍可解析）
 *  - type_change：缩窄阻断；兼容模式 => 保留转换规则（coercion），运行期按规则强制转换
 *  - enum_update：枚举收缩（删除允许值）阻断；兼容模式 => 枚举取并集，被删值标记弃用语义
 *  - 放宽类型 / 枚举扩展：安全
 */
export function analyzeOp(op: ChangeOp, before: FieldDef | undefined): OpAnalysis {
  const reasons: string[] = [];

  if (op.kind === 'add') {
    if (before) {
      reasons.push(`字段 ${op.sourceField} 已存在，新增操作无效`);
      return { level: 'blocked', reasons, before, after: undefined };
    }
    const after: FieldDef = {
      sourceField: op.sourceField,
      canonicalName: op.canonicalName ?? op.sourceField,
      type: op.type ?? 'string',
      required: op.required ?? false,
      enumValues: op.enumValues ?? [],
      deprecated: false,
      description: op.description,
    };
    return { level: 'safe', reasons: ['新字段，向后兼容'], after };
  }

  if (!before) {
    return {
      level: 'blocked',
      reasons: [`字段 ${op.sourceField} 不存在，无法执行 ${op.kind} 操作`],
    };
  }

  if (op.kind === 'remove') {
    if (op.compatMode) {
      const after: FieldDef = { ...before, deprecated: true };
      return {
        level: 'compatible',
        reasons: ['删除已转为弃用（deprecate）：字段保留，历史数据与重放仍可解析'],
        compatStrategy: 'deprecate-instead-of-remove',
        before,
        after,
      };
    }
    return {
      level: 'blocked',
      reasons: ['删除字段会使历史数据无法按新映射解析，需阻断或开启兼容模式（弃用保留）'],
      before,
    };
  }

  if (op.kind === 'deprecate') {
    return {
      level: 'safe',
      reasons: ['弃用标记不改变数据兼容性'],
      before,
      after: { ...before, deprecated: true },
    };
  }

  if (op.kind === 'type_change') {
    const to = op.type ?? before.type;
    const narrowing = isTypeNarrowing(before.type, to);
    const after: FieldDef = { ...before, type: to };
    if (!narrowing) {
      return {
        level: 'safe',
        reasons: [`类型放宽：${before.type} -> ${to}，旧值可无损容纳`],
        before,
        after,
      };
    }
    if (op.compatMode) {
      after.coercion = {
        from: before.type,
        to,
        strategy: to === 'integer' ? 'round' : to === 'string' ? 'stringify' : 'truncate',
        note: `兼容模式：${before.type} -> ${to}，运行期按规则强制转换，无法转换的值进入死信队列`,
      };
      return {
        level: 'compatible',
        reasons: [`类型缩窄 ${before.type} -> ${to}，已启用强制转换兼容`],
        compatStrategy: 'runtime-coercion',
        before,
        after,
      };
    }
    return {
      level: 'blocked',
      reasons: [
        `类型缩窄 ${before.type} -> ${to} 可能丢失数据，需阻断或开启兼容模式（强制转换规则）`,
      ],
      before,
      after,
    };
  }

  // enum_update
  const nextValues = op.enumValues ?? [];
  const removed = enumConflicts(before.enumValues, nextValues);
  if (removed.length === 0) {
    return {
      level: 'safe',
      reasons:
        nextValues.length > before.enumValues.length
          ? ['枚举扩展，向后兼容']
          : ['枚举值未收缩'],
      before,
      after: { ...before, enumValues: nextValues },
    };
  }
  if (op.compatMode) {
    const merged = Array.from(new Set([...before.enumValues, ...nextValues]));
    return {
      level: 'compatible',
      reasons: [`枚举冲突值 ${removed.join(', ')} 已通过并集保留，新数据不应再写入这些值`],
      compatStrategy: 'enum-union-superset',
      before,
      after: { ...before, enumValues: merged },
    };
  }
  return {
    level: 'blocked',
    reasons: [
      `枚举冲突：新枚举删除了仍允许的值 ${removed.join(', ')}，需阻断或开启兼容模式（超集合并）`,
    ],
    before,
    after: { ...before, enumValues: nextValues },
  };
}

/** 一批操作的整体结论：任一 blocked 且未兼容 => 整单阻断 */
export function summarize(ops: ChangeOp[]): {
  level: OpAnalysis['level'];
  blockedCount: number;
  compatibleCount: number;
} {
  let blockedCount = 0;
  let compatibleCount = 0;
  for (const op of ops) {
    if (op.analysis.level === 'blocked') blockedCount++;
    if (op.analysis.level === 'compatible') compatibleCount++;
  }
  const level = blockedCount > 0 ? 'blocked' : compatibleCount > 0 ? 'compatible' : 'safe';
  return { level, blockedCount, compatibleCount };
}
