import { testDeepgramIntegration } from '../src/services/deepgramFile.ts';
import 'dotenv/config';

const testDeepgram = async () => {
  try {
    console.log('Starting Deepgram integration test...');
    console.log('Using DEEPGRAM_API_KEY:', process.env.DEEPGRAM_API_KEY ? 'Set' : 'Not set');
    
    const result = await testDeepgramIntegration();
    console.log('✅ Deepgram integration test completed successfully!');
    console.log('Result summary:', {
      textLength: result.text.length,
      language: result.language,
      duration: result.duration,
      hasTopics: !!result.topics?.length,
      hasIntents: !!result.intents?.length,
      hasSentiment: !!result.sentiment
    });
  } catch (error) {
    console.error('❌ Deepgram integration test failed:', error.message);
    process.exit(1);
  }
};

testDeepgram();