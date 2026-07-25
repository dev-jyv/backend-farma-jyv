import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
    bulkCreateProductsSchema,
    createProductSchema,
    idParamSchema,
    listProductHistoryQuerySchema,
    listProductsQuerySchema,
    updateProductPricesSchema,
    updateProductSchema,
} from '../schemas';
import * as productsService from '../services/products.service';

const router = Router();

router.use(authenticate);

router.get(
    '/',
    requirePermission('products', 'read'),
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
    '/:id/purchase-history',
    requirePermission('products', 'read'),
    validate({ params: idParamSchema, query: listProductHistoryQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await productsService.getProductPurchaseHistory(
                String(req.params.id),
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

router.get(
    '/:id/sales-history',
    requirePermission('products', 'read'),
    validate({ params: idParamSchema, query: listProductHistoryQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await productsService.getProductSalesHistory(
                String(req.params.id),
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

router.get(
    '/:id/invoice-history',
    requirePermission('products', 'read'),
    validate({ params: idParamSchema, query: listProductHistoryQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await productsService.getProductInvoiceHistory(
                String(req.params.id),
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

router.get(
    '/:id',
    requirePermission('products', 'read'),
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
    requirePermission('products'),
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

router.post(
    '/bulk',
    requirePermission('products'),
    validate({ body: bulkCreateProductsSchema }),
    async (req, res, next) => {
        try {
            const result = await productsService.bulkCreateProducts(req.body.items);
            res.status(201).json({ data: result });
        } catch (error) {
            next(error);
        }
    },
);

router.patch(
    '/prices',
    requirePermission('products'),
    validate({ body: updateProductPricesSchema }),
    async (req, res, next) => {
        try {
            const products = await productsService.updateProductPrices(req.body.items);
            res.json({ data: products });
        } catch (error) {
            next(error);
        }
    },
);

router.patch(
    '/:id',
    requirePermission('products'),
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
    requirePermission('products'),
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
