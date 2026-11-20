import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { DomainError } from '../domain/errors.js';
import type { MappingService } from '../domain/service.js';

const statusFor = (code: DomainError['code']) =>
  code === 'NOT_FOUND' ? 404 : code === 'CONFLICT' ? 409 : code === 'BLOCKED' ? 422 : code === 'PRECONDITION' ? 412 : 400;

export function registerRoutes(app: FastifyInstance, svc: MappingService) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      reply.status(statusFor(err.code)).send({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof ZodError) {
      reply.status(400).send({ error: 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      return;
    }
    if ((err as Error).name === 'RevConflict') {
      reply.status(409).send({ error: 'CONFLICT', message: (err as Error).message });
      return;
    }
    app.log.error(err);
    reply.status(500).send({ error: 'INTERNAL', message: (err as Error).message });
  });

  const fieldType = z.enum(['string', 'integer', 'number', 'boolean', 'date', 'json']);

  // ---------- 来源 ----------
  app.post('/api/sources', async (req, reply) => {
    const body = z.object({ id: z.string().min(1), name: z.string().min(1), description: z.string().optional() }).parse(req.body);
    reply.status(201).send(svc.createSource(body));
  });
  app.get('/api/sources', async () => svc.listSources());

  app.get('/api/sources/:id/versions', async (req) => {
    const { id } = req.params as { id: string };
    return svc.listVersions(id);
  });
  app.get('/api/sources/:id/versions/at', async (req) => {
    const { id } = req.params as { id: string };
    const { at } = z.object({ at: z.coerce.number() }).parse(req.query);
    return svc.resolveVersionAt(id, at);
  });
  app.get('/api/sources/:id/diff', async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ from: z.coerce.number(), to: z.coerce.number() }).parse(req.query);
    return svc.diffVersions(id, q.from, q.to);
  });

  // ---------- 采集器发现 / 手工建单 ----------
  app.post('/api/sources/:id/discovery', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        observed: z
          .array(
            z.object({
              sourceField: z.string().min(1),
              type: fieldType,
              enumValues: z.array(z.string()).optional(),
              required: z.boolean().optional(),
              canonicalName: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .min(1),
        createdBy: z.string().optional(),
        effectiveAt: z.number().optional(),
        requiredApprovals: z.number().int().positive().optional(),
      })
      .parse(req.body);
    const r = svc.ingestDiscovery({ sourceId: id, ...body });
    reply.status(r.deduped ? 200 : 201).send(r);
  });

  app.post('/api/sources/:id/proposals', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        title: z.string().min(1),
        description: z.string().optional(),
        ops: z
          .array(
            z.object({
              kind: z.enum(['add', 'remove', 'deprecate', 'type_change', 'enum_update']),
              sourceField: z.string(),
              canonicalName: z.string().optional(),
              type: fieldType.optional(),
              required: z.boolean().optional(),
              enumValues: z.array(z.string()).optional(),
              description: z.string().optional(),
              compatMode: z.boolean().optional(),
            }),
          )
          .min(1),
        createdBy: z.string().optional(),
        effectiveAt: z.number().optional(),
        requiredApprovals: z.number().int().positive().optional(),
      })
      .parse(req.body);
    reply.status(201).send(svc.createProposal({ sourceId: id, ...body }));
  });

  // ---------- 变更单 / 审批 ----------
  app.get('/api/changes', async (req) => {
    const { sourceId } = z.object({ sourceId: z.string().optional() }).parse(req.query);
    return svc.listChanges(sourceId);
  });
  app.get('/api/changes/:id', async (req) => svc.getChange((req.params as { id: string }).id));

  app.post('/api/changes/:id/compat', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ opIndex: z.number().int().nonnegative(), compatMode: z.boolean() }).parse(req.body);
    return svc.setCompatMode(id, body.opIndex, body.compatMode);
  });

  app.post('/api/changes/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ approver: z.string().min(1), comment: z.string().optional() }).parse(req.body);
    return svc.approve(id, body.approver, body.comment);
  });

  app.post('/api/changes/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ approver: z.string().min(1), reason: z.string().optional() }).parse(req.body);
    return svc.reject(id, body.approver, body.reason);
  });

  app.post('/api/changes/:id/publish', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ actor: z.string().default('manual'), idempotencyKey: z.string().optional() }).parse(req.body);
    return svc.publish(id, body.actor, body.idempotencyKey);
  });

  // ---------- 批次 ----------
  app.get('/api/batches', async () => svc.listBatches());

  // ---------- 回滚 ----------
  app.post('/api/sources/:id/rollback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ toVersion: z.number().int().positive(), actor: z.string().min(1), effectiveAt: z.number().optional(), note: z.string().optional() })
      .parse(req.body);
    reply.status(201).send(await svc.rollback({ sourceId: id, ...body }));
  });

  // ---------- 历史重放 ----------
  app.post('/api/sources/:id/replay', async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ records: z.array(z.record(z.string(), z.unknown())).min(1), at: z.number() })
      .parse(req.body);
    return svc.replay(id, body.records, body.at);
  });

  // ---------- 定时发布扫描 ----------
  app.post('/api/scheduler/tick', async () => {
    const published = await svc.publishDue();
    return { published: published.map((c) => ({ id: c.id, sourceId: c.sourceId, version: c.publishedVersion })) };
  });
}
