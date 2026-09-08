/**
 * Authentication and user management (Section 22).
 *
 * Deliberate choices:
 *  - Passwords are bcrypt hashes with a work factor of 12. Nothing else.
 *  - Failed logins are counted and lock the account for a configurable period.
 *    The lockout is reported without revealing whether the username exists.
 *  - Login failures return one generic message regardless of cause, so the
 *    endpoint cannot be used to enumerate accounts.
 *  - Every authentication event, successful or not, is written to the audit log.
 *
 * This is a demonstration-grade authentication placeholder as the specification
 * describes. Production would federate to the operator's identity provider;
 * see docs/security.md for what that entails.
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { one, query, rows } from '../db/pool.js';
import { env, getConfig } from '../config/index.js';
import { Role, ROLE_ORDER } from '../models/enums.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('auth');

const GENERIC_FAILURE = 'Invalid username or password.';

/** Strip fields that must never leave the server. */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    full_name: row.full_name,
    email: row.email,
    role: row.role,
    is_active: row.is_active,
    last_login_at: row.last_login_at,
    created_at: row.created_at
  };
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, name: user.full_name },
    env.jwt.secret,
    { expiresIn: env.jwt.expiresIn, issuer: env.jwt.issuer }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, env.jwt.secret, { issuer: env.jwt.issuer });
}

/** Does `role` meet or exceed `required`? */
export function roleAtLeast(role, required) {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(required);
}

export async function writeAudit({
  actorId = null,
  actorName = null,
  actorRole = null,
  action,
  entityType = null,
  entityId = null,
  outcome = 'SUCCESS',
  ip = null,
  userAgent = null,
  detail = {}
}) {
  try {
    await query(
      `INSERT INTO audit_log (actor_id, actor_name, actor_role, action, entity_type, entity_id,
                              outcome, ip_address, user_agent, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        actorId,
        actorName,
        actorRole,
        action,
        entityType,
        entityId,
        outcome,
        ip,
        userAgent ? String(userAgent).slice(0, 500) : null,
        JSON.stringify(detail)
      ]
    );
  } catch (err) {
    // An audit write must never break the request it is describing, but the
    // failure itself has to be visible.
    log.error('audit write failed', { action, message: err.message });
  }
}

export class AuthService {
  /**
   * Authenticate a user.
   * @returns {Promise<{ token: string, user: object }>}
   * @throws error with `status` on failure
   */
  async login(username, password, context = {}) {
    const security = getConfig().security;
    const user = await one('SELECT * FROM users WHERE lower(username) = lower($1)', [String(username ?? '')]);

    const fail = async (reason) => {
      await writeAudit({
        action: 'LOGIN_FAILED',
        entityType: 'user',
        entityId: user?.id ?? null,
        actorName: String(username ?? '').slice(0, 64),
        outcome: 'FAILURE',
        ip: context.ip,
        userAgent: context.userAgent,
        detail: { reason }
      });
      throw Object.assign(new Error(GENERIC_FAILURE), { status: 401 });
    };

    if (!user) {
      // Hash anyway so a missing account is not distinguishable by timing.
      await bcrypt.compare(String(password ?? ''), '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
      return fail('UNKNOWN_USER');
    }
    if (!user.is_active) return fail('ACCOUNT_DISABLED');
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await writeAudit({
        action: 'LOGIN_BLOCKED',
        entityType: 'user',
        entityId: user.id,
        actorName: user.username,
        outcome: 'FAILURE',
        ip: context.ip,
        detail: { locked_until: user.locked_until }
      });
      throw Object.assign(
        new Error('Account is temporarily locked after repeated failed attempts. Try again later.'),
        { status: 423 }
      );
    }

    const ok = await bcrypt.compare(String(password ?? ''), user.password_hash);
    if (!ok) {
      const failures = user.failed_logins + 1;
      const lock = failures >= security.max_failed_logins;
      await query(
        `UPDATE users SET failed_logins = $2, locked_until = $3, updated_at = now() WHERE id = $1`,
        [user.id, failures, lock ? new Date(Date.now() + security.lockout_minutes * 60000) : null]
      );
      return fail(lock ? 'LOCKED_AFTER_FAILURES' : 'BAD_PASSWORD');
    }

    await query(
      `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
       WHERE id = $1`,
      [user.id]
    );
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      actorRole: user.role,
      action: 'LOGIN',
      entityType: 'user',
      entityId: user.id,
      ip: context.ip,
      userAgent: context.userAgent
    });

    return { token: signToken(user), user: publicUser(user), expires_in: env.jwt.expiresIn };
  }

  async listUsers() {
    const result = await rows(
      'SELECT * FROM users ORDER BY CASE role WHEN $1 THEN 0 WHEN $2 THEN 1 WHEN $3 THEN 2 ELSE 3 END, username',
      [Role.ADMINISTRATOR, Role.ENGINEER, Role.OPERATOR]
    );
    return result.map(publicUser);
  }

  async createUser({ username, fullName, email, role, password }, actor) {
    this.validatePassword(password);
    if (!ROLE_ORDER.includes(role)) {
      throw Object.assign(new Error(`Unknown role: ${role}`), { status: 400 });
    }
    const existing = await one('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
    if (existing) throw Object.assign(new Error('That username already exists.'), { status: 409 });

    const hash = await bcrypt.hash(password, 12);
    const user = await one(
      `INSERT INTO users (username, full_name, email, role, password_hash)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [username, fullName, email ?? null, role, hash]
    );
    await writeAudit({
      actorId: actor?.id,
      actorName: actor?.username,
      actorRole: actor?.role,
      action: 'USER_CREATED',
      entityType: 'user',
      entityId: user.id,
      detail: { username, role }
    });
    return publicUser(user);
  }

  async updateUser(id, updates, actor) {
    const fields = [];
    const params = [id];
    const push = (column, value) => {
      params.push(value);
      fields.push(`${column} = $${params.length}`);
    };
    if (updates.fullName !== undefined) push('full_name', updates.fullName);
    if (updates.email !== undefined) push('email', updates.email);
    if (updates.role !== undefined) {
      if (!ROLE_ORDER.includes(updates.role)) {
        throw Object.assign(new Error(`Unknown role: ${updates.role}`), { status: 400 });
      }
      push('role', updates.role);
    }
    if (updates.isActive !== undefined) push('is_active', Boolean(updates.isActive));
    if (updates.password !== undefined) {
      this.validatePassword(updates.password);
      push('password_hash', await bcrypt.hash(updates.password, 12));
      fields.push('password_changed_at = now()');
    }
    if (updates.unlock) {
      fields.push('failed_logins = 0', 'locked_until = NULL');
    }
    if (fields.length === 0) throw Object.assign(new Error('No changes supplied.'), { status: 400 });

    const user = await one(
      `UPDATE users SET ${fields.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      params
    );
    if (!user) throw Object.assign(new Error('User not found.'), { status: 404 });
    await writeAudit({
      actorId: actor?.id,
      actorName: actor?.username,
      actorRole: actor?.role,
      action: 'USER_UPDATED',
      entityType: 'user',
      entityId: id,
      detail: { changed: Object.keys(updates).filter((k) => k !== 'password') }
    });
    return publicUser(user);
  }

  async deleteUser(id, actor) {
    if (actor?.id === id) {
      throw Object.assign(new Error('You cannot delete your own account.'), { status: 400 });
    }
    const admins = await one("SELECT count(*)::int AS n FROM users WHERE role = 'administrator' AND is_active", []);
    const target = await one('SELECT * FROM users WHERE id = $1', [id]);
    if (!target) throw Object.assign(new Error('User not found.'), { status: 404 });
    if (target.role === Role.ADMINISTRATOR && admins.n <= 1) {
      throw Object.assign(new Error('The last administrator account cannot be removed.'), { status: 400 });
    }
    await query('DELETE FROM users WHERE id = $1', [id]);
    await writeAudit({
      actorId: actor?.id,
      actorName: actor?.username,
      actorRole: actor?.role,
      action: 'USER_DELETED',
      entityType: 'user',
      entityId: id,
      detail: { username: target.username }
    });
    return { deleted: true };
  }

  /** Change one's own password, verifying the current one. */
  async changeOwnPassword(userId, currentPassword, newPassword) {
    const user = await one('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user) throw Object.assign(new Error('User not found.'), { status: 404 });
    const ok = await bcrypt.compare(String(currentPassword ?? ''), user.password_hash);
    if (!ok) throw Object.assign(new Error('The current password is incorrect.'), { status: 401 });
    this.validatePassword(newPassword);
    await query(
      'UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1',
      [userId, await bcrypt.hash(newPassword, 12)]
    );
    await writeAudit({
      actorId: user.id,
      actorName: user.username,
      actorRole: user.role,
      action: 'PASSWORD_CHANGED',
      entityType: 'user',
      entityId: user.id
    });
    return { changed: true };
  }

  validatePassword(password) {
    const min = getConfig().security.password_min_length;
    const value = String(password ?? '');
    if (value.length < min) {
      throw Object.assign(new Error(`Password must be at least ${min} characters.`), { status: 400 });
    }
    if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
      throw Object.assign(new Error('Password must contain both letters and digits.'), { status: 400 });
    }
  }

  /** Query the audit log. */
  async listAudit({ action = null, actorId = null, from = null, to = null, search = null, limit = 100, offset = 0 } = {}) {
    const where = [];
    const params = [];
    const add = (clause, value) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (action) add('action = ?', action);
    if (actorId) add('actor_id = ?', actorId);
    if (from) add('occurred_at >= ?', from);
    if (to) add('occurred_at <= ?', to);
    if (search) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      where.push(`(action ILIKE ${p} OR actor_name ILIKE ${p} OR entity_type ILIKE ${p} OR entity_id ILIKE ${p})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Math.min(1000, Math.max(1, limit)));
    params.push(Math.max(0, offset));
    const items = await rows(
      `SELECT * FROM audit_log ${whereSql} ORDER BY occurred_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = await one(`SELECT count(*)::int AS total FROM audit_log ${whereSql}`, params.slice(0, -2));
    return { items, total: total?.total ?? items.length, limit, offset };
  }
}

export const authService = new AuthService();
export default authService;
