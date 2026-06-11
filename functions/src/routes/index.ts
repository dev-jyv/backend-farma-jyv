import { Router } from 'express';
import authRoutes from './auth.routes';
import categoriesRoutes from './categories.routes';
import productsRoutes from './products.routes';
import inventoryRoutes from './inventory.routes';
import salesRoutes from './sales.routes';
import suppliersRoutes from './suppliers.routes';
import usersRoutes from './users.routes';

const router = Router();

router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'farmajyv-api' });
});

router.use('/auth', authRoutes);
router.use('/categories', categoriesRoutes);
router.use('/products', productsRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/sales', salesRoutes);
router.use('/suppliers', suppliersRoutes);
router.use('/users', usersRoutes);

export default router;
