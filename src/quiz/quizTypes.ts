// Quiz question types
export type QuizQuestionType = 'mcq' | 'subjective';

export interface MCQQuestion {
  type: 'mcq';
  question: string;
  options: string[];
  correctAnswer: number; // index of correct option
  explanation?: string;
}

export interface SubjectiveQuestion {
  type: 'subjective';
  question: string;
  expectedAnswer: string;
  explanation?: string;
}

export type QuizQuestion = MCQQuestion | SubjectiveQuestion;

export type QuizContent = string | string[];

export interface QuizGenerationRequest {
  content: QuizContent;
  count?: number;
  type?: QuizQuestionType | 'mixed';
}

export interface QuizGenerationResponse {
  questions: QuizQuestion[];
  count: number;
  type: QuizQuestionType | 'mixed';
}

export interface QuizEvaluationRequest {
  questions: QuizQuestion[];
  answers: (string | number)[];
}

export interface QuizEvaluationResult {
  question: string;
  userAnswer: string | number;
  isCorrect: boolean;
  correctAnswer: string | number;
  explanation?: string;
}

export interface QuizEvaluationResponse {
  total: number;
  correct: number;
  percentage: number;
  results: QuizEvaluationResult[];
} 