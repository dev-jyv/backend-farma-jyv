import { Body, Controller, HttpCode, Post, Req, UseInterceptors } from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { invoiceRagEmbedSchema } from '../../schemas';
import * as invoiceRagService from '../../services/invoice-rag.service';
import { AuthUser } from '../../types';
import { AppError, badRequest } from '../../utils/errors';
import { RateLimiter } from '../../utils/rate-limiter';
import { CurrentUser } from '../identity/decorators/current-user.decorator';
import { RequirePermission } from '../identity/decorators/require-permission.decorator';
import { FileUploadInterceptor } from '../uploads/file-upload.interceptor';

type EmbedInput = z.infer<typeof invoiceRagEmbedSchema>;

const MINUTE_MS = 60_000;
const extractLimiter = new RateLimiter(20, MINUTE_MS);
const embedLimiter = new RateLimiter(60, MINUTE_MS);

const assertWithinLimit = (limiter: RateLimiter, user: AuthUser): void => {
    if (!limiter.tryConsume(user.uid)) {
        throw new AppError(429, 'RATE_LIMITED', 'Demasiadas solicitudes, espera un minuto');
    }
};

/**
 * Facturas-RAG del POS: el backend solo hace de proxy hacia OpenRouter. El
 * archivo y el JSON confirmado viven en el SQLite local de la caja; aquí no se
 * persiste nada.
 */
@Controller('invoice-rag')
export class InvoiceRagController {
    @Post('extract')
    @RequirePermission('invoices')
    @UseInterceptors(FileUploadInterceptor)
    @HttpCode(200)
    async extract(@Req() req: Request, @CurrentUser() user: AuthUser) {
        if (!req.file) {
            throw badRequest('El archivo es requerido');
        }
        assertWithinLimit(extractLimiter, user);
        return { data: await invoiceRagService.extractInvoiceData(req.file) };
    }

    @Post('embed')
    @RequirePermission('invoices')
    @HttpCode(200)
    async embed(
        @Body(new ZodValidationPipe(invoiceRagEmbedSchema)) body: EmbedInput,
        @CurrentUser() user: AuthUser,
    ) {
        assertWithinLimit(embedLimiter, user);
        return { data: await invoiceRagService.embedText(body.text) };
    }
}
