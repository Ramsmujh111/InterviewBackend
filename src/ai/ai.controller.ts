import { Controller, Get, Post, Put, Body } from '@nestjs/common';
import { AiService } from './ai.service';
import type { AiRequest } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('generate')
  async generate(@Body() body: AiRequest) {
    const response = await this.aiService.generateResponse(body);
    return response;
  }

  @Post('analyze-screen')
  async analyzeScreen(
    @Body()
    body: {
      screenshotBase64: string;
      question?: string;
      model?: string;
    },
  ) {
    const defaultQuestion = 'What is shown on this screen? Describe the code or content.';
    const prompt = body.question
      ? `A question has been asked: "${body.question}".\nA screenshot is also provided.\n\nCRITICAL INSTRUCTION:\n1. If the screenshot is RELEVANT to the question, use it to provide a clear, actionable solution.\n2. If the screenshot is IRRELEVANT or unrelated to the question, completely IGNORE the screenshot and answer the question directly based on your knowledge.\n3. DO NOT describe the screen contents merely because a screenshot was provided.\n4. Provide a direct, correct, textual answer formatted cleanly in Markdown.`
      : defaultQuestion;

    const response = await this.aiService.generateResponse({
      transcript: prompt,
      screenshotBase64: body.screenshotBase64,
      model: body.model || 'gemini-flash',
    });
    return response;
  }

  @Get('models')
  getModels() {
    return this.aiService.getAvailableModels();
  }

  @Put('settings')
  updateSettings(
    @Body()
    body: {
      geminiKey?: string;
      openaiKey?: string;
      anthropicKey?: string;
      groqKey?: string;
    },
  ) {
    const keys: Record<string, string> = {};
    if (body.geminiKey) keys.gemini = body.geminiKey;
    if (body.openaiKey) keys.openai = body.openaiKey;
    if (body.anthropicKey) keys.anthropic = body.anthropicKey;
    if (body.groqKey) keys.groq = body.groqKey;
    this.aiService.updateApiKeys(keys);
    return { message: 'Settings updated' };
  }
}
