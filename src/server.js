import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, isProd } from './config.js';
import { loadUser } from './auth.js';
import publicRoutes from './routes/public.js';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';
import trackingRoutes from './routes/tracking.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: { level: isProd ? 'info' : 'debug' },
  trustProxy: true,
  bodyLimit: 8 * 1024 * 1024, // 8MB — admin import can be large JSON
});

await app.register(fastifyCookie);
await app.register(fastifySession, {
  secret: config.sessionSecret,
  cookie: { secure: isProd, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
  saveUninitialized: false,
});
await app.register(fastifyFormbody);
await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/static/',
});
await app.register(fastifyView, {
  engine: { ejs },
  root: path.join(__dirname, 'views'),
  includeViewExtension: true,
  layout: 'layout',
  viewExt: 'ejs',
  propertyName: 'view',
});

app.addHook('preHandler', loadUser);

await app.register(publicRoutes);
await app.register(trackingRoutes);
await app.register(userRoutes);
await app.register(adminRoutes);

app.setNotFoundHandler((req, reply) => {
  reply.code(404).view('public/not_found', { user: req.user });
});

app.listen({ port: config.port, host: '0.0.0.0' }).then(() => {
  app.log.info(`vrtcls.marketing listening on :${config.port}`);
});
