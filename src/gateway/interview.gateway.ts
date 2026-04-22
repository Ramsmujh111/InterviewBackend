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
    }
  > = new Map();

  constructor(
    private aiService: AiService,
    private transcriptionService: TranscriptionService,
    private ragService: RagService,
  ) { }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.clientSessions.set(client.id, {
      transcription: null,
      model: 'gemini-flash',
      fullTranscript: '',
      lastScreenshot: null,
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
          // Send transcript update to client
          client.emit('transcript-update', { text, isFinal });

          if (isFinal) {
            session.fullTranscript += ' ' + text;
          }
        },
        (error: TranscriptionError) => {
          // Send structured error to client
          client.emit('error', {
            message: error.message,
            type: error.type,
            retryable: error.retryable,
          });

          // If it's a non-retryable error, notify client explicitly
          if (!error.retryable) {
            client.emit('transcription-limit-reached', {
              message: error.message,
              type: error.type,
            });
          }
        },
      );
    }

    // Forward audio to Deepgram
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
    client.emit('processing-start', {});

    const analysisPrompt = `Analyze the following interview conversation transcript to identify the MOST RECENT and specific question or technical topic being discussed.
Then, act as an expert and provide a concise, highly accurate, and precise answer or solution ONLY for that identified question.
DO NOT simply summarize the conversation. DO NOT answer questions that were not asked. Give a direct text answer.

Transcript:\n${session.fullTranscript}`;

    try {
      const response = await this.aiService.generateResponse({
        transcript: analysisPrompt,
        screenshotBase64: session.lastScreenshot || undefined,
        resumeContext: this.ragService.getContext(),
        model,
      });

      client.emit('ai-response', {
        text: response.text,
        done: true,
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

  /**
   * ── Analyze Screenshot ──
   * Takes the current/provided screenshot, sends it to AI for analysis,
   * and returns solutions/answers based on what's visible on screen.
   */
  @SubscribeMessage('analyze-screenshot')
  async handleAnalyzeScreenshot(
    @MessageBody() data: { image?: string; question?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const session = this.clientSessions.get(client.id);
    const userModel = session?.model || 'gemini-flash';

    // Use provided image or the last captured screenshot
    const screenshotBase64 = data.image || session?.lastScreenshot;

    if (!screenshotBase64) {
      client.emit('error', {
        message: 'No screenshot available. Please capture a screenshot first.',
        type: 'unknown',
        retryable: false,
      });
      return;
    }

    client.emit('processing-start', {});

    // For screenshot analysis, prioritize Gemini Flash (fast + great vision).
    // If Gemini is not requested/available, use groq-vision as fallback.
    // If user explicitly chose a vision capable model like gpt-4o, honor it.
    let analysisModel = 'gemini-flash';
    if (
      userModel === 'gpt-4o' ||
      userModel === 'groq-vision' ||
      userModel === 'gemini-flash'
    ) {
      analysisModel = userModel;
    } else {
      // Fallback: Default to gemini-flash, but if they want groq specifically, we could do groq-vision
      // But the request says: "make the grok second choose but first internally choose gemini"
      analysisModel = 'gemini-flash';
    }

    this.logger.log(
      `Analyzing screenshot for client ${client.id} using model ${analysisModel} (user model: ${userModel})`,
    );

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

    try {
      const response = await this.aiService.generateResponse({
        transcript: analysisPrompt,
        screenshotBase64,
        resumeContext: this.ragService.getContext(),
        model: analysisModel,
      });

      // Special fallback if gemini was chosen but failed (likely due to missing key)
      if (
        response.text.includes('Error:') &&
        analysisModel === 'gemini-flash'
      ) {
        this.logger.warn(`Gemini analysis failed: ${response.text}. Skipping fallback since Groq vision is decommissioned.`);
        client.emit('ai-response', {
          text: response.text,
          done: true,
          source: 'screenshot-analysis',
        });
        return;
      }

      client.emit('ai-response', {
        text: response.text,
        done: true,
        source: 'screenshot-analysis',
      });

      this.logger.log(
        `Screenshot analysis complete (${response.latency}ms, model: ${response.model})`,
      );
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        `Screenshot analysis failed with ${analysisModel}: ${errMsg}`,
      );
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

    client.emit('processing-start', {});

    const response = await this.aiService.generateResponse({
      transcript: data.text,
      screenshotBase64: session?.lastScreenshot || undefined,
      resumeContext: this.ragService.getContext(),
      model,
    });

    client.emit('ai-response', {
      text: response.text,
      done: true,
    });
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
    }

    // Update API keys
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
