/**
 * Express middleware: authentication, RBAC, validation, rate limiting, audit
 * and error handling (Section 22).
 */

import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { verifyToken, roleAtLeast, writeAudit } from '../services/authService.js';
import { env, getConfig } from '../config/index.js';
import { Role } from '../models/enums.js';
import { one } from '../db/pool.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('http');

/** Extract a bearer token from the Authorization header. */
function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

/**
 * Attach `req.user` when a valid token is present. Does not reject: routes
 * declare their own requirement, so a public route stays public.
 */
export function attachUser(req, res, next) {
  const token = bearerToken(req);
  if (!token) return next();
  try {
    const claims = verifyToken(token);
    req.user = { id: claims.sub, username: claims.username, role: claims.role, name: claims.name };
  } catch (err) {
    req.authError = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN';
  }
  return next();
}

/** Require an authenticated user. */
export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (env.allowAnonymousViewer) {
    req.user = { id: null, username: 'anonymous', role: Role.VIEWER, name: 'Anonymous viewer' };
    return next();
  }
  return res.status(401).json({
    error: req.authError ?? 'AUTHENTICATION_REQUIRED',
    message:
      req.authError === 'TOKEN_EXPIRED'
        ? 'Your session has expired. Sign in again.'
        : 'Sign in to access this resource.'
  });
}

/**
 * Require at least the given role.
 * @param {string} role
 */
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED', message: 'Sign in to access this resource.' });
    }
    if (!roleAtLeast(req.user.role, role)) {
      writeAudit({
        actorId: req.user.id,
        actorName: req.user.username,
        actorRole: req.user.role,
        action: 'ACCESS_DENIED',
        entityType: 'route',
        entityId: `${req.method} ${req.originalUrl}`,
        outcome: 'FAILURE',
        ip: req.ip,
        detail: { required_role: role }
      });
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: `This action requires the ${role} role. You are signed in as ${req.user.role}.`,
        required_role: role,
        your_role: req.user.role
      });
    }
    return next();
  };
}

/**
 * Validate a request section against a zod schema, replacing it with the
 * parsed value so downstream handlers work with typed, defaulted data.
 * @param {import('zod').ZodTypeAny} schema
 * @param {'body'|'query'|'params'} section
 */
export function validate(schema, section = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[section]);
    if (!result.success) {
      return res.status(400).json({
        error: 'VALIDATION_FAILED',
        message: 'The request could not be accepted.',
        details: result.error.issues.map((i) => ({
          field: i.path.join('.') || '(root)',
          message: i.message,
          code: i.code
        }))
      });
    }
    // req.query is a getter on newer Express versions; assign onto a shadow.
    if (section === 'query') req.validatedQuery = result.data;
    else req[section] = result.data;
    return next();
  };
}

/**
 * Require the named path parameters to be UUIDs.
 *
 * Without this an identifier like `none` reaches PostgreSQL, which rejects it
 * with `22P02 invalid input syntax for type uuid`. That surfaced as a 500 and a
 * logged SQL error for what is simply a malformed request - the caller should
 * be told their identifier is wrong, not that the server broke.
 */
export function uuidParams(...names) {
  const schema = z.object(
    Object.fromEntries(names.map((name) => [name, z.string().uuid(`${name} must be a UUID`)]))
  );
  return validate(schema, 'params');
}

/** Access the validated query, falling back to the raw one. */
export function q(req) {
  return req.validatedQuery ?? req.query;
}

/** General API rate limiter. */
export const apiLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many requests. Slow down and try again shortly.' }
});

/** Higher limit for the sensor-ingestion endpoints. */
export const ingestLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.ingestMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Ingestion rate limit exceeded.' }
});

/** Deliberately strict limiter for authentication, to blunt credential stuffing. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: 'RATE_LIMITED',
    message: 'Too many sign-in attempts from this address. Try again in a few minutes.'
  }
});

/**
 * Write an audit record for a state-changing request.
 * @param {string} action
 */
export function audit(action, entityType = null) {
  return (req, res, next) => {
    res.on('finish', () => {
      // Only successful mutations are recorded as actions; failures are
      // recorded with their status so a rejected attempt is still visible.
      writeAudit({
        actorId: req.user?.id ?? null,
        actorName: req.user?.username ?? null,
        actorRole: req.user?.role ?? null,
        action,
        entityType,
        entityId: req.params?.id ?? req.params?.scenario_id ?? req.params?.session_id ?? null,
        outcome: res.statusCode < 400 ? 'SUCCESS' : 'FAILURE',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        detail: {
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          body: redactBody(req.body)
        }
      });
    });
    next();
  };
}

function redactBody(body) {
  if (!body || typeof body !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (/password|token|secret/i.test(k)) out[k] = '[REDACTED]';
    else if (typeof v === 'string' && v.length > 500) out[k] = `${v.slice(0, 200)}… (${v.length} chars)`;
    else if (Array.isArray(v) && v.length > 20) out[k] = `[${v.length} items]`;
    else out[k] = v;
  }
  return out;
}

/** Wrap an async handler so rejections reach the error middleware. */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** 404 handler. */
export function notFound(req, res) {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: `No route matches ${req.method} ${req.originalUrl}.`
  });
}

/**
 * Central error handler.
 *
 * Internal details are logged in full and never returned to the client, but
 * every response carries a correlation id so an operator can quote it and an
 * engineer can find the corresponding log line.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.status ?? err.statusCode ?? 500;
  const correlationId = `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  if (status >= 500) {
    log.error('request failed', {
      correlation_id: correlationId,
      method: req.method,
      path: req.originalUrl,
      message: err.message,
      stack: err.stack
    });
  } else {
    log.warn('request rejected', {
      correlation_id: correlationId,
      method: req.method,
      path: req.originalUrl,
      status,
      message: err.message
    });
  }

  if (err instanceof z.ZodError) {
    return res.status(400).json({
      error: 'VALIDATION_FAILED',
      message: 'The request could not be accepted.',
      correlation_id: correlationId,
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }))
    });
  }

  // Postgres error codes worth translating for the operator.
  if (err.code === '23505') {
    return res.status(409).json({
      error: 'CONFLICT',
      message: 'That record already exists.',
      correlation_id: correlationId
    });
  }
  if (err.code === '22P02') {
    // A malformed identifier reached the database - a bad request, not a
    // server fault. Routes validate their parameters (see `uuidParams`); this
    // is the safety net so a route that forgets still answers 400 rather than
    // reporting an internal error for the caller's typo.
    return res.status(400).json({
      error: 'INVALID_IDENTIFIER',
      message: 'An identifier in the request is not a valid UUID.',
      correlation_id: correlationId
    });
  }
  if (err.code === '23503') {
    return res.status(409).json({
      error: 'CONFLICT',
      message: 'That record is referenced by other data and cannot be changed.',
      correlation_id: correlationId
    });
  }
  if (err.code === 'ECONNREFUSED' || err.code === '57P01' || err.code === '08006') {
    return res.status(503).json({
      error: 'DATABASE_UNAVAILABLE',
      message: 'The database is not reachable. Navigation processing continues; recorded data may be incomplete.',
      correlation_id: correlationId
    });
  }

  return res.status(status).json({
    error: err.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'),
    message:
      status >= 500
        ? 'An unexpected error occurred. Quote the correlation id when reporting this.'
        : err.message,
    correlation_id: correlationId
  });
}

/**
 * Security headers beyond what helmet sets by default, tuned for an
 * API + SPA deployment.
 */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cache-Control', 'no-store');
  // Names the platform and its status so a captured response cannot be
  // mistaken for a certified navigation source.
  res.setHeader('X-AMNP-Classification', getConfig().platform.classification);
  next();
}

/** Verify that a user id in a token still corresponds to an active account. */
export async function ensureActiveUser(req, res, next) {
  if (!req.user?.id) return next();
  try {
    const row = await one('SELECT is_active, role FROM users WHERE id = $1', [req.user.id]);
    if (!row || !row.is_active) {
      return res.status(401).json({
        error: 'ACCOUNT_INACTIVE',
        message: 'This account is no longer active. Sign in again.'
      });
    }
    // A role change takes effect immediately rather than at token expiry.
    req.user.role = row.role;
  } catch {
    // If the database is unreachable, fall back to the token's claims rather
    // than locking every operator out of a running bridge display.
    log.warn('could not verify user account; falling back to token claims');
  }
  return next();
}

export { Role };
