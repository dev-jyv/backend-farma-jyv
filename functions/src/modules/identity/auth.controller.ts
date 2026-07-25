import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { registerStaffSchema } from '../../schemas';
import * as authService from '../../services/auth.service';
import { AuthUser } from '../../types';
import { CurrentUser } from './decorators/current-user.decorator';
import { RequirePermission } from './decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type RegisterStaffInput = z.infer<typeof registerStaffSchema>;

@Controller('auth')
export class AuthController {
    @Get('me')
    getMe(@CurrentUser() user: AuthUser) {
        return { data: user };
    }

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
