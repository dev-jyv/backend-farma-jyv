import { Module } from '@nestjs/common';
import { FileUploadInterceptor } from '../uploads/file-upload.interceptor';
import { InvoiceRagController } from './invoice-rag.controller';

@Module({
    controllers: [InvoiceRagController],
    providers: [FileUploadInterceptor],
})
export class InvoiceRagModule {}
