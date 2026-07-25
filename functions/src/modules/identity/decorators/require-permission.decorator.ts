import { SetMetadata } from '@nestjs/common';
import { PermissionArea, PermissionLevel } from '../../../types';

export const PERMISSION_KEY = 'permission';

export interface RequiredPermission {
    area: PermissionArea;
    level: PermissionLevel;
}

export const RequirePermission = (area: PermissionArea, level: PermissionLevel = 'write') =>
    SetMetadata(PERMISSION_KEY, { area, level });
