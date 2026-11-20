import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JsonStore } from '../domain/store.js';
import { MappingService } from '../domain/service.js';
import { registerRoutes } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildApp(dbFile = resolve(process.cwd(), 'data/mapping-db.json')) {
  const app = Fastify({ logger: true });
  const store = new JsonStore(dbFile);
  const svc = new MappingService(store);
  registerRoutes(app, svc);
  app.decorate('svc', svc);
  app.decorate('store', store);

  const publicDir = resolve(__dirname, '../../public');
  await app.register(fastifyStatic, { root: publicDir, prefix: '/' });

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 3000);
  buildApp().then((app) =>
    app.listen({ port, host: '0.0.0.0' }).then(() => app.log.info(`映射管理服务已启动: http://localhost:${port}`)),
  );
}
