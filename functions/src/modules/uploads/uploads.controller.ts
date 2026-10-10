import { Controller, HttpCode, Post, Req, UseInterceptors } from '@nestjs/common';
import { Request } from 'express';
import * as uploadsService from '../../services/uploads.service';
import { AuthUser } from '../../types';
import { badRequest } from '../../utils/errors';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { FileUploadInterceptor } from './file-upload.interceptor';

@Controller('uploads')
export class UploadsController {
    @Post()
    @RequirePermission('uploads')
    @UseInterceptors(FileUploadInterceptor)
    @HttpCode(201)
    async upload(@Req() req: Request, @CurrentUser() user: AuthUser) {
        if (!req.file) {
            throw badRequest('El archivo es requerido');
        }

        const result = await uploadsService.uploadFileToStorage(req.file, 'default', user.uid);
        return { data: result };
    }

    /**
     * Comprobantes de factura: van a Cloudflare R2.
     *
     * Ruta aparte y no un campo del multipart porque el interceptor solo procesa
     * el archivo —es donde vive la validación por *magic numbers*— y abrirlo a
     * leer campos extra es superficie que no hace falta. Mismo permiso y mismo
     * interceptor: solo cambia el destino.
     */
    @Post('facturas')
    @RequirePermission('uploads')
    @UseInterceptors(FileUploadInterceptor)
    @HttpCode(201)
    async uploadInvoice(@Req() req: Request, @CurrentUser() user: AuthUser) {
        if (!req.file) {
            throw badRequest('El archivo es requerido');
        }

        const result = await uploadsService.uploadFileToStorage(req.file, 'invoices', user.uid);
        return { data: result };
    }
}
