import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, Part, Content } from '@google/generative-ai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { TextBlock } from '@anthropic-ai/sdk/resources/messages';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  transcript: string;
  screenshotBase64?: string;
  resumeContext?: string;
  model: string;
  history?: ChatMessage[];
}

export interface AiResponse {
  text: string;
  model: string;
  latency: number;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  // API keys can be updated at runtime from client
  private apiKeys: Record<string, string> = {};

  constructor(private configService: ConfigService) {
    this.apiKeys = {
      gemini: this.configService.get<string>('GEMINI_API_KEY') || '',
      openai: this.configService.get<string>('OPENAI_API_KEY') || '',
      anthropic: this.configService.get<string>('ANTHROPIC_API_KEY') || '',
      groq: this.configService.get<string>('GROQ_API_KEY') || '',
      deepseek: this.configService.get<string>('DEEPSEEK_API_KEY') || '',
    };
  }

  updateApiKeys(keys: Record<string, string>) {
    this.apiKeys = { ...this.apiKeys, ...keys };
    this.logger.log('API keys updated');
  }

  async generateResponse(request: AiRequest): Promise<AiResponse> {
    const startTime = Date.now();
    let text: string;

    const systemPrompt = this.buildSystemPrompt(request.resumeContext);
    const userPrompt = this.buildUserPrompt(request.transcript);
    const history = request.history ?? [];

    try {
      switch (request.model) {
        case 'gemini-flash':
          text = await this.callGemini(
            systemPrompt,
            userPrompt,
            request.screenshotBase64,
            history,
          );
          break;
        case 'groq-llama':
          text = await this.callGroq(systemPrompt, userPrompt, undefined, 'llama-3.3-70b-versatile', history);
          break;
        case 'groq-llama4':
          text = await this.callGroq(systemPrompt, userPrompt, undefined, 'meta-llama/llama-4-scout-17b-16e-instruct', history);
          break;
        case 'groq-compound':
          text = await this.callGroq(systemPrompt, userPrompt, undefined, 'compound-beta', history);
          break;
        case 'groq-vision':
          text = await this.callGroq(
            systemPrompt,
            userPrompt,
            request.screenshotBase64,
            'llama-3.3-70b-versatile',
            history,
          );
          break;
        case 'gpt-4o-mini':
          text = await this.callOpenAI(
            systemPrompt,
            userPrompt,
            request.screenshotBase64,
            history,
          );
          break;
        case 'claude-sonnet':
          text = await this.callClaude(systemPrompt, userPrompt, history);
          break;
        case 'deepseek':
          text = await this.callDeepSeek(systemPrompt, userPrompt, history);
          break;
        default:
          text = await this.callGroq(systemPrompt, userPrompt, undefined, 'llama-3.3-70b-versatile', history);
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`AI generation failed: ${errMsg}`);
      text = `Error: ${errMsg}. Please check your API key for ${request.model}.`;
    }

    return {
      text,
      model: request.model,
      latency: Date.now() - startTime,
    };
  }

  private buildSystemPrompt(resumeContext?: string): string {
    let prompt =
      'You are an expert AI interview assistant helping a Full Stack MERN developer during a live job interview.\n' +
      'Your responses should be:\n' +
      '- Concise but comprehensive\n' +
      '- Well-structured with bullet points and code examples when relevant\n' +
      '- Natural-sounding (as if the candidate is speaking)\n' +
      '- Technically accurate and up-to-date\n' +
      '- Formatted in Markdown for readability\n\n' +
      'CRITICAL VISUAL INSTRUCTION:\n' +
      "If a screenshot is provided, ONLY use it if it directly relates to the interviewer's question. " +
      'If the question can be answered independently, or if the screenshot is irrelevant, IGNORE the screenshot completely. ' +
      'DO NOT describe the screen contents unless specifically asked. Focus wholly on answering the specific question asked.\n\n' +
      'IMPORTANT: Keep answers brief enough to read quickly during an interview (aim for 30-60 seconds of reading time).\n' +
      'If the question is about coding, provide clean, working code with brief explanations.';

    if (resumeContext) {
      prompt +=
        `\n\nHere is the candidate's resume/background for personalization:\n` +
        resumeContext;
    }

    return prompt;
  }

  private buildUserPrompt(transcript: string): string {
    return (
      `The interviewer just asked: "${transcript}"\n\n` +
      `Provide a clear, concise answer that the candidate can use. ` +
      `If it's a coding question, include the solution code.`
    );
  }

  // ── Gemini (with Vision support + retry logic + conversation history) ──
  private async callGemini(
    systemPrompt: string,
    userPrompt: string,
    screenshotBase64?: string,
    history: ChatMessage[] = [],
  ): Promise<string> {
    const genAI = new GoogleGenerativeAI(this.apiKeys.gemini);
    const model = genAI.getGenerativeModel({
      model: 'gemini-flash-latest',
      systemInstruction: systemPrompt,
    });

    // Build Gemini history (must alternate user/model, skip last user which is the current prompt)
    const geminiHistory: Content[] = [];
    for (const msg of history) {
      geminiHistory.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      });
    }

    const chat = model.startChat({ history: geminiHistory });

    const parts: Part[] = [{ text: userPrompt }];

    if (screenshotBase64) {
      const base64Data = screenshotBase64.replace(
        /^data:image\/\w+;base64,/,
        '',
      );
      parts.push({
        inlineData: {
          mimeType: 'image/png',
          data: base64Data,
        },
      });
      const firstPart = parts[0] as { text: string };
      firstPart.text +=
        '\n\nHere is a screenshot of the screen for additional context (only use if relevant to the question):';
    }

    // Retry with exponential backoff for rate limit (429) errors
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await chat.sendMessage(parts);
        return result.response.text();
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const isRateLimit =
          errMsg.includes('429') || errMsg.includes('Too Many Requests');

        if (isRateLimit && attempt < maxRetries) {
          const delayMs = Math.pow(2, attempt + 1) * 1000;
          this.logger.warn(
            `Gemini rate limited (attempt ${attempt + 1}/${maxRetries}). ` +
            `Retrying in ${delayMs / 1000}s...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } else {
          throw error;
        }
      }
    }

    throw new Error('Gemini API: Max retries exceeded due to rate limiting.');
  }

  // ── Groq (OpenAI-compatible — Llama 3.3, Llama 4, Compound Beta — FREE) ──
  private async callGroq(
    systemPrompt: string,
    userPrompt: string,
    screenshotBase64?: string,
    modelName: string = 'llama-3.3-70b-versatile',
    history: ChatMessage[] = [],
  ): Promise<string> {
    const groq = new OpenAI({
      apiKey: this.apiKeys.groq,
      baseURL: 'https://api.groq.com/openai/v1',
    });

    // Vision not supported on Groq anymore
    if (screenshotBase64) {
      throw new Error('Groq vision models have been decommissioned. Please select Gemini for screen analysis.');
    }

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: userPrompt },
    ];

    this.logger.log(`Groq: using model '${modelName}'`);
    const completion = await groq.chat.completions.create({
      model: modelName,
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    });

    return completion.choices[0]?.message?.content || 'No response generated.';
  }

  // ── OpenAI GPT-4o ──
  private async callOpenAI(
    systemPrompt: string,
    userPrompt: string,
    screenshotBase64?: string,
    history: ChatMessage[] = [],
  ): Promise<string> {
    const openai = new OpenAI({
      apiKey: this.apiKeys.openai,
      baseURL: 'https://models.inference.ai.azure.com'
    });

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    if (screenshotBase64) {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: userPrompt + '\n\nHere is a screenshot for context (only use if relevant to the question):',
          },
          {
            type: 'image_url',
            image_url: { url: screenshotBase64, detail: 'low' },
          },
        ],
      });
    } else {
      messages.push({ role: 'user', content: userPrompt });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    });

    return completion.choices[0]?.message?.content || 'No response generated.';
  }

  // ── Claude Sonnet ──
  private async callClaude(
    systemPrompt: string,
    userPrompt: string,
    history: ChatMessage[] = [],
  ): Promise<string> {
    const anthropic = new Anthropic({
      apiKey: this.apiKeys.anthropic,
    });

    const claudeMessages: Anthropic.MessageParam[] = [
      ...history.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: userPrompt },
    ];

    const message = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: systemPrompt,
      messages: claudeMessages,
    });

    const textBlock = message.content.find(
      (block): block is TextBlock => block.type === 'text',
    );
    return textBlock ? textBlock.text : 'No response generated.';
  }

  // ── DeepSeek (OpenAI-compatible API) ──
  private async callDeepSeek(
    systemPrompt: string,
    userPrompt: string,
    history: ChatMessage[] = [],
  ): Promise<string> {
    const deepseek = new OpenAI({
      apiKey: this.apiKeys.deepseek,
      baseURL: 'https://api.deepseek.com/v1',
    });

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: userPrompt },
    ];

    const completion = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    });

    return completion.choices[0]?.message?.content || 'No response generated.';
  }

  getAvailableModels() {
    return [
      {
        id: 'groq-llama',
        name: 'Llama 3.3 70B (Groq)',
        description: 'Free + Fast',
        available: !!this.apiKeys.groq,
      },
      {
        id: 'groq-llama4',
        name: 'Llama 4 Scout (Groq)',
        description: 'Free + Latest',
        available: !!this.apiKeys.groq,
      },
      {
        id: 'groq-compound',
        name: 'Compound Beta (Groq)',
        description: 'Free + Multi-step',
        available: !!this.apiKeys.groq,
      },
      {
        id: 'gemini-flash',
        name: 'Gemini 2.0 Flash',
        description: 'Fast + Vision',
        available: !!this.apiKeys.gemini,
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o-mini',
        description: 'GitHub Models Free',
        available: !!this.apiKeys.openai,
      },
      {
        id: 'claude-sonnet',
        name: 'Claude 3.5 Sonnet',
        description: 'Clean Code',
        available: !!this.apiKeys.anthropic,
      },
      {
        id: 'deepseek',
        name: 'DeepSeek Chat',
        description: 'Cost-effective + Smart',
        available: !!this.apiKeys.deepseek,
      },
    ];
  }
}
