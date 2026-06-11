import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
    inventoryEntrySchema,
    inventoryExitSchema,
    idParamSchema,
    listBatchesQuerySchema,
    listEntriesQuerySchema,
    listMovementsQuerySchema,
} from '../schemas';
import * as inventoryService from '../services/inventory.service';

const router = Router();

router.use(authenticate);

router.get(
    '/batches',
    validate({ query: listBatchesQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await inventoryService.listBatches(
                req.query.productId as string,
                {
                    search: req.query.search as string | undefined,
                    page: req.query.page ? Number(req.query.page) : undefined,
                    limit: req.query.limit ? Number(req.query.limit) : undefined,
                },
            );
            res.json({ data: result.items, meta: result.meta });
        } catch (error) {
            next(error);
        }
    },
);

router.post(
    '/entries',
    requireRole('admin', 'inventory'),
    validate({ body: inventoryEntrySchema }),
    async (req, res, next) => {
        try {
            const entry = await inventoryService.recordEntry({
                supplierId: req.body.supplierId,
                items: req.body.products,
                userId: req.authUser!.uid,
            });
            res.status(201).json({ data: entry });
        } catch (error) {
            next(error);
        }
    },
);

router.get(
    '/entries',
    requireRole('admin', 'inventory'),
    validate({ query: listEntriesQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await inventoryService.listEntries({
                supplierId: req.query.supplierId as string | undefined,
                from: req.query.from as string | undefined,
                to: req.query.to as string | undefined,
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
    '/entries/:id',
    requireRole('admin', 'inventory'),
    validate({ params: idParamSchema }),
    async (req, res, next) => {
        try {
            const entry = await inventoryService.getEntry(String(req.params.id));
            res.json({ data: entry });
        } catch (error) {
            next(error);
        }
    },
);

router.post(
    '/exits',
    requireRole('admin', 'inventory'),
    validate({ body: inventoryExitSchema }),
    async (req, res, next) => {
        try {
            const result = await inventoryService.recordExit({
                ...req.body,
                userId: req.authUser!.uid,
            });
            res.status(201).json({ data: result });
        } catch (error) {
            next(error);
        }
    },
);

router.get(
    '/movements',
    requireRole('admin', 'inventory'),
    validate({ query: listMovementsQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await inventoryService.listMovements({
                productId: req.query.productId as string | undefined,
                type: req.query.type as
                    | 'entry'
                    | 'exit_waste'
                    | 'exit_expiry'
                    | 'sale_adjustment'
                    | undefined,
                from: req.query.from as string | undefined,
                to: req.query.to as string | undefined,
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

export default router;
