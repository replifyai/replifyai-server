#!/usr/bin/env node

/**
 * Test script for audio analysis functionality
 * This script demonstrates how to use the audio analysis API
 */

import fetch from 'node-fetch';
import FormData from 'formdata-node';
import { readFileSync } from 'fs';
import { join } from 'path';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

async function testAudioAnalysis() {
  console.log('🎵 Testing Audio Analysis API...\n');

  try {
    // Test 1: Check if the service is running
    console.log('1. Checking service status...');
    const statsResponse = await fetch(`${API_BASE_URL}/api/audio/stats`);
    
    if (!statsResponse.ok) {
      throw new Error(`Service not available: ${statsResponse.status}`);
    }
    
    const stats = await statsResponse.json();
    console.log('✅ Service is running');
    console.log(`   Supported formats: ${stats.supportedFormats.join(', ')}`);
    console.log(`   Max file size: ${stats.maxFileSize}`);
    console.log(`   Features: ${stats.features.join(', ')}\n`);

    // Test 2: Test with a sample audio file (if available)
    console.log('2. Testing audio analysis...');
    
    // Create a simple test audio file (you would replace this with a real audio file)
    const testAudioPath = join(process.cwd(), 'test-audio.wav');
    
    try {
      // Check if test audio file exists
      const audioBuffer = readFileSync(testAudioPath);
      console.log(`   Found test audio file: ${testAudioPath} (${audioBuffer.length} bytes)`);
      
      // Create form data
      const formData = new FormData();
      formData.append('audio', audioBuffer, {
        filename: 'test-audio.wav',
        contentType: 'audio/wav'
      });
      formData.append('chunkDuration', '30');
      formData.append('enableSpeakerIdentification', 'true');
      formData.append('enableSentimentAnalysis', 'true');
      formData.append('enableToneAnalysis', 'true');
      formData.append('language', 'en');
      formData.append('model', 'openai');

      // Send analysis request
      const analysisResponse = await fetch(`${API_BASE_URL}/api/audio/analyze`, {
        method: 'POST',
        body: formData
      });

      if (!analysisResponse.ok) {
        const error = await analysisResponse.json();
        throw new Error(`Analysis failed: ${error.message || analysisResponse.statusText}`);
      }

      const result = await analysisResponse.json();
      
      if (result.success) {
        console.log('✅ Audio analysis completed successfully');
        console.log(`   Processing time: ${result.processingTime}ms`);
        console.log(`   Total chunks: ${result.stats.totalChunks}`);
        console.log(`   Average chunk duration: ${result.stats.averageChunkDuration}s`);
        console.log(`   Transcription coverage: ${(result.stats.transcriptionCoverage * 100).toFixed(1)}%`);
        
        if (result.insights) {
          console.log(`   Total speakers: ${result.insights.summary.totalSpeakers}`);
          console.log(`   Agent speaking time: ${result.insights.summary.agentSpeakingTime}s`);
          console.log(`   User speaking time: ${result.insights.summary.userSpeakingTime}s`);
          console.log(`   Overall sentiment: ${result.insights.summary.overallSentiment.overall}`);
          console.log(`   Dominant tone: ${result.insights.summary.dominantTone.tone}`);
          console.log(`   Key topics: ${result.insights.summary.keyTopics.join(', ')}`);
        }
      } else {
        console.log('❌ Audio analysis failed');
        console.log(`   Error: ${result.error}`);
      }

    } catch (fileError) {
      console.log('⚠️  No test audio file found, skipping analysis test');
      console.log(`   To test with a real file, place an audio file at: ${testAudioPath}`);
      console.log(`   Error: ${fileError.message}`);
    }

    console.log('\n🎉 Audio analysis API test completed!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Run the test
testAudioAnalysis().catch(console.error);