# 来源字段映射管理工具

面向多数据来源的字段映射治理平台：采集器发现字段变化 → 自动生成待审批变更 → 并行审批 → 按来源/生效时间发布为不可变版本 → 历史数据按当时版本重放 → 支持快照式回滚。

## 能力对照

| 需求 | 实现 |
| --- | --- |
| 采集器发现新字段生成待审批变更 | `POST /api/sources/:id/discovery`，自动 diff 头部版本生成 add / type_change / enum_update / remove 变更单；相同指纹幂等去重 |
| 审批通过后只影响指定来源和生效时间 | 版本按 `sourceId` 隔离；`effectiveAt` 决定时间轴位置，未来时间进入 `scheduled`，由调度器到期发布 |
| 字段删除阻断或兼容模式 | remove 默认 `blocked`；兼容模式转为 **deprecate（弃用保留）**，历史数据仍可解析 |
| 类型缩窄阻断或兼容模式 | 类型宽度判定缩窄；兼容模式写入 `coercion` 转换规则，运行期强制转换、失败进死信队列 |
| 枚举冲突阻断或兼容模式 | 删除在用枚举值即冲突；兼容模式取**并集超集**保留旧值 |
| 历史重放使用当时映射版本 | `resolveVersionAt(sourceId, at)` 按 `effectiveAt` 时间轴解析版本；未知字段/非法值进入死信队列 |
| 差异视图 | 版本间字段级 added / removed / changed diff（页面 + API） |
| 审批流 | N 个不同审批人并行投票；同人重复投票 409；驳回即终态；阻断单不可审批 |
| 生效批次 | 每次发布生成审计批次，记录来源/变更单/版本/生效时间 |
| 回滚入口 | 回滚 = 追加目标版本快照的新版本，**永不改写历史**，时间轴可重放 |
| 并行审批验证 | 进程内互斥队列串行化写事务 + 测试中的并发 `Promise.all` / HTTP 并行请求 |
| 重复发布验证 | 幂等键：同键返回原批次，无键/异键返回 409；乐观版本号检测发布冲突 |

## 快速开始

```bash
npm install
npm run dev        # 开发模式（tsx watch），默认 http://localhost:3000
# 或
npm run build && npm start
npm test           # 19 个自动化测试（领域规则 + HTTP 端到端）
npm run typecheck
```

打开页面后可点击右上角 **“载入演示数据”** 快速体验：生成一个含阻断项（类型缩窄 + 枚举收缩）的变更单，切换兼容模式后完成双人审批。

## 领域模型

```
Source ──< MappingVersion（不可变，含 effectiveAt 时间轴）
        ──< ChangeProposal（ops[] + approvals[] + 状态机）
PublishBatch（发布审计单元）── entries ──> (source, change, version, effectiveAt)
```

变更单状态机：

```
pending ──批准票数达标──▶ published（立即生效）
      │                └▶ scheduled（未来生效）─调度器到期─▶ published
      └──驳回──▶ rejected
```

安全级别：`safe`（直接放行）· `compatible`（带兼容策略放行）· `blocked`（必须驳回或切换兼容模式）。

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/sources` | 创建来源 |
| POST | `/api/sources/:id/discovery` | 采集器字段上报，自动生成变更单 |
| POST | `/api/sources/:id/proposals` | 手工创建变更单（可指定 compatMode） |
| POST | `/api/changes/:id/compat` | 切换某操作的兼容模式并重新分析 |
| POST | `/api/changes/:id/approve` `/reject` | 审批/驳回 |
| POST | `/api/changes/:id/publish` | 显式发布（支持 idempotencyKey） |
| POST | `/api/scheduler/tick` | 触发到期定时发布 |
| GET | `/api/sources/:id/versions` `/at?at=` `/diff?from=&to=` | 版本时间轴/时点解析/差异 |
| POST | `/api/sources/:id/replay` | 按时间点重放历史数据 |
| POST | `/api/sources/:id/rollback` | 快照式回滚 |
| GET | `/api/batches` | 生效批次审计 |

## 并发与持久化

- `JsonStore` 以进程内 Promise 互斥队列保证“读-判断-写”原子性，落盘采用临时文件 + rename 原子替换；
- `db.rev` 乐观版本号支持条件写；发布时校验 `baseVersion`，来源已被其他版本推进则拒绝并要求重建变更单；
- 生产环境可将 `JsonStore` 替换为带事务的数据库实现，领域层接口不变。

## 目录结构

```
src/domain/   类型、安全分析器、存储、领域服务（无框架依赖）
src/server/   Fastify 路由与启动入口
public/       原生 ESM 单页应用（无构建步骤）
test/         node:test 自动化测试
```
