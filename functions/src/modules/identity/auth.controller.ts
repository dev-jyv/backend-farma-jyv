import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { registerStaffSchema } from '../../schemas';
import * as authService from '../../services/auth.service';
import { AuthUser } from '../../types';
import { CurrentUser } from './decorators/current-user.decorator';
import {
    AnyAuthenticated,
    RequirePermission,
} from './decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type RegisterStaffInput = z.infer<typeof registerStaffSchema>;

@Controller('auth')
export class AuthController {
    // Devuelve el propio perfil ya resuelto por `AuthGuard`: cualquier rol
    // activo necesita llamarlo justo para saber qué rol tiene, así que no puede
    // exigir un permiso concreto. Marcado a propósito, no por omisión.
    @Get('me')
    @AnyAuthenticated()
    getMe(@CurrentUser() user: AuthUser) {
        return { data: user };
    }

    // Alias de POST /users — path canónico de alta de personal.
    @Post('register-staff')
    @RequirePermission('users', 'write')
    @HttpCode(201)
    async registerStaff(
        @Body(new ZodValidationPipe(registerStaffSchema)) body: RegisterStaffInput,
    ) {
        const user = await authService.registerStaff(body);
        return { data: user };
    }
}
