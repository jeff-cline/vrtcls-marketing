import bcrypt from 'bcrypt';
import { query } from './db.js';

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export async function findUserByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
  return rows[0] || null;
}

export async function findUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function createUser({ email, password, role = 'user' }) {
  const hash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING *`,
    [email.toLowerCase().trim(), hash, role]
  );
  return rows[0];
}

export function requireAuth(req, reply, done) {
  if (!req.session.userId) {
    reply.redirect('/login');
    return;
  }
  done();
}

export function requireAdmin(req, reply, done) {
  if (!req.session.userId) {
    reply.redirect('/login?next=' + encodeURIComponent(req.url));
    return;
  }
  if (req.session.role !== 'admin') {
    reply.code(403).send('Forbidden');
    return;
  }
  done();
}

export async function loadUser(req, reply) {
  if (req.session.userId) {
    req.user = await findUserById(req.session.userId);
    if (!req.user) {
      req.session.destroy();
      return;
    }
    if (req.session.realAdminId) {
      req.realAdmin = await findUserById(req.session.realAdminId);
      req.user.impersonating = true;
    }
  }
}
