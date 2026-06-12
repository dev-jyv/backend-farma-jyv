import { Router } from 'express';
import { migrateUsersToRoleIds, seedSystemRoles } from '../services/roles.service';
import { forbidden } from '../utils/errors';

const router = Router();

router.post('/migrate-roles', async (req, res, next) => {
    try {
        const secret = process.env.MIGRATE_SECRET;
        if (!secret || req.headers['x-migrate-secret'] !== secret) {
            throw forbidden();
        }

        const roleIds = await seedSystemRoles();
        const migrated = await migrateUsersToRoleIds(roleIds);

        res.json({
            data: {
                roleIds,
                migrated,
            },
        });
    } catch (error) {
        next(error);
    }
});

export default router;
