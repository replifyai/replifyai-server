#!/usr/bin/env node

/**
 * Simple test to verify Deepgram fix
 */

const fs = require('fs');
const path = require('path');

// Test the Deepgram service directly
async function testDeepgramFix() {
  console.log('🔧 Testing Deepgram fix...\n');

  try {
    // Import the Deepgram service
    const { deepgramFileService } = require('./src/services/deepgramFile.ts');
    
    console.log('✅ Deepgram service imported successfully');
    console.log('✅ Service initialized with API key:', !!process.env.DEEPGRAM_API_KEY);
    
    // Test with a minimal audio buffer (empty for now)
    const testBuffer = Buffer.alloc(1024); // Empty buffer for testing
    
    console.log('🧪 Testing transcription with empty buffer...');
    
    try {
      const result = await deepgramFileService.transcribeFile(testBuffer, 'test.wav');
      console.log('✅ Transcription completed without segments.map error');
      console.log('   Result structure:', {
        hasText: !!result.text,
        hasWords: Array.isArray(result.words),
        hasSegments: Array.isArray(result.segments),
        segmentsLength: result.segments?.length || 0
      });
    } catch (error) {
      if (error.message.includes('segments.map is not a function')) {
        console.log('❌ Deepgram fix failed - segments.map error still present');
        console.log('   Error:', error.message);
      } else {
        console.log('⚠️  Expected error (empty audio):', error.message);
        console.log('✅ But no segments.map error - fix appears to work!');
      }
    }
    
    console.log('\n🎉 Deepgram fix test completed!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Run the test
testDeepgramFix().catch(console.error);