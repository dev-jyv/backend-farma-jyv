import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
    createRoleSchema,
    idParamSchema,
    listRolesQuerySchema,
    updateRoleSchema,
} from '../schemas';
import * as rolesService from '../services/roles.service';

const router = Router();

router.use(authenticate);
router.use(requirePermission('users', 'write'));

router.get(
    '/',
    validate({ query: listRolesQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await rolesService.listRoles({
                activeOnly: req.query.activeOnly !== 'false',
                search: req.query.search as string | undefined,
                page: req.query.page ? Number(req.query.page) : undefined,
                limit: req.query.limit ? Number(req.query.limit) : undefined,
            });
            res.json({ data: result.items, meta: result.meta });
        } catch (error) {
            next(error);
        }
    },
);

router.get(
    '/:id',
    validate({ params: idParamSchema }),
    async (req, res, next) => {
        try {
            const role = await rolesService.getRole(String(req.params.id));
            res.json({ data: role });
        } catch (error) {
            next(error);
        }
    },
);

router.post(
    '/',
    validate({ body: createRoleSchema }),
    async (req, res, next) => {
        try {
            const role = await rolesService.createRole(req.body);
            res.status(201).json({ data: role });
        } catch (error) {
            next(error);
        }
    },
);

router.patch(
    '/:id',
    validate({ params: idParamSchema, body: updateRoleSchema }),
    async (req, res, next) => {
        try {
            const role = await rolesService.updateRole(String(req.params.id), req.body);
            res.json({ data: role });
        } catch (error) {
            next(error);
        }
    },
);

router.delete(
    '/:id',
    validate({ params: idParamSchema }),
    async (req, res, next) => {
        try {
            const role = await rolesService.deleteRole(String(req.params.id));
            res.json({ data: role });
        } catch (error) {
            next(error);
        }
    },
);

export default router;
