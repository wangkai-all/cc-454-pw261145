import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from './types.js';

const EMPTY_DB: DB = {
  sources: [],
  versions: [],
  changes: [],
  batches: [],
  idempotency: {},
  rev: 0,
};

/**
 * JSON 文件存储。
 * - 进程内互斥队列：所有写操作串行化，保证“读-判断-写”事务原子性（并行审批的正确性基础）
 * - 临时文件 + rename 原子落盘
 * - db.rev 为乐观版本号，读侧可携带期望 rev 做条件写
 */
export class JsonStore {
  private db: DB;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {
    this.db = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as DB)
      : structuredClone(EMPTY_DB);
  }

  read(): DB {
    return this.db;
  }

  /** 在互斥区内执行事务；返回事务结果，异常时不写盘 */
  async mutate<T>(fn: (db: DB) => T, expectedRev?: number): Promise<T> {
    const run = this.chain.then(() => {
      if (expectedRev !== undefined && this.db.rev !== expectedRev) {
        const err = new Error(
          `乐观锁冲突：数据已被其他操作修改（rev ${expectedRev} -> ${this.db.rev}），请刷新后重试`,
        );
        err.name = 'RevConflict';
        throw err;
      }
      const result = fn(this.db);
      this.db = { ...this.db, rev: this.db.rev + 1 };
      this.persist();
      return result;
    });
    // 防止单个失败中断整条链
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    renameSync(tmp, this.file);
  }
}
