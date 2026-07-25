import { Module } from '@nestjs/common';
import { FileUploadInterceptor } from './file-upload.interceptor';
import { UploadsController } from './uploads.controller';

@Module({
    controllers: [UploadsController],
    providers: [FileUploadInterceptor],
})
export class UploadsModule {}
