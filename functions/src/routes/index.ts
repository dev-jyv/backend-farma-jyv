import { Router } from 'express';
import authRoutes from './auth.routes';
import categoriesRoutes from './categories.routes';
import productsRoutes from './products.routes';
import inventoryRoutes from './inventory.routes';
import invoicesRoutes from './invoices.routes';
import uploadsRoutes from './uploads.routes';
import salesRoutes from './sales.routes';
import suppliersRoutes from './suppliers.routes';
import usersRoutes from './users.routes';
import rolesRoutes from './roles.routes';
import doctorRoutes from './doctor.routes';
import internalRoutes from './internal.routes';

const router = Router();

router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'farmajyv-api' });
});

router.use('/auth', authRoutes);
router.use('/categories', categoriesRoutes);
router.use('/products', productsRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/invoices', invoicesRoutes);
router.use('/uploads', uploadsRoutes);
router.use('/sales', salesRoutes);
router.use('/suppliers', suppliersRoutes);
router.use('/users', usersRoutes);
router.use('/roles', rolesRoutes);
router.use('/doctor', doctorRoutes);
router.use('/internal', internalRoutes);

export default router;
