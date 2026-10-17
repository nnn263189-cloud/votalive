#!/usr/bin/env node
/**
 * Verificação real do gateway Experiential.
 *
 * Uma requisição por seção, sem retry e sem Idempotency-Key: um timeout pode
 * ter deixado a chamada já cobrada. A chave vem só de EXPERIENTIAL_API_KEY e
 * nunca é impressa.
 *
 *   EXPERIENTIAL_API_KEY='xpl_...' node scripts/ai-smoke.mjs
 *   node scripts/ai-smoke.mjs --decision --chat
 *   node scripts/ai-smoke.mjs --image      # custa mais (gera uma imagem)
 */

import { readAiConfig } from '../src/ai/config.js';
import { buildDecisionRequest, describeAnswer, findAnswer } from '../src/ai/decisions.js';
import { ExperientialGateway } from '../src/ai/gateway.js';

const flags = new Set(process.argv.slice(2));
const wants = (name) => flags.has('--all') || flags.has(name);

const config = readAiConfig();
if (!config.apiKey) {
  console.error('EXPERIENTIAL_API_KEY não configurada. Exporte a chave no terminal e rode de novo.');
  process.exit(2);
}

const gateway = new ExperientialGateway({
  apiKey: config.apiKey,
  baseUrl: config.baseUrl,
  timeoutMs: config.timeoutMs,
});

let failures = 0;

function heading(title) {
  console.log(`\n=== ${title} ===`);
}

function report(label, ok, details = '') {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${details ? ` — ${details}` : ''}`);
  if (!ok) failures += 1;
}

if (wants('--models')) {
  heading('GET /v1/models');
  try {
    const models = await gateway.listModels();
    report('lista de modelos', models.length > 0, `${models.length} slugs`);
    console.log(`     ${models.slice(0, 12).join(', ')}${models.length > 12 ? ' …' : ''}`);
    console.log(`     decisões: ${models.includes('gpt-6-luna-decisions') ? 'gpt-6-luna-decisions disponível' : 'gpt-6-luna-decisions AUSENTE'}`);
  } catch (error) {
    report('lista de modelos', false, error.message);
  }
}

if (wants('--decision')) {
  heading('POST /v1/decisions (gpt-6-luna-decisions)');
  const request = buildDecisionRequest({
    input: [
      'Review a proposed change before a human decides whether to merge it.',
      'Change: reject an empty project name before writing a record.',
      'Tests: the new empty-name test and existing creation tests pass; no integration tests were run.',
    ].join(' '),
    questions: [
      {
        type: 'choice',
        name: 'review',
        instructions: 'Does the supplied evidence support accepting this change, or does it need further review? Treat missing evidence as a reason to review.',
        choices: [
          { value: 'accept', description: 'The described change meets the task and the supplied tests cover its relevant behavior.' },
          { value: 'review', description: 'Evidence is missing, the tests are insufficient, or the change may be incorrect.' },
        ],
      },
    ],
  });

  try {
    const result = await gateway.decisions(request);
    const answer = findAnswer(result.answers, 'review');
    const summary = describeAnswer(answer);
    report('decisão recebida', summary.found && !summary.refused, summary.summary);
    console.log(`     tipo: ${summary.type} · escolha: ${summary.choice ?? '-'} · confiança: ${summary.confidence ?? '-'}`);
    console.log(`     uso: ${JSON.stringify(result.usage)}`);
    console.log(`     resposta bruta: ${JSON.stringify(result.answers[0])}`);
  } catch (error) {
    report('decisão', false, error.message);
  }
}

if (wants('--chat')) {
  heading(`POST /v1/chat/completions (${config.chatModel}, streaming)`);
  try {
    let text = '';
    let usage = null;
    for await (const chunk of gateway.chatStream({
      model: config.chatModel,
      messages: [{ role: 'user', content: 'Responda em uma frase: o que é uma revisão de código?' }],
    })) {
      if (chunk.type === 'delta') text += chunk.text;
      else if (chunk.type === 'done') usage = chunk.usage;
    }
    report('streaming', text.trim().length > 0, `${text.trim().length} caracteres`);
    console.log(`     texto: ${text.trim().slice(0, 240)}`);
    console.log(`     uso: ${JSON.stringify(usage)}`);
  } catch (error) {
    report('streaming', false, error.message);
  }
}

if (wants('--image')) {
  heading(`POST /v1/chat/completions (${config.imageModel}, imagem)`);
  try {
    const result = await gateway.generateImage({
      prompt: 'Pôster minimalista de uma live de votação, fundo verde e dourado.',
      model: config.imageModel,
    });
    const inlined = await gateway.inlineImages(result.images);
    const withData = inlined.filter((image) => image.dataUrl);
    report('imagem gerada', withData.length > 0, `rota: ${result.route} · ${withData.length} imagem(ns)`);
    if (withData[0]) {
      const bytes = Math.round((withData[0].dataUrl.length * 3) / 4);
      console.log(`     tamanho embutido: ~${bytes} bytes · prefixo: ${withData[0].dataUrl.slice(0, 40)}…`);
    }
    for (const failure of inlined.filter((image) => !image.dataUrl)) {
      console.log(`     não embutida: ${failure.error}`);
    }
    console.log(`     uso: ${JSON.stringify(result.usage)}`);
  } catch (error) {
    report('imagem', false, error.message);
  }
}

console.log(`\n${failures === 0 ? 'Tudo certo.' : `${failures} seção(ões) com problema.`}`);
process.exit(failures === 0 ? 0 : 1);
