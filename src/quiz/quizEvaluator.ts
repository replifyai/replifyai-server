import {
  QuizEvaluationRequest,
  QuizEvaluationResponse,
  QuizEvaluationResult,
  QuizQuestion,
} from './quizTypes.js';

export function evaluateQuiz({ questions, answers }: QuizEvaluationRequest): QuizEvaluationResponse {
  let correct = 0;
  let total = questions.length;
  const results: QuizEvaluationResult[] = questions.map((q: QuizQuestion, i: number) => {
    const userAnswer = answers[i];
    let isCorrect = false;
    if (q.type === 'mcq') {
      isCorrect = (userAnswer === q.correctAnswer || userAnswer === q.options[q.correctAnswer]);
    } else if (q.type === 'subjective') {
      isCorrect = (typeof userAnswer === 'string' && typeof q.expectedAnswer === 'string' && userAnswer.trim().toLowerCase() === q.expectedAnswer.trim().toLowerCase());
    }
    if (isCorrect) correct++;
    return {
      question: q.question,
      userAnswer,
      isCorrect,
      correctAnswer: (q.type === 'mcq') ? q.correctAnswer : q.expectedAnswer,
      explanation: q.explanation,
    };
  });
  const percentage = total > 0 ? Math.round((correct / total) * 100) : 0;
  return {
    total,
    correct,
    percentage,
    results,
  };
} 