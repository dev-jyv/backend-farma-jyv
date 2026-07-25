import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { RolesController } from './roles.controller';
import { UsersController } from './users.controller';

@Module({
    controllers: [AuthController, RolesController, UsersController],
})
export class IdentityModule {}
