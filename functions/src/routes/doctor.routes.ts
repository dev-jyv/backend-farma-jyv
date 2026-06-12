import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';

const router = Router();

router.use(authenticate);

router.get('/', requirePermission('doctor', 'read'), (_req, res) => {
    res.json({ data: { status: 'pending' } });
});

export default router;
