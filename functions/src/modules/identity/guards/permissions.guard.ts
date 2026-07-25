import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { hasPermission } from '../../../constants/permissions';
import { forbidden, unauthorized } from '../../../utils/errors';
import { PERMISSION_KEY, RequiredPermission } from '../decorators/require-permission.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        const required = this.reflector.getAllAndOverride<RequiredPermission | undefined>(
            PERMISSION_KEY,
            [context.getHandler(), context.getClass()],
        );
        if (!required) {
            return true;
        }

        const req = context.switchToHttp().getRequest<Request>();
        if (!req.authUser) {
            throw unauthorized();
        }

        const allowed = hasPermission(
            req.authUser.permissions,
            required.area,
            required.level,
            req.authUser.role.slug,
        );
        if (!allowed) {
            throw forbidden();
        }

        return true;
    }
}
