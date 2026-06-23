import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface CachedMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface CachedConversation {
  id: string;
  title: string;
  model: string;
  messages: CachedMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  updatedAt: number;
}

@Injectable()
export class ConversationCacheService {
  private readonly logger = new Logger(ConversationCacheService.name);
  private readonly cacheFilePath: string;
  private cache: Map<string, CachedConversation> = new Map();

  constructor() {
    const contextDir = path.join(process.cwd(), 'context');
    if (!fs.existsSync(contextDir)) {
      fs.mkdirSync(contextDir, { recursive: true });
    }
    this.cacheFilePath = path.join(contextDir, 'conversations_cache.json');
    this.loadFromDisk();
  }

  // ─── Disk Persistence ───────────────────────────────────────────────────────

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const raw = fs.readFileSync(this.cacheFilePath, 'utf-8');
        const data: CachedConversation[] = JSON.parse(raw);
        for (const conv of data) {
          this.cache.set(conv.id, conv);
        }
        this.logger.log(
          `Loaded ${this.cache.size} conversations from disk cache.`,
        );
      }
    } catch (err: any) {
      this.logger.error(`Failed to load cache from disk: ${err.message}`);
    }
  }

  private saveToDisk(): void {
    try {
      const data = Array.from(this.cache.values());
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(data, null, 2));
    } catch (err: any) {
      this.logger.error(`Failed to save cache to disk: ${err.message}`);
    }
  }

  // ─── Conversation CRUD ───────────────────────────────────────────────────────

  getConversations(): ConversationSummary[] {
    return Array.from(this.cache.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({
        id: c.id,
        title: c.title,
        model: c.model,
        messageCount: c.messages.length,
        updatedAt: c.updatedAt,
      }));
  }

  getConversation(id: string): CachedConversation | null {
    return this.cache.get(id) ?? null;
  }

  createConversation(id: string, model = 'gemini-flash'): CachedConversation {
    const now = Date.now();
    const conv: CachedConversation = {
      id,
      title: `Chat ${new Date(now).toLocaleString()}`,
      model,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.cache.set(id, conv);
    this.saveToDisk();
    this.logger.log(`Created conversation: ${id}`);
    return conv;
  }

  // ─── Message CRUD ────────────────────────────────────────────────────────────

  addMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
  ): CachedMessage | null {
    const conv = this.cache.get(conversationId);
    if (!conv) {
      this.logger.warn(`Conversation ${conversationId} not found.`);
      return null;
    }

    const message: CachedMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      role,
      content,
      timestamp: Date.now(),
    };

    conv.messages.push(message);
    conv.updatedAt = Date.now();

    // Auto-set title from first user message
    if (role === 'user' && conv.messages.filter((m) => m.role === 'user').length === 1) {
      conv.title = content.slice(0, 60) + (content.length > 60 ? '…' : '');
    }

    this.cache.set(conversationId, conv);
    this.saveToDisk();
    return message;
  }

  updateMessage(
    conversationId: string,
    messageId: string,
    content: string,
  ): CachedConversation | null {
    const conv = this.cache.get(conversationId);
    if (!conv) return null;

    const msg = conv.messages.find((m) => m.id === messageId);
    if (!msg) return null;

    msg.content = content;
    conv.updatedAt = Date.now();
    this.cache.set(conversationId, conv);
    this.saveToDisk();
    this.logger.log(`Updated message ${messageId} in conversation ${conversationId}`);
    return conv;
  }

  deleteMessage(
    conversationId: string,
    messageId: string,
  ): CachedConversation | null {
    const conv = this.cache.get(conversationId);
    if (!conv) return null;

    conv.messages = conv.messages.filter((m) => m.id !== messageId);
    conv.updatedAt = Date.now();
    this.cache.set(conversationId, conv);
    this.saveToDisk();
    this.logger.log(`Deleted message ${messageId} from conversation ${conversationId}`);
    return conv;
  }

  deleteConversation(conversationId: string): boolean {
    const existed = this.cache.has(conversationId);
    this.cache.delete(conversationId);
    if (existed) this.saveToDisk();
    return existed;
  }

  clearAllConversations(): void {
    this.cache.clear();
    this.saveToDisk();
    this.logger.log('All conversations cleared.');
  }

  getMessages(conversationId: string): CachedMessage[] {
    return this.cache.get(conversationId)?.messages ?? [];
  }

  updateConversationModel(conversationId: string, model: string): void {
    const conv = this.cache.get(conversationId);
    if (conv) {
      conv.model = model;
      this.cache.set(conversationId, conv);
      this.saveToDisk();
    }
  }
}
