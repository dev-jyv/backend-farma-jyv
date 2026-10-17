import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { doctorInventoryQuerySchema } from '../../schemas';
import * as doctorInventoryService from '../../services/doctor-inventory.service';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

type InventoryQuery = z.infer<typeof doctorInventoryQuerySchema>;

@Controller('doctor/inventory')
export class DoctorInventoryController {
    /**
     * Solo `medicalRecords` (admin y doctor): el manager queda fuera a propósito y no
     * hace falta migrar roles. No usar `products:read`, que tiene cajero y manager.
     */
    @Get()
    @RequirePermission('medicalRecords', 'read')
    async list(@Query(new ZodValidationPipe(doctorInventoryQuerySchema)) query: InventoryQuery) {
        const { items, meta } = await doctorInventoryService.getDoctorInventory(
            query.updatedSince,
        );
        return { data: items, meta };
    }
}
