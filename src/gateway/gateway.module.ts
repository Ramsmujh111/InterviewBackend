import { Module } from '@nestjs/common';
import { InterviewGateway } from './interview.gateway';
import { AiModule } from '../ai/ai.module';
import { TranscriptionModule } from '../transcription/transcription.module';
import { RagModule } from '../rag/rag.module';

@Module({
  imports: [AiModule, TranscriptionModule, RagModule],
  providers: [InterviewGateway],
})
export class GatewayModule {}
