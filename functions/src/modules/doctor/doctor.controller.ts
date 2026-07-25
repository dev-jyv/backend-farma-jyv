import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';

@Controller('doctor')
export class DoctorController {
    @Get()
    @RequirePermission('doctor', 'read')
    getStatus() {
        return { data: { status: 'pending' } };
    }
}
