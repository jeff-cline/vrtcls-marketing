import { findUserByEmail, verifyPassword, createUser } from '../auth.js';
import { grantCredits } from '../services/credits.js';

export default async function publicRoutes(app) {
  app.get('/', async (req, reply) => {
    return reply.view('public/landing', { user: req.user });
  });

  app.get('/pricing', async (req, reply) => {
    return reply.view('public/pricing', { user: req.user });
  });

  app.get('/login', async (req, reply) => {
    return reply.view('public/login', { user: req.user, error: null });
  });

  app.post('/login', async (req, reply) => {
    const { email, password } = req.body || {};
    const user = await findUserByEmail(email || '');
    if (!user || !(await verifyPassword(password || '', user.password_hash))) {
      return reply.view('public/login', { user: null, error: 'Invalid email or password.' });
    }
    req.session.userId = user.id;
    req.session.role = user.role;
    return reply.redirect(user.role === 'admin' ? '/admin' : '/app');
  });

  app.get('/signup', async (req, reply) => {
    return reply.view('public/signup', { user: req.user, error: null });
  });

  app.post('/signup', async (req, reply) => {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 8) {
      return reply.view('public/signup', {
        user: null,
        error: 'Email and password (8+ chars) required.',
      });
    }
    try {
      const existing = await findUserByEmail(email);
      if (existing) {
        return reply.view('public/signup', { user: null, error: 'Email already registered.' });
      }
      const user = await createUser({ email, password });
      // Welcome credit: $5.00 to let new users try one fresh lead
      await grantCredits(user.id, 500, 'signup_welcome', null);
      req.session.userId = user.id;
      req.session.role = user.role;
      return reply.redirect('/app');
    } catch (err) {
      req.log.error(err);
      return reply.view('public/signup', {
        user: null,
        error: 'Something went wrong. Try again.',
      });
    }
  });

  app.post('/logout', async (req, reply) => {
    req.session.destroy();
    return reply.redirect('/');
  });
}
