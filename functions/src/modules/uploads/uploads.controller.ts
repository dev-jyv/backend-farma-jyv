import { Controller, HttpCode, Post, Req, UseInterceptors } from '@nestjs/common';
import { Request } from 'express';
import * as uploadsService from '../../services/uploads.service';
import { badRequest } from '../../utils/errors';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { FileUploadInterceptor } from './file-upload.interceptor';

@Controller('uploads')
export class UploadsController {
    @Post()
    @RequirePermission('uploads')
    @UseInterceptors(FileUploadInterceptor)
    @HttpCode(201)
    async upload(@Req() req: Request) {
        if (!req.file) {
            throw badRequest('El archivo es requerido');
        }

        const result = await uploadsService.uploadFileToStorage(req.file);
        return { data: result };
    }
}
