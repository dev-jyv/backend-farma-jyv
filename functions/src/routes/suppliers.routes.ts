import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
    createSupplierSchema,
    idParamSchema,
    listSuppliersQuerySchema,
    updateSupplierSchema,
} from '../schemas';
import * as suppliersService from '../services/suppliers.service';

const router = Router();

router.use(authenticate);

router.get(
    '/',
    requirePermission('suppliers', 'read'),
    validate({ query: listSuppliersQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await suppliersService.listSuppliers({
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
    requirePermission('suppliers', 'read'),
    validate({ params: idParamSchema }),
    async (req, res, next) => {
        try {
            const supplier = await suppliersService.getSupplier(String(req.params.id));
            res.json({ data: supplier });
        } catch (error) {
            next(error);
        }
    },
);

router.post(
    '/',
    requirePermission('suppliers'),
    validate({ body: createSupplierSchema }),
    async (req, res, next) => {
        try {
            const supplier = await suppliersService.createSupplier(req.body);
            res.status(201).json({ data: supplier });
        } catch (error) {
            next(error);
        }
    },
);

router.patch(
    '/:id',
    requirePermission('suppliers'),
    validate({ params: idParamSchema, body: updateSupplierSchema }),
    async (req, res, next) => {
        try {
            const supplier = await suppliersService.updateSupplier(
                String(req.params.id),
                req.body,
            );
            res.json({ data: supplier });
        } catch (error) {
            next(error);
        }
    },
);

router.delete(
    '/:id',
    requirePermission('suppliers'),
    validate({ params: idParamSchema }),
    async (req, res, next) => {
        try {
            const supplier = await suppliersService.deleteSupplier(
                String(req.params.id),
            );
            res.json({ data: supplier });
        } catch (error) {
            next(error);
        }
    },
);

export default router;
