import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { registerStaffSchema } from '../schemas';
import * as authService from '../services/auth.service';

const router = Router();

router.get('/me', authenticate, async (req, res) => {
    res.json({ data: req.authUser });
});

router.post(
    '/register-staff',
    authenticate,
    requirePermission('users', 'write'),
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

export default router;
