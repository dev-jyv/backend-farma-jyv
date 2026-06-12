import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
    createCategorySchema,
    idParamSchema,
    listCategoriesQuerySchema,
    updateCategorySchema,
} from '../schemas';
import * as categoriesService from '../services/categories.service';

const router = Router();

router.use(authenticate);

router.get(
    '/',
    requirePermission('categories', 'read'),
    validate({ query: listCategoriesQuerySchema }),
    async (req, res, next) => {
        try {
            const result = await categoriesService.listCategories({
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
    requirePermission('categories', 'read'),
    validate({ params: idParamSchema }),
    async (req, res, next) => {
        try {
            const category = await categoriesService.getCategory(String(req.params.id));
            res.json({ data: category });
        } catch (error) {
            next(error);
        }
    },
);

router.post(
    '/',
    requirePermission('categories'),
    validate({ body: createCategorySchema }),
    async (req, res, next) => {
        try {
            const category = await categoriesService.createCategory(req.body);
            res.status(201).json({ data: category });
        } catch (error) {
            next(error);
        }
    },
);

router.patch(
    '/:id',
    requirePermission('categories'),
    validate({ params: idParamSchema, body: updateCategorySchema }),
    async (req, res, next) => {
        try {
            const category = await categoriesService.updateCategory(
                String(req.params.id),
                req.body,
            );
            res.json({ data: category });
        } catch (error) {
            next(error);
        }
    },
);

router.delete(
    '/:id',
    requirePermission('categories'),
    validate({ params: idParamSchema }),
    async (req, res, next) => {
        try {
            const category = await categoriesService.deleteCategory(
                String(req.params.id),
            );
            res.json({ data: category });
        } catch (error) {
            next(error);
        }
    },
);

export default router;
