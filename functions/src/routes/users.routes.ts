import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
    idParamSchema,
    listUsersQuerySchema,
    registerStaffSchema,
    updateUserSchema,
} from '../schemas';
import * as authService from '../services/auth.service';
import * as usersService from '../services/users.service';

const router = Router();

router.use(authenticate);
router.use(requireRole('admin'));

router.get(
    '/',
    validate({ query: listUsersQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await usersService.listUsers({
                activeOnly: req.query.activeOnly === 'true',
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
            const user = await usersService.getUser(String(req.params.id));
            res.json({ data: user });
        } catch (error) {
            next(error);
        }
    },
);

router.post(
    '/',
    validate({ body: registerStaffSchema }),
    async (req, res, next) => {
        try {
            const user = await authService.registerStaff(req.body);
            res.status(201).json({ data: user });
        } catch (error) {
            next(error);
        }
    },
);

router.patch(
    '/:id',
    validate({ params: idParamSchema, body: updateUserSchema }),
    async (req, res, next) => {
        try {
            const user = await usersService.updateUser(
                String(req.params.id),
                req.body,
                req.authUser!.uid,
            );
            res.json({ data: user });
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
            const user = await usersService.deactivateUser(
                String(req.params.id),
                req.authUser!.uid,
            );
            res.json({ data: user });
        } catch (error) {
            next(error);
        }
    },
);

export default router;
