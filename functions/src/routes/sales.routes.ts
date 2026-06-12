import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
    createSaleSchema,
    idParamSchema,
    listSalesQuerySchema,
} from '../schemas';
import * as salesService from '../services/sales.service';

const router = Router();

router.use(authenticate);
router.use(requirePermission('sales'));

router.post(
    '/',
    validate({ body: createSaleSchema }),
    async (req, res, next) => {
        try {
            const sale = await salesService.createSale({
                ...req.body,
                cashierId: req.authUser!.uid,
            });
            res.status(201).json({ data: sale });
        } catch (error) {
            next(error);
        }
    },
);

router.get(
    '/',
    validate({ query: listSalesQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await salesService.listSales({
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
    '/:id',
    validate({ params: idParamSchema }),
    async (req, res, next) => {
        try {
            const sale = await salesService.getSale(String(req.params.id));
            res.json({ data: sale });
        } catch (error) {
            next(error);
        }
    },
);

export default router;
