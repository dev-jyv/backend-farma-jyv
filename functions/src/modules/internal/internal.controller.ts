import { Controller, Headers, Post } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { migrateUsersToRoleIds, seedSystemRoles } from '../../services/roles.service';
import { forbidden } from '../../utils/errors';
import { Public } from '../identity/decorators/public.decorator';

const secretMatches = (provided: string, expected: string): boolean => {
    const providedBuffer = Buffer.from(provided);
    const expectedBuffer = Buffer.from(expected);
    if (providedBuffer.length !== expectedBuffer.length) {
        return false;
    }
    return timingSafeEqual(providedBuffer, expectedBuffer);
};

@Controller('internal')
export class InternalController {
    @Public()
    @Post('migrate-roles')
    async migrateRoles(@Headers('x-migrate-secret') providedSecret?: string) {
        const secret = process.env.MIGRATE_SECRET;
        if (!secret || !providedSecret || !secretMatches(providedSecret, secret)) {
            throw forbidden();
        }

        const roleIds = await seedSystemRoles();
        const migrated = await migrateUsersToRoleIds(roleIds);

        return { data: { roleIds, migrated } };
    }
}
