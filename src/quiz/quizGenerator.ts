import { openai } from '../services/openai.js';
import { qdrantService } from '../services/qdrantHybrid.js';
import {
  QuizGenerationRequest,
  QuizGenerationResponse,
  QuizQuestion,
} from './quizTypes.js';

export async function generateQuiz({ products, count = 20, type = 'mcq',topics }: { products?: string[], count?: number, type?: string,topics?: string[] }): Promise<QuizGenerationResponse> {
  // if (!products || !Array.isArray(products) || products.length === 0) {
  //   throw new Error('No products provided for quiz generation.');
  // }
  
  const allChunks = await qdrantService.getChunksByProductsOrTopics(products || [], topics || []);
  if (!allChunks || allChunks.length === 0) {
    throw new Error('No content found for the selected products.');
  }
  // Randomly select N chunks for quiz
  const selectedChunks = allChunks.sort(() => 0.5 - Math.random()).slice(0, count);
  console.log("🚀 ~ generateQuiz ~ selectedChunks:", selectedChunks.length, "chunks selected");
  
  // Generate questions using OpenAI
  const quizQuestions: QuizQuestion[] = [];
  
  for (let i = 0; i < selectedChunks.length; i++) {
    const chunk = selectedChunks[i];
    const productName = chunk.metadata?.docMetadata?.key_entities?.product_name || 'Unknown Product';
    console.log(`🚀 ~ generateQuiz ~ Processing chunk ${i + 1}/${selectedChunks.length}`);
    console.log(`🚀 ~ generateQuiz ~ Product name for chunk ${i + 1}: "${productName}"`);
    
    let prompt = '';
    if (type === 'mcq') {
      prompt = `Generate exactly 1 multiple choice question based on the following content. 

CRITICAL: Return ONLY raw JSON without any markdown formatting, code blocks, or additional text. The response must be parseable by JSON.parse().
IMPORTANT: The question MUST explicitly mention the specific product name "${chunk.metadata?.docMetadata?.key_entities?.product_name || 'the product'}" in the question text. Do not use generic terms like "the product" or "this product".

Required JSON format:
{
  "question": "Your question here (must include the product name: ${chunk.metadata?.docMetadata?.key_entities?.product_name || 'the product'})",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correctAnswer": 0,
  "explanation": "Explanation here"
}

If you cannot generate a proper question in this exact format, return:
{"error": "Unable to generate question"}

Content: ${chunk.content}

Product Name: ${chunk.metadata?.docMetadata?.key_entities?.product_name || 'Unknown Product'}

REMEMBER: The question must specifically mention "${chunk.metadata?.docMetadata?.key_entities?.product_name || 'the product'}" by name. Return ONLY the JSON object, no other text.`;
    } else if (type === 'subjective') {
      prompt = `Generate exactly 1 subjective question based on the following content.

CRITICAL: Return ONLY raw JSON without any markdown formatting, code blocks, or additional text. The response must be parseable by JSON.parse().
IMPORTANT: The question MUST explicitly mention the specific product name "${chunk.metadata?.docMetadata?.key_entities?.product_name || 'the product'}" in the question text. Do not use generic terms like "the product" or "this product".

Required JSON format:
{
  "question": "Your question here (must include the product name: ${chunk.metadata?.docMetadata?.key_entities?.product_name || 'the product'})",
  "expectedAnswer": "Expected answer here",
  "explanation": "Explanation here"
}

If you cannot generate a proper question in this exact format, return:
{"error": "Unable to generate question"}

Content: ${chunk.content}

Product Name: ${chunk.metadata?.docMetadata?.key_entities?.product_name || 'Unknown Product'}

REMEMBER: The question must specifically mention "${chunk.metadata?.docMetadata?.key_entities?.product_name || 'the product'}" by name. Return ONLY the JSON object, no other text.`;
    } else {
      // mixed: randomly pick mcq or subjective
      if (Math.random() < 0.5) {
        prompt = `Generate exactly 1 multiple choice question based on the following content.

CRITICAL: Return ONLY raw JSON without any markdown formatting, code blocks, or additional text. The response must be parseable by JSON.parse().
IMPORTANT: The question MUST explicitly mention the specific product name "${chunk.metadata?.docMetadata?.key_entities?.product_name || 'the product'}" in the question text. Do not use generic terms like "the product" or "this product".

Required JSON format:
{
  "question": "Your question here (must include the product name: ${chunk.metadata?.docMetadata?.key_entities?.product_name || 'the product'})",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correctAnswer": 0,
  "explanation": "Explanation here"
}

If you cannot generate a proper question in this exact format, return:
{"error": "Unable to generate question"}

Content: ${chunk.content}

Product Name: ${chunk.metadata?.docMetadata?.key_entities?.product_name || 'Unknown Product'}

REMEMBER: The question must specifically mention "${chunk.metadata?.docMetadata?.key_entities?.product_name || 'the product'}" by name. Return ONLY the JSON object, no other text.`;
      } else {
        prompt = `Generate exactly 1 subjective question based on the following content.

CRITICAL: Return ONLY raw JSON without any markdown formatting, code blocks, or additional text. The response must be parseable by JSON.parse().
IMPORTANT: The question MUST explicitly mention the specific product name "${chunk.metadata?.docMetadata?.key_entities?.product_name || 'the product'}" in the question text. Do not use generic terms like "the product" or "this product".

Required JSON format:
{
  "question": "Your question here (must include the product name: ${chunk.metadata?.docMetadata?.key_entities?.product_name || 'the product'})",
  "expectedAnswer": "Expected answer here",
  "explanation": "Explanation here"
}

If you cannot generate a proper question in this exact format, return:
{"error": "Unable to generate question"}

Content: ${chunk.content}

Product Name: ${chunk.metadata?.docMetadata?.key_entities?.product_name || 'Unknown Product'}

REMEMBER: The question must specifically mention "${chunk.metadata?.docMetadata?.key_entities?.product_name || 'the product'}" by name. Return ONLY the JSON object, no other text.`;
      }
    }
    
    // Use OpenAI to generate the question
    try {
      console.log(`🚀 ~ generateQuiz ~ Calling OpenAI for chunk ${i + 1}`);
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { 
            role: 'system', 
            content: 'You are a quiz generator. You MUST return only valid JSON without any markdown formatting, code blocks, or additional text. The response must be directly parseable by JSON.parse(). Do not wrap the JSON in ```json blocks or any other formatting.' 
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 500,
      });
      
      let respContent = response.choices[0].message.content;
      console.log(`🚀 ~ generateQuiz ~ Raw OpenAI Response for chunk ${i + 1}:`, respContent);
      
      if (!respContent) {
        console.log(`🚀 ~ generateQuiz ~ No response content for chunk ${i + 1}, skipping`);
        continue;
      }
      
      // Clean the response - remove markdown code blocks and extra whitespace
      respContent = respContent.trim();
      
      // Remove markdown code blocks if present
      if (respContent.startsWith('```json')) {
        respContent = respContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (respContent.startsWith('```')) {
        respContent = respContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      
      respContent = respContent.trim();
      console.log(`🚀 ~ generateQuiz ~ Cleaned response for chunk ${i + 1}:`, respContent);
      
      let questionObj;
      try {
        questionObj = JSON.parse(respContent);
        console.log(`🚀 ~ generateQuiz ~ Parsed questionObj for chunk ${i + 1}:`, questionObj);
      } catch (parseError) {
        console.error(`🚀 ~ generateQuiz ~ JSON Parse Error for chunk ${i + 1}:`, parseError);
        console.error(`🚀 ~ generateQuiz ~ Content that failed to parse:`, respContent);
        continue;
      }
      
      // Check if OpenAI returned an error
      if (questionObj.error) {
        console.log(`🚀 ~ generateQuiz ~ OpenAI returned error for chunk ${i + 1}:`, questionObj.error);
        continue;
      }
      
      // Validate the question object
      if (!questionObj || !questionObj.question) {
        console.log(`🚀 ~ generateQuiz ~ Invalid question object for chunk ${i + 1}:`, questionObj);
        continue;
      }
      
      // Set the question type
      if (questionObj.options && Array.isArray(questionObj.options)) {
        questionObj.type = 'mcq';
        // Validate MCQ structure
        if (typeof questionObj.correctAnswer !== 'number' || 
            questionObj.correctAnswer < 0 || 
            questionObj.correctAnswer >= questionObj.options.length) {
          console.log(`🚀 ~ generateQuiz ~ Invalid MCQ structure for chunk ${i + 1}:`, questionObj);
          continue;
        }
      } else if (questionObj.expectedAnswer) {
        questionObj.type = 'subjective';
      } else {
        console.log(`🚀 ~ generateQuiz ~ Unable to determine question type for chunk ${i + 1}:`, questionObj);
        continue;
      }
      
      console.log(`🚀 ~ generateQuiz ~ Adding question ${quizQuestions.length + 1}:`, questionObj);
      quizQuestions.push(questionObj);
      
    } catch (error) {
      console.error(`🚀 ~ generateQuiz ~ Error generating question for chunk ${i + 1}:`, error);
      continue;
    }
  }
  
  console.log(`🚀 ~ generateQuiz ~ Final quizQuestions count:`, quizQuestions.length);
  console.log(`🚀 ~ generateQuiz ~ Final quizQuestions:`, JSON.stringify(quizQuestions, null, 2));
  
  return {
    questions: quizQuestions,
    count: quizQuestions.length,
    type: type as any,
  };
} 