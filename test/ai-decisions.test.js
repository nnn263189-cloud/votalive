import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDecisionRequest,
  describeAnswer,
  findAnswer,
  MAX_CHOICES,
  MAX_QUESTIONS,
  MAX_SCORE_LEVELS,
  MIN_SCORE_LEVELS,
  validateQuestions,
} from '../src/ai/decisions.js';

function choiceQuestion(overrides = {}) {
  return {
    type: 'choice',
    name: 'review',
    instructions: 'A evidência sustenta aceitar?',
    choices: [
      { value: 'accept', description: 'Está correto e testado.' },
      { value: 'review', description: 'Faltam evidências.' },
    ],
    ...overrides,
  };
}

test('monta o corpo do /v1/decisions com o modelo fixo', () => {
  const request = buildDecisionRequest({
    input: 'evidência resumida',
    questions: [choiceQuestion()],
  });

  assert.equal(request.model, 'gpt-6-luna-decisions');
  assert.equal(request.input, 'evidência resumida');
  assert.equal(request.questions.length, 1);
  assert.equal(request.questions[0].type, 'choice');
  assert.equal(request.questions[0].choices.length, 2);
});

test('recusa outro modelo de decisão', () => {
  assert.throws(
    () => buildDecisionRequest({ input: 'x', questions: [choiceQuestion()], model: 'gpt-6-luna' }),
    /fixo em "gpt-6-luna-decisions"/,
  );
});

test('o gateway admite no máximo 32 perguntas', () => {
  const many = Array.from({ length: MAX_QUESTIONS + 1 }, (_value, index) => ({
    type: 'predicate',
    name: `q${index}`,
    instructions: 'é verdade?',
  }));
  assert.throws(() => validateQuestions(many), /no máximo 32 perguntas/);

  const exact = many.slice(0, MAX_QUESTIONS);
  assert.equal(validateQuestions(exact).length, MAX_QUESTIONS);
});

test('uma escolha aceita no máximo 64 opções', () => {
  const many = Array.from({ length: MAX_CHOICES + 1 }, (_value, index) => ({ value: `v${index}` }));
  assert.throws(
    () => validateQuestions([choiceQuestion({ choices: many })]),
    /no máximo 64 opções/,
  );
});

test('uma nota aceita de 2 a 10 níveis', () => {
  const level = (label) => ({ label, description: 'descrição' });
  assert.throws(
    () => validateQuestions([{ type: 'score', name: 's', instructions: 'quão grave?', levels: [level('só um')] }]),
    new RegExp(`de ${MIN_SCORE_LEVELS} a ${MAX_SCORE_LEVELS} níveis`),
  );
  assert.throws(
    () => validateQuestions([
      { type: 'score', name: 's', instructions: 'quão grave?', levels: Array.from({ length: 11 }, (_v, i) => level(`n${i}`)) },
    ]),
    new RegExp(`de ${MIN_SCORE_LEVELS} a ${MAX_SCORE_LEVELS} níveis`),
  );
  assert.equal(validateQuestions([
    { type: 'score', name: 's', instructions: 'quão grave?', levels: [level('baixo'), level('alto')] },
  ]).length, 1);
});

test('nomes repetidos entre perguntas são recusados', () => {
  assert.throws(
    () => validateQuestions([choiceQuestion(), choiceQuestion()]),
    /se repete entre as perguntas/,
  );
});

test('valores de escolha precisam ser únicos', () => {
  assert.throws(
    () => validateQuestions([choiceQuestion({ choices: [{ value: 'x' }, { value: 'x' }] })]),
    /valores únicos/,
  );
});

test('input aceita texto e mensagens com input_text e input_image base64', () => {
  const request = buildDecisionRequest({
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'olhe a foto' },
          { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
        ],
      },
    ],
    questions: [{ type: 'predicate', name: 'p', instructions: 'tem algo?' }],
  });

  assert.equal(request.input[0].content[1].type, 'input_image');
  assert.throws(
    () => buildDecisionRequest({
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://exemplo.test/a.png' }] }],
      questions: [{ type: 'predicate', name: 'p', instructions: 'x' }],
    }),
    /data URL base64 inline/,
  );
});

test('a resposta é lida pela posição da pergunta, com nome e sem nome', () => {
  const answers = [
    { type: 'choice', name: 'review', choice: 'accept', confidence: 0.91 },
    { type: 'predicate', probability: 0.42 },
  ];

  const named = findAnswer(answers, 'review');
  assert.equal(named.choice, 'accept');
  assert.equal(describeAnswer(named).summary, 'Escolha: accept.');

  const unnamed = findAnswer(answers, undefined);
  assert.equal(unnamed.type, 'predicate');
  assert.equal(describeAnswer(unnamed).probability, 0.42);
});

test('recusa do modelo é sinalizada, não é erro', () => {
  const summary = describeAnswer({ type: 'refusal', name: 'review' });
  assert.equal(summary.refused, true);
  assert.match(summary.summary, /recusou responder/);
});

test('nota traz o score e a confiança', () => {
  const summary = describeAnswer({ type: 'score', name: 'severity', score: 1.1, confidence: 0.55 });
  assert.equal(summary.score, 1.1);
  assert.equal(summary.confidence, 0.55);
  assert.match(summary.summary, /Nota: 1\.1/);
});
