/** Authentication and user administration routes. */

import { Router } from 'express';
import { z } from 'zod';
import { authService, publicUser } from '../../services/authService.js';
import { one } from '../../db/pool.js';
import { asyncHandler, requireAuth, requireRole, validate, authLimiter, audit, q } from '../../middleware/index.js';
import { Role } from '../../models/enums.js';

const router = Router();

const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256)
});

const CreateUserSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, digits, dot, underscore or hyphen only.'),
  fullName: z.string().min(1).max(120),
  email: z.string().email().max(160).optional().nullable(),
  role: z.enum([Role.VIEWER, Role.OPERATOR, Role.ENGINEER, Role.ADMINISTRATOR]),
  password: z.string().min(8).max(256)
});

const UpdateUserSchema = z
  .object({
    fullName: z.string().min(1).max(120).optional(),
    email: z.string().email().max(160).nullable().optional(),
    role: z.enum([Role.VIEWER, Role.OPERATOR, Role.ENGINEER, Role.ADMINISTRATOR]).optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(8).max(256).optional(),
    unlock: z.boolean().optional()
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Supply at least one field to change.' });

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256)
});

router.post(
  '/login',
  authLimiter,
  validate(LoginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body.username, req.body.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });
    res.json(result);
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.user.id) return res.json({ user: req.user, anonymous: true });
    const row = await one('SELECT * FROM users WHERE id = $1', [req.user.id]);
    res.json({ user: publicUser(row) ?? req.user });
  })
);

router.post(
  '/change-password',
  requireAuth,
  validate(ChangePasswordSchema),
  audit('PASSWORD_CHANGE_REQUEST', 'user'),
  asyncHandler(async (req, res) => {
    const result = await authService.changeOwnPassword(req.user.id, req.body.currentPassword, req.body.newPassword);
    res.json(result);
  })
);

router.post(
  '/logout',
  requireAuth,
  audit('LOGOUT', 'user'),
  asyncHandler(async (req, res) => {
    // Tokens are stateless and short lived; the client discards it. A
    // server-side deny-list is documented in docs/security.md as a production
    // requirement rather than pretended to exist here.
    res.json({ ok: true, message: 'Signed out. Discard the token on the client.' });
  })
);

// --- User administration ----------------------------------------------------

router.get(
  '/users',
  requireAuth,
  requireRole(Role.ADMINISTRATOR),
  asyncHandler(async (req, res) => {
    res.json({ items: await authService.listUsers() });
  })
);

router.post(
  '/users',
  requireAuth,
  requireRole(Role.ADMINISTRATOR),
  validate(CreateUserSchema),
  audit('USER_CREATE', 'user'),
  asyncHandler(async (req, res) => {
    res.status(201).json({ user: await authService.createUser(req.body, req.user) });
  })
);

router.put(
  '/users/:id',
  requireAuth,
  requireRole(Role.ADMINISTRATOR),
  validate(UpdateUserSchema),
  audit('USER_UPDATE', 'user'),
  asyncHandler(async (req, res) => {
    res.json({ user: await authService.updateUser(req.params.id, req.body, req.user) });
  })
);

router.delete(
  '/users/:id',
  requireAuth,
  requireRole(Role.ADMINISTRATOR),
  audit('USER_DELETE', 'user'),
  asyncHandler(async (req, res) => {
    res.json(await authService.deleteUser(req.params.id, req.user));
  })
);

// --- Audit log --------------------------------------------------------------

const AuditQuerySchema = z.object({
  action: z.string().max(64).optional(),
  actorId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0)
});

router.get(
  '/audit',
  requireAuth,
  requireRole(Role.ENGINEER),
  validate(AuditQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    res.json(await authService.listAudit(q(req)));
  })
);

export default router;
