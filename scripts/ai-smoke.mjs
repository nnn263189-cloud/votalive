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
 *
 * Se EXPERIENTIAL_API_KEY não estiver no ambiente, o script procura um .env
 * na raiz do projeto (mesmo formato do .env.example). O .env nunca vai para o
 * Git: está no .gitignore.
 */

import { readAiConfig } from '../src/ai/config.js';
import { buildDecisionRequest, describeAnswer, findAnswer } from '../src/ai/decisions.js';
import { ExperientialGateway } from '../src/ai/gateway.js';
import { loadEnvFile, projectEnvPath } from '../src/env-file.js';

const flags = new Set(process.argv.slice(2));
const wants = (name) => flags.has('--all') || flags.has(name);

await loadEnvFile(projectEnvPath());

const config = readAiConfig();
if (!config.apiKey) {
  console.error('EXPERIENTIAL_API_KEY não configurada.');
  console.error('  Opção 1: exporte a variável no terminal');
  console.error("    EXPERIENTIAL_API_KEY='xpl_...' node scripts/ai-smoke.mjs");
  console.error('  Opção 2: crie um arquivo .env na raiz do projeto com');
  console.error("    EXPERIENTIAL_API_KEY=xpl_...");
  console.error('  (o .env está no .gitignore e nunca é enviado ao Git)');
  process.exit(2);
}

const gateway = new ExperientialGateway({
  apiKey: config.apiKey,
  baseUrl: config.baseUrl,
  timeoutMs: config.timeoutMs,
});

let failures = 0;
const results = [];

function heading(title) {
  console.log(`\n=== ${title} ===`);
}

function report(label, ok, details = '') {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${details ? ` — ${details}` : ''}`);
  results.push({ name: label, ok, detail: details });
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

    // Diagnóstico: o modelo exigido pode não estar liberado na conta. Só
    // testamos o alternative quando o gateway recusou o modelo de forma
    // explícita (nunca em timeout ou erro de transporte, que podem ter
    // cobrado).
    const rejected = [400, 404, 422].includes(error?.status)
      && /model|slug|not found|unknown/i.test(String(error.message));
    if (rejected) {
      console.log('     o gateway recusou o modelo; testando gpt-6-luna no mesmo endpoint…');
      try {
        const alternative = await gateway.decisions({ ...request, model: 'gpt-6-luna' });
        const answer = findAnswer(alternative.answers, 'review');
        const summary = describeAnswer(answer);
        console.log(`     com gpt-6-luna: ${summary.summary} · uso: ${JSON.stringify(alternative.usage)}`);
        console.log(`     bruto: ${JSON.stringify(alternative.answers[0])}`);
      } catch (fallbackError) {
        console.log(`     com gpt-6-luna também falhou: ${fallbackError.message}`);
      }
    }
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
console.log('\n--- resumo para colar ---');
for (const step of results) {
  console.log(`${step.ok ? 'OK' : 'FALHA'} | ${step.name} | ${step.detail}`);
}
console.log('--- fim ---');
process.exit(failures === 0 ? 0 : 1);
