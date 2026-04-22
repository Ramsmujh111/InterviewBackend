
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function listModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  console.log('API Key loaded:', apiKey ? 'YES (Starts with ' + apiKey.substring(0, 4) + ')' : 'NO');
  
  if (!apiKey) {
    console.error('GEMINI_API_KEY not found in .env');
    return;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }); 
    // Just using the client to list models if possible, but the SDK structure is usually:
    // actually, listing models might require specific call or just try/catch generic.
    // The error says "Call ListModels". In REST that's a specific endpoint. 
    // In SDK, it might not be directly exposed easily on the main class in older versions, 
    // but let's try to just run a simple generateContent with 'gemini-pro' to see if baseline works.
    
    // Changing strategy: test multiple known model names.
    const modelsToTest = ['gemini-1.5-flash', 'gemini-1.5-flash-001', 'gemini-1.5-pro', 'gemini-pro', 'gemini-1.0-pro'];
    
    for (const modelName of modelsToTest) {
        console.log(`Testing model: ${modelName}`);
        try {
            const m = genAI.getGenerativeModel({ model: modelName });
            const result = await m.generateContent('Hello');
            console.log(`✅ Success: ${modelName}`);
            // console.log(result.response.text());
        } catch (e: any) {
            console.log(`❌ Failed: ${modelName} - ${e.message.split(']')[1] || e.message}`);
        }
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

listModels();
