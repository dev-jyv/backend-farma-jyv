import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { registerStaffSchema } from '../schemas';
import * as authService from '../services/auth.service';

const router = Router();

router.get('/me', authenticate, async (req, res, next) => {
    try {
        const user = await authService.getAuthenticatedUser(req.authUser!.uid);
        res.json({ data: user });
    } catch (error) {
        next(error);
    }
});

router.post(
    '/register-staff',
    authenticate,
    requireRole('admin'),
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
