import { Module } from '@nestjs/common';
import { AssistantController } from './assistant.controller';

@Module({
    controllers: [AssistantController],
})
export class AssistantModule {}
