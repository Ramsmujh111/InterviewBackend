import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { ConversationCacheService } from './conversation-cache.service';

@Module({
  providers: [AiService, ConversationCacheService],
  controllers: [AiController],
  exports: [AiService, ConversationCacheService],
})
export class AiModule {}
