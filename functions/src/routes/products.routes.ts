import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
    createProductSchema,
    idParamSchema,
    listProductsQuerySchema,
    updateProductSchema,
} from '../schemas';
import * as productsService from '../services/products.service';

const router = Router();

router.use(authenticate);

router.get(
    '/',
    validate({ query: listProductsQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await productsService.listProducts({
                categoryId: req.query.categoryId as string | undefined,
                search: req.query.search as string | undefined,
                activeOnly: req.query.activeOnly !== 'false',
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
            const product = await productsService.getProduct(String(req.params.id));
            res.json({ data: product });
        } catch (error) {
            next(error);
        }
    },
);

router.post(
    '/',
    requireRole('admin', 'inventory'),
    validate({ body: createProductSchema }),
    async (req, res, next) => {
        try {
            const product = await productsService.createProduct(req.body);
            res.status(201).json({ data: product });
        } catch (error) {
            next(error);
        }
    },
);

router.patch(
    '/:id',
    requireRole('admin', 'inventory'),
    validate({ params: idParamSchema, body: updateProductSchema }),
    async (req, res, next) => {
        try {
            const product = await productsService.updateProduct(
                String(req.params.id),
                req.body,
            );
            res.json({ data: product });
        } catch (error) {
            next(error);
        }
    },
);

router.delete(
    '/:id',
    requireRole('admin', 'inventory'),
    validate({ params: idParamSchema }),
    async (req, res, next) => {
        try {
            const product = await productsService.deleteProduct(
                String(req.params.id),
            );
            res.json({ data: product });
        } catch (error) {
            next(error);
        }
    },
);

export default router;
