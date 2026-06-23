import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { AiService } from '../ai/ai.service';
import {
  TranscriptionService,
  TranscriptionError,
} from '../transcription/transcription.service';
import { RagService } from '../rag/rag.service';
import { ConversationCacheService } from '../ai/conversation-cache.service';

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
})
export class InterviewGateway
  implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(InterviewGateway.name);
  private clientSessions: Map<
    string,
    {
      transcription: ReturnType<
        TranscriptionService['createLiveTranscription']
      > | null;
      model: string;
      fullTranscript: string;
      lastScreenshot: string | null;
      activeConversationId: string | null;
    }
  > = new Map();

  constructor(
    private aiService: AiService,
    private transcriptionService: TranscriptionService,
    private ragService: RagService,
    private cacheService: ConversationCacheService,
  ) { }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.clientSessions.set(client.id, {
      transcription: null,
      model: 'gemini-flash',
      fullTranscript: '',
      lastScreenshot: null,
      activeConversationId: null,
    });

    // Send the conversations list on connect
    client.emit('conversations-list', {
      conversations: this.cacheService.getConversations(),
    });
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    const session = this.clientSessions.get(client.id);
    if (session?.transcription) {
      session.transcription.close();
    }
    this.clientSessions.delete(client.id);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Cache-related handlers
  // ─────────────────────────────────────────────────────────────────────────────

  @SubscribeMessage('get-conversations')
  handleGetConversations(@ConnectedSocket() client: Socket) {
    client.emit('conversations-list', {
      conversations: this.cacheService.getConversations(),
    });
  }

  @SubscribeMessage('create-conversation')
  handleCreateConversation(
    @MessageBody() data: { model?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const session = this.clientSessions.get(client.id);
    if (!session) return;

    const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const model = data.model || session.model || 'gemini-flash';
    const conv = this.cacheService.createConversation(id, model);

    session.activeConversationId = id;
    session.fullTranscript = '';

    client.emit('conversation-loaded', { conversation: conv });
    client.emit('conversations-list', {
      conversations: this.cacheService.getConversations(),
    });
  }

  @SubscribeMessage('select-conversation')
  handleSelectConversation(
    @MessageBody() data: { id: string },
    @ConnectedSocket() client: Socket,
  ) {
    const session = this.clientSessions.get(client.id);
    if (!session) return;

    const conv = this.cacheService.getConversation(data.id);
    if (!conv) {
      client.emit('error', {
        message: `Conversation ${data.id} not found.`,
        type: 'unknown',
        retryable: false,
      });
      return;
    }

    session.activeConversationId = data.id;
    session.model = conv.model;
    // Rebuild transcript from message history
    session.fullTranscript = conv.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join(' ');

    client.emit('conversation-loaded', { conversation: conv });
  }

  @SubscribeMessage('update-message')
  handleUpdateMessage(
    @MessageBody() data: { messageId: string; content: string },
    @ConnectedSocket() client: Socket,
  ) {
    const session = this.clientSessions.get(client.id);
    if (!session?.activeConversationId) {
      client.emit('error', {
        message: 'No active conversation to update.',
        type: 'unknown',
        retryable: false,
      });
      return;
    }

    const updated = this.cacheService.updateMessage(
      session.activeConversationId,
      data.messageId,
      data.content,
    );

    if (updated) {
      client.emit('conversation-loaded', { conversation: updated });
      client.emit('conversations-list', {
        conversations: this.cacheService.getConversations(),
      });
    } else {
      client.emit('error', {
        message: 'Message not found.',
        type: 'unknown',
        retryable: false,
      });
    }
  }

  @SubscribeMessage('delete-message')
  handleDeleteMessage(
    @MessageBody() data: { messageId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const session = this.clientSessions.get(client.id);
    if (!session?.activeConversationId) {
      client.emit('error', {
        message: 'No active conversation.',
        type: 'unknown',
        retryable: false,
      });
      return;
    }

    const updated = this.cacheService.deleteMessage(
      session.activeConversationId,
      data.messageId,
    );

    if (updated) {
      client.emit('conversation-loaded', { conversation: updated });
      client.emit('conversations-list', {
        conversations: this.cacheService.getConversations(),
      });
    }
  }

  @SubscribeMessage('delete-conversation')
  handleDeleteConversation(
    @MessageBody() data: { id: string },
    @ConnectedSocket() client: Socket,
  ) {
    const session = this.clientSessions.get(client.id);
    this.cacheService.deleteConversation(data.id);

    if (session && session.activeConversationId === data.id) {
      session.activeConversationId = null;
      session.fullTranscript = '';
      client.emit('conversation-loaded', { conversation: null });
    }

    client.emit('conversations-list', {
      conversations: this.cacheService.getConversations(),
    });
  }

  @SubscribeMessage('clear-all-conversations')
  handleClearAllConversations(@ConnectedSocket() client: Socket) {
    const session = this.clientSessions.get(client.id);
    this.cacheService.clearAllConversations();

    if (session) {
      session.activeConversationId = null;
      session.fullTranscript = '';
    }

    client.emit('conversation-loaded', { conversation: null });
    client.emit('conversations-list', { conversations: [] });
    this.logger.log(`All conversations cleared by client ${client.id}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Audio / Transcription
  // ─────────────────────────────────────────────────────────────────────────────

  @SubscribeMessage('audio-chunk')
  handleAudioChunk(
    @MessageBody() data: ArrayBuffer,
    @ConnectedSocket() client: Socket,
  ) {
    const session = this.clientSessions.get(client.id);
    if (!session) {
      this.logger.warn(`No session found for client ${client.id}`);
      return;
    }

    this.logger.log(
      `Audio chunk received: ${data?.byteLength || 0} bytes from ${client.id}`,
    );

    // Create transcription session on first audio chunk
    if (!session.transcription) {
      session.transcription = this.transcriptionService.createLiveTranscription(
        (text: string, isFinal: boolean) => {
          client.emit('transcript-update', { text, isFinal });
          if (isFinal) {
            session.fullTranscript += ' ' + text;
          }
        },
        (error: TranscriptionError) => {
          client.emit('error', {
            message: error.message,
            type: error.type,
            retryable: error.retryable,
          });
          if (!error.retryable) {
            client.emit('transcription-limit-reached', {
              message: error.message,
              type: error.type,
            });
          }
        },
      );
    }

    session.transcription.sendAudio(Buffer.from(data));
  }

  @SubscribeMessage('screenshot')
  handleScreenshot(
    @MessageBody() data: { image: string },
    @ConnectedSocket() client: Socket,
  ) {
    const session = this.clientSessions.get(client.id);
    if (session) {
      session.lastScreenshot = data.image;
    }
  }

  @SubscribeMessage('clear-chat')
  handleClearChat(@ConnectedSocket() client: Socket) {
    const session = this.clientSessions.get(client.id);
    if (session) {
      session.fullTranscript = '';
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AI Actions — all integrated with conversation cache
  // ─────────────────────────────────────────────────────────────────────────────

  private ensureActiveConversation(
    client: Socket,
    session: { activeConversationId: string | null; model: string },
  ): string {
    if (!session.activeConversationId) {
      const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      this.cacheService.createConversation(id, session.model);
      session.activeConversationId = id;
      client.emit('conversations-list', {
        conversations: this.cacheService.getConversations(),
      });
    }
    return session.activeConversationId;
  }

  @SubscribeMessage('analyze-conversation')
  async handleAnalyzeConversation(
    @MessageBody() data: { model?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const session = this.clientSessions.get(client.id);
    if (!session || !session.fullTranscript.trim()) {
      client.emit('error', {
        message: 'No conversation transcript available to analyze.',
        type: 'unknown',
        retryable: false,
      });
      return;
    }

    const model = data.model || session.model || 'gemini-flash';
    const convId = this.ensureActiveConversation(client, session);

    const analysisPrompt = `Analyze the following interview conversation transcript to identify the MOST RECENT and specific question or technical topic being discussed.
Then, act as an expert and provide a concise, highly accurate, and precise answer or solution ONLY for that identified question.
DO NOT simply summarize the conversation. DO NOT answer questions that were not asked. Give a direct text answer.

Transcript:\n${session.fullTranscript}`;

    // Save user turn to cache
    this.cacheService.addMessage(convId, 'user', analysisPrompt);
    client.emit('processing-start', {});

    const history = this.cacheService.getMessages(convId).slice(0, -1).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    try {
      const response = await this.aiService.generateResponse({
        transcript: analysisPrompt,
        screenshotBase64: session.lastScreenshot || undefined,
        resumeContext: this.ragService.getContext(),
        model,
        history,
      });

      // Save assistant turn to cache
      const savedMsg = this.cacheService.addMessage(convId, 'assistant', response.text);
      const conv = this.cacheService.getConversation(convId);

      client.emit('ai-response', {
        text: response.text,
        done: true,
        messageId: savedMsg?.id,
      });
      client.emit('conversation-loaded', { conversation: conv });
      client.emit('conversations-list', {
        conversations: this.cacheService.getConversations(),
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      client.emit('error', {
        message: `Analysis failed: ${errMsg}`,
        type: 'unknown',
        retryable: false,
      });
      client.emit('ai-response', {
        text: `Error analyzing conversation: ${errMsg}`,
        done: true,
      });
    }
  }

  @SubscribeMessage('analyze-screenshot')
  async handleAnalyzeScreenshot(
    @MessageBody() data: { image?: string; question?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const session = this.clientSessions.get(client.id);
    const userModel = session?.model || 'gemini-flash';

    const screenshotBase64 = data.image || session?.lastScreenshot;

    if (!screenshotBase64) {
      client.emit('error', {
        message: 'No screenshot available. Please capture a screenshot first.',
        type: 'unknown',
        retryable: false,
      });
      return;
    }

    let analysisModel = 'gemini-flash';
    if (
      userModel === 'gpt-4o-mini' ||
      userModel === 'groq-vision' ||
      userModel === 'gemini-flash'
    ) {
      analysisModel = userModel;
    }

    const convId = session ? this.ensureActiveConversation(client, session) : null;

    const analysisPrompt = data.question
      ? `A question has been asked: "${data.question}".\nA screenshot is also provided.

CRITICAL INSTRUCTION:
1. If the screenshot is RELEVANT to the question, use it to provide a clear, actionable solution.
2. If the screenshot is IRRELEVANT or unrelated to the question, completely IGNORE the screenshot and answer the question directly based on your knowledge.
3. DO NOT describe the screen contents.
4. Output ONLY the following sections:
   - "### 3. JavaScript Implementation\\nHere is a clean implementation you can use:\\n" followed by the code.
   - "### Complexity" followed by the time and space complexity.
5. DO NOT show any "approach" or general explanation. Format your response in Markdown.`
      : `Analyze this screenshot carefully to identify any coding question or problem visible.

CRITICAL INSTRUCTION:
1. Output ONLY the following sections:
   - "### 3. JavaScript Implementation\\nHere is a clean implementation you can use:\\n" followed by the code.
   - "### Complexity" followed by the time and space complexity.
2. DO NOT show any "approach", "explanation", or step-by-step solutions.
3. DO NOT describe the screen contents.
Be concise but thorough. Format your response in Markdown.`;

    // Save user turn if we have an active conversation
    if (convId) {
      this.cacheService.addMessage(convId, 'user', data.question || '[Screenshot Analysis]');
    }

    client.emit('processing-start', {});

    const history = convId
      ? this.cacheService.getMessages(convId).slice(0, -1).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))
      : [];

    try {
      const response = await this.aiService.generateResponse({
        transcript: analysisPrompt,
        screenshotBase64,
        resumeContext: this.ragService.getContext(),
        model: analysisModel,
        history,
      });

      if (response.text.includes('Error:') && analysisModel === 'gemini-flash') {
        this.logger.warn(`Gemini analysis failed: ${response.text}. Skipping fallback since Groq vision is decommissioned.`);
        client.emit('ai-response', { text: response.text, done: true, source: 'screenshot-analysis' });
        return;
      }

      // Save AI response to cache
      if (convId) {
        const savedMsg = this.cacheService.addMessage(convId, 'assistant', response.text);
        const conv = this.cacheService.getConversation(convId);
        client.emit('ai-response', {
          text: response.text,
          done: true,
          source: 'screenshot-analysis',
          messageId: savedMsg?.id,
        });
        client.emit('conversation-loaded', { conversation: conv });
        client.emit('conversations-list', {
          conversations: this.cacheService.getConversations(),
        });
      } else {
        client.emit('ai-response', { text: response.text, done: true, source: 'screenshot-analysis' });
      }

      this.logger.log(
        `Screenshot analysis complete (${response.latency}ms, model: ${response.model})`,
      );
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Screenshot analysis failed with ${analysisModel}: ${errMsg}`);
      client.emit('ai-response', {
        text: `Error analyzing screenshot: ${errMsg}. Please check your API key for ${analysisModel}.`,
        done: true,
        source: 'screenshot-analysis',
      });
    }
  }

  @SubscribeMessage('text-query')
  async handleTextQuery(
    @MessageBody() data: { text: string; model?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const session = this.clientSessions.get(client.id);
    const model = data.model || session?.model || 'gemini-flash';

    const convId = session ? this.ensureActiveConversation(client, session) : null;

    // Save user turn to cache
    if (convId) {
      this.cacheService.addMessage(convId, 'user', data.text);
    }

    const history = convId
      ? this.cacheService.getMessages(convId).slice(0, -1).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))
      : [];

    client.emit('processing-start', {});

    try {
      const response = await this.aiService.generateResponse({
        transcript: data.text,
        screenshotBase64: session?.lastScreenshot || undefined,
        resumeContext: this.ragService.getContext(),
        model,
        history,
      });

      // Save assistant turn to cache
      if (convId) {
        const savedMsg = this.cacheService.addMessage(convId, 'assistant', response.text);
        const conv = this.cacheService.getConversation(convId);
        client.emit('ai-response', {
          text: response.text,
          done: true,
          messageId: savedMsg?.id,
        });
        client.emit('conversation-loaded', { conversation: conv });
        client.emit('conversations-list', {
          conversations: this.cacheService.getConversations(),
        });
      } else {
        client.emit('ai-response', { text: response.text, done: true });
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      client.emit('error', {
        message: `Query failed: ${errMsg}`,
        type: 'unknown',
        retryable: false,
      });
      client.emit('ai-response', {
        text: `Error: ${errMsg}`,
        done: true,
      });
    }
  }

  @SubscribeMessage('update-settings')
  handleUpdateSettings(
    @MessageBody()
    data: {
      model?: string;
      geminiKey?: string;
      openaiKey?: string;
      anthropicKey?: string;
      groqKey?: string;
      deepgramKey?: string;
      resumeContent?: string;
    },
    @ConnectedSocket() client: Socket,
  ) {
    const session = this.clientSessions.get(client.id);

    if (data.model && session) {
      session.model = data.model;
      // Update model in active conversation if there is one
      if (session.activeConversationId) {
        this.cacheService.updateConversationModel(session.activeConversationId, data.model);
      }
    }

    const apiKeys: Record<string, string> = {};
    if (data.geminiKey) apiKeys.gemini = data.geminiKey;
    if (data.openaiKey) apiKeys.openai = data.openaiKey;
    if (data.anthropicKey) apiKeys.anthropic = data.anthropicKey;
    if (data.groqKey) apiKeys.groq = data.groqKey;

    if (Object.keys(apiKeys).length > 0) {
      this.aiService.updateApiKeys(apiKeys);
    }

    if (data.deepgramKey) {
      this.transcriptionService.updateApiKey(data.deepgramKey);
    }

    if (data.resumeContent) {
      this.ragService.updateResumeContext(data.resumeContent);
    }

    client.emit('settings-updated', { success: true });
    this.logger.log(`Settings updated for client ${client.id}`);
  }
}
