import { DECISIONS_MODEL } from './config.js';

/**
 * Limites de admissão do gateway (não são limites do provedor):
 * o Experiential Labs recusa o que passar把这些 marcas.
 */
export const MAX_QUESTIONS = 32;
export const MAX_CHOICES = 64;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

export const QUESTION_TYPES = ['predicate', 'choice', 'score'];

export class DecisionValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecisionValidationError';
    this.status = 400;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DecisionValidationError(`${field} deve ser um texto não vazio.`);
  }
  return value;
}

/**
 * Valida o `input` aceito pelo /v1/decisions: um texto ou uma lista de
 * mensagens com partes `input_text` e `input_image` (base64 inline).
 */
export function validateDecisionInput(input) {
  if (typeof input === 'string') {
    if (input.trim() === '') {
      throw new DecisionValidationError('input não pode ser um texto vazio.');
    }
    return input;
  }

  if (!Array.isArray(input) || input.length === 0) {
    throw new DecisionValidationError('input deve ser um texto ou uma lista de mensagens.');
  }

  return input.map((message, index) => {
    if (!isPlainObject(message)) {
      throw new DecisionValidationError(`input[${index}] deve ser um objeto de mensagem.`);
    }
    const role = requireString(message.role ?? 'user', `input[${index}].role`);
    if (!['user', 'developer', 'system', 'assistant'].includes(role)) {
      throw new DecisionValidationError(`input[${index}].role inválido: ${role}.`);
    }
    const content = message.content;
    if (typeof content === 'string') {
      if (content.trim() === '') {
        throw new DecisionValidationError(`input[${index}].content não pode ser vazio.`);
      }
      return { role, content };
    }
    if (!Array.isArray(content) || content.length === 0) {
      throw new DecisionValidationError(
        `input[${index}].content deve ser um texto ou uma lista de partes.`,
      );
    }
    const parts = content.map((part, partIndex) => {
      if (!isPlainObject(part)) {
        throw new DecisionValidationError(
          `input[${index}].content[${partIndex}] deve ser um objeto.`,
        );
      }
      if (part.type === 'input_text') {
        return { type: 'input_text', text: requireString(part.text, `input[${index}].content[${partIndex}].text`) };
      }
      if (part.type === 'input_image') {
        const imageUrl = requireString(part.image_url, `input[${index}].content[${partIndex}].image_url`);
        if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(imageUrl)) {
          throw new DecisionValidationError(
            `input[${index}].content[${partIndex}].image_url precisa ser uma data URL base64 inline.`,
          );
        }
        return { type: 'input_image', image_url: imageUrl };
      }
      throw new DecisionValidationError(
        `input[${index}].content[${partIndex}].type deve ser input_text ou input_image.`,
      );
    });
    return { role, content: parts };
  });
}

function validateChoiceQuestion(question) {
  const { choices } = question;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new DecisionValidationError(
      `A pergunta "${question.name || question.type}" do tipo choice precisa de "choices".`,
    );
  }
  if (choices.length > MAX_CHOICES) {
    throw new DecisionValidationError(
      `Uma pergunta choice aceita no máximo ${MAX_CHOICES} opções (recebido: ${choices.length}).`,
    );
  }
  const seen = new Set();
  return choices.map((choice, index) => {
    if (!isPlainObject(choice)) {
      throw new DecisionValidationError(`choices[${index}] deve ser um objeto.`);
    }
    const value = choice.value;
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw new DecisionValidationError(`choices[${index}].value deve ser um texto ou booleano.`);
    }
    if (typeof value === 'string' && value.trim() === '') {
      throw new DecisionValidationError(`choices[${index}].value não pode ser vazio.`);
    }
    const key = String(value);
    if (seen.has(key)) {
      throw new DecisionValidationError(`As opções de choice devem ter valores únicos (repetido: ${key}).`);
    }
    seen.add(key);
    const normalized = { value };
    if (choice.description !== undefined) {
      normalized.description = requireString(choice.description, `choices[${index}].description`);
    }
    return normalized;
  });
}

function validateScoreQuestion(question) {
  const { levels } = question;
  if (!Array.isArray(levels)) {
    throw new DecisionValidationError(
      `A pergunta "${question.name || question.type}" do tipo score precisa de "levels".`,
    );
  }
  if (levels.length < MIN_SCORE_LEVELS || levels.length > MAX_SCORE_LEVELS) {
    throw new DecisionValidationError(
      `Uma pergunta score aceita de ${MIN_SCORE_LEVELS} a ${MAX_SCORE_LEVELS} níveis (recebido: ${levels.length}).`,
    );
  }
  return levels.map((level, index) => {
    if (!isPlainObject(level)) {
      throw new DecisionValidationError(`levels[${index}] deve ser um objeto.`);
    }
    const label = requireString(level.label, `levels[${index}].label`);
    const normalized = { label };
    if (level.description !== undefined) {
      normalized.description = requireString(level.description, `levels[${index}].description`);
    }
    return normalized;
  });
}

/** Valida a lista de perguntas e devolve a versão normalizada para a API. */
export function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new DecisionValidationError('questions deve ser uma lista com pelo menos uma pergunta.');
  }
  if (questions.length > MAX_QUESTIONS) {
    throw new DecisionValidationError(
      `O gateway admite no máximo ${MAX_QUESTIONS} perguntas por requisição (recebido: ${questions.length}).`,
    );
  }

  const names = new Set();
  return questions.map((question, index) => {
    if (!isPlainObject(question)) {
      throw new DecisionValidationError(`questions[${index}] deve ser um objeto.`);
    }
    const type = requireString(question.type, `questions[${index}].type`);
    if (!QUESTION_TYPES.includes(type)) {
      throw new DecisionValidationError(
        `questions[${index}].type inválido: ${type}. Use predicate, choice ou score.`,
      );
    }
    const instructions = requireString(question.instructions, `questions[${index}].instructions`);

    const normalized = { type, instructions };
    if (question.name !== undefined) {
      const name = requireString(question.name, `questions[${index}].name`);
      if (names.has(name)) {
        throw new DecisionValidationError(`O nome "${name}" se repete entre as perguntas.`);
      }
      names.add(name);
      normalized.name = name;
    }

    if (type === 'choice') normalized.choices = validateChoiceQuestion(question);
    if (type === 'score') normalized.levels = validateScoreQuestion(question);
    return normalized;
  });
}

/** Monta o corpo exato do POST /v1/decisions, já validado. */
export function buildDecisionRequest({ input, questions, model = DECISIONS_MODEL }) {
  if (model !== DECISIONS_MODEL) {
    throw new DecisionValidationError(
      `O modelo de decisão é fixo em "${DECISIONS_MODEL}" (recebido: ${model}).`,
    );
  }
  return {
    model,
    input: validateDecisionInput(input),
    questions: validateQuestions(questions),
  };
}

/**
 * As respostas vêm na ordem das perguntas. A pergunta sem `name` volta
 * sem nome; por isso a busca por nome precisa tolerar `undefined`.
 */
export function findAnswer(answers, name) {
  if (!Array.isArray(answers)) return null;
  if (name === undefined || name === null) {
    return answers.find((answer) => answer?.name === undefined || answer?.name === null) ?? null;
  }
  return answers.find((answer) => answer?.name === name) ?? null;
}

/** Resumo legível de uma resposta (predicado, escolha, nota ou recusa). */
export function describeAnswer(answer) {
  if (!answer) {
    return { found: false, type: null, refused: false, summary: 'Sem resposta para esta pergunta.' };
  }
  const type = answer.type ?? null;
  if (type === 'refusal') {
    return {
      found: true,
      type,
      name: answer.name ?? null,
      refused: true,
      confidence: answer.confidence ?? null,
      summary: `O modelo recusou responder${answer.name ? ` "${answer.name}"` : ''}.`,
    };
  }
  if (type === 'predicate') {
    const probability = typeof answer.probability === 'number' ? answer.probability : null;
    return {
      found: true,
      type,
      name: answer.name ?? null,
      refused: false,
      probability,
      confidence: answer.confidence ?? null,
      probabilities: answer.probabilities ?? null,
      summary: probability === null
        ? 'Resposta sem probabilidade.'
        : `Probabilidade de a afirmação ser verdadeira: ${(probability * 100).toFixed(1)}%.`,
    };
  }
  if (type === 'choice') {
    return {
      found: true,
      type,
      name: answer.name ?? null,
      refused: false,
      choice: answer.choice ?? null,
      confidence: answer.confidence ?? null,
      probabilities: answer.probabilities ?? null,
      summary: answer.choice === undefined || answer.choice === null
        ? 'Resposta sem escolha.'
        : `Escolha: ${String(answer.choice)}.`,
    };
  }
  if (type === 'score') {
    const score = typeof answer.score === 'number' ? answer.score : null;
    return {
      found: true,
      type,
      name: answer.name ?? null,
      refused: false,
      score,
      confidence: answer.confidence ?? null,
      probabilities: answer.probabilities ?? null,
      summary: score === null ? 'Resposta sem nota.' : `Nota: ${score}.`,
    };
  }
  return {
    found: true,
    type,
    name: answer.name ?? null,
    refused: false,
    summary: 'Resposta em formato desconhecido.',
  };
}
