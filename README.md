# VotaLive — presentes do TikTok LIVE viram pontos

Painel compartilhado de apuração em tempo real. O servidor acompanha uma LIVE, interpreta os presentes finalizados e mantém um único placar para todos os navegadores conectados.

## Regras preservadas

| Presente | Pontos por unidade | Candidato |
|---|---:|---|
| Rosa normal | 10 | Lula (A) |
| GG | 10 | Flavio Bolsonaro (B) |
| Mini Dino | 100 | Lula (A) |
| Rosa de 10 moedas | 100 | Flavio Bolsonaro (B) |
| Mãos em coração | 1.000 | Lula (A) |
| Urso Misha | 1.000 | Flavio Bolsonaro (B) |

Presentes desconhecidos aparecem no histórico e no total de presentes, mas **não recebem pontos**: preço em moedas não informa para qual candidato o presente deveria ir.

## Requisitos

- Node.js **22 ou superior**
- npm
- Internet no servidor
- O criador precisa estar ao vivo no momento da conexão

O `tiktok-live-connector` 2.5.0 declara Node 20+, mas a versão bloqueada de sua dependência `got` exige Node 22. Por isso, `.nvmrc`, `nixpacks.toml` e `package.json` fixam o ambiente em Node 22 ou superior. O projeto usa ES modules de forma nativa (`"type": "module"`).

## Rodar localmente

```bash
npm ci
npm start
```

Abra <http://localhost:3000>. Em ambiente local, sem `ADMIN_TOKEN`, os controles ficam desbloqueados e o servidor exibe um aviso.

Para testar com proteção igual à produção:

```bash
ADMIN_TOKEN='gere-um-segredo-longo-e-aleatorio' npm start
```

O token é digitado no próprio painel. Ele fica apenas no `sessionStorage` da aba e não é colocado na URL.

## Como a contagem funciona

- Atualizações intermediárias de combos (`giftType: 1`) são ignoradas.
- Apenas o evento final (`repeatEnd`) entra na apuração.
- Pontos e “Presentes recebidos” são multiplicados por `repeatCount`.
- “Participantes únicos” usa o ID do remetente (ou o username quando o ID não existe).
- “Eventos finalizados” é uma métrica separada mantida no estado e representa cada envio/combo concluído.
- IDs de evento recentes são guardados para impedir pontuação duplicada.
- O parser aceita tanto o formato v3 do conector 2.5.0 (`gift.name`, `gift.diamondCount`, `gift.type`) quanto o formato legado.

Uma rosa normal enviada em combo de 10 continua sendo Rosa normal: a escolha da regra usa o preço **por unidade**, não o total do combo.

## Sessões e persistência

O placar agora pertence ao servidor. Atualizar a página, abrir outro navegador ou perder e recuperar o WebSocket restaura o mesmo estado.

- Ao conectar à mesma `roomId`, a sessão e o placar são preservados.
- Ao detectar uma `roomId` diferente, o servidor cria automaticamente uma sessão vazia.
- Quando a LIVE termina, o resultado permanece visível.
- “Zerar placar da sessão” limpa o estado para todos os painéis conectados.
- Os 100 eventos mais recentes e o placar são gravados em `data/state.json` por padrão.

Para desativar a gravação em disco:

```bash
STATE_FILE=off npm start
```

Em hospedagem com disco efêmero, monte um volume e aponte para ele, por exemplo:

```bash
STATE_FILE=/data/votalive-state.json
```

Sem volume, o estado continua sobrevivendo a recargas do painel e reconexões, mas pode ser perdido quando a plataforma recriar o container.

## Conexão com o TikTok (assinatura pela Euler Stream)

O `tiktok-live-connector` assina cada handshake do WebSocket por meio do serviço Euler Stream. Sem uma chave própria, o conector usa o acesso compartilhado, que o TikTok recusa com frequência: o painel exibe `ERRO` e a mensagem do conector (rota da Euler Stream, `401/402/403`, limite de uso ou recurso premium).

Para liberar a conexão:

1. Crie uma chave em <https://www.eulerstream.com>.
2. No Railway, abra o serviço → **Variables** → adicione `SIGN_API_KEY` (segredo).
3. Faça o redeploy do serviço: a chave é lida na inicialização.
4. Abra o painel e conecte o `@username` de uma LIVE que esteja no ar.

A chave nunca é gravada no Git nem enviada ao navegador; o servidor apenas informa se ela existe e qual foi o tipo da última falha:

- `GET /healthz` devolve `signing`, `extendedGiftInfo`, `kind`, `hint` e `codes` (identificadores curtos das falhas internas), além de `connection`, `username` e `message`;
- o painel mostra a dica acionável nos estados `ERRO` e `RECONECTANDO` e no aviso do TikTok;
- o log do servidor avisa `SIGN_API_KEY não definida` quando a chave está ausente;
- `kind` classifica a falha em `signing`, `plan`, `rate_limit`, `offline`, `network`, `room_id` ou `unknown`. `plan` significa que a Euler Stream respondeu, mas o plano não inclui a rota (`PremiumFeatureError`); a dica não manda redefinir a chave, porque trocar a chave por outra do mesmo plano não resolve.

Se a falha for na descoberta da sala (`Failed to retrieve Room ID from Euler Stream … lack of permission`), a alternativa documentada pelo conector é desativar a rota de fallback com `TIKTOK_SKIP_EULER_FALLBACK=true`, mantendo apenas as rotas nativas do TikTok.

### Catálogo de presentes: desativado por padrão (`TIKTOK_EXTENDED_GIFT_INFO`)

O conector tem a opção `enableExtendedGiftInfo`, que baixa o catálogo de presentes da sala durante a conexão (`gift/list/`). Essa requisição é assinada pela **rota de assinatura de URL da Euler Stream, que é premium** (plano Business; relatos de uso do conector citam a mensagem `This endpoint requires a Business plan`). Sem um plano que a inclua, a Euler responde 403, o conector lança `PremiumFeatureError` e a conexão inteira é abortada **antes** de o WebSocket ser pedido, mesmo com a `SIGN_API_KEY` configurada.

O VotaLive não precisa desse catálogo: id, nome, tipo e valor em moedas já vêm em cada evento de presente (`gift.id`, `gift.name`, `gift.type`, `gift.diamondCount`), e o parser só usa `extendedGiftInfo` como enriquecimento opcional. Por isso a opção fica **desligada**, e a assinatura do WebSocket continua usando a `SIGN_API_KEY`. Para ligá-la (somente com plano Business):

```bash
TIKTOK_EXTENDED_GIFT_INFO=true
```

`GET /healthz` mostra `extendedGiftInfo` e o log de inicialização avisa quando ela está ligada. Se um presente chegar sem `gift.name`, ele aparece no log como `Presente #<id>`, não pontua e fica registrado como não mapeado; só uma LIVE real confirma como os nomes chegam sem o catálogo (veja *Testes e verificações*).

## Segurança dos controles

Leitura do placar é pública. Os comandos que alteram o sistema — conectar, desconectar, simular presente e zerar — exigem `ADMIN_TOKEN` quando ele está configurado.

Em `NODE_ENV=production` **ou quando detecta o ambiente do Railway**, o servidor não inicia sem `ADMIN_TOKEN`. A única exceção explícita é `ALLOW_INSECURE_CONTROL=true`, que **não é recomendada** em um endereço público.

Também há:

- validação de origem do WebSocket;
- limite de comandos por conexão;
- limite de tamanho das mensagens;
- comparação de token resistente a timing;
- heartbeat para remover sockets mortos;
- cabeçalhos básicos de segurança.

## Publicar no Railway

1. Envie este repositório ao GitHub e crie um serviço no Railway.
2. Configure as variáveis:
   - `ADMIN_TOKEN`: segredo longo e aleatório;
   - `NODE_ENV=production`;
   - opcionalmente `STATE_FILE=/data/votalive-state.json` junto de um volume em `/data`.
3. O Railway usa `npm start`; `PORT` é lida automaticamente.
4. O health check está em `/healthz` e já consta em `railway.json`.
5. Abra o domínio HTTPS, digite o token no painel e conecte o `@username` da LIVE.

Nunca coloque o token no código, no Git ou em uma variável exposta ao navegador.

## Variáveis de ambiente

| Variável | Padrão | Função |
|---|---|---|
| `PORT` | `3000` | Porta HTTP/WebSocket |
| `HOST` | `0.0.0.0` | Interface de rede |
| `ADMIN_TOKEN` | vazio no desenvolvimento | Protege comandos de controle |
| `STATE_FILE` | `data/state.json` | Arquivo de persistência; use `off` para desativar |
| `ALLOWED_ORIGINS` | mesma origem | Origens extras, separadas por vírgula |
| `ALLOW_INSECURE_CONTROL` | `false` | Permite produção sem token; não recomendado |
| `SIGN_API_KEY` | vazio | Chave da Euler Stream que assina a conexão do TikTok |
| `TIKTOK_SKIP_EULER_FALLBACK` | `false` | Desativa a rota de fallback da Euler Stream ao descobrir a sala |
| `TIKTOK_EXTENDED_GIFT_INFO` | `false` | Liga o catálogo de presentes (rota premium `gift/list/`, plano Business); sem o plano a conexão falha |
| `EXPERIENTIAL_API_KEY` | vazio | Chave do gateway Experiential; sem ela o app de IA (`/ai`) fica desativado |
| `AI_BASE_URL` | `https://api.experientiallabs.ai/v1` | Base do gateway usada pelo app de IA |
| `AI_CHAT_MODEL` | `gpt-6-luna` | Modelo de conversa e de código |
| `AI_IMAGE_MODEL` | `gemini-3.1-flash-image` | Modelo de geração de imagens |
| `AI_WORKSPACE_ROOT` | raiz do projeto | Pasta que o agente de código pode ler e alterar |
| `AI_TEST_COMMAND` | `npm test` | Comando que o painel de IA executa ao testar |
| `AI_TIMEOUT_MS` | `120000` | Tempo limite de cada chamada ao gateway |
| `AI_MAX_AGENT_STEPS` | `12` | Passos máximo do agente de código por pedido |

## App de IA (`/ai`)

O projeto tem um app de IA próprio, no mesmo servidor e com a mesma chave de
administrador do painel. Ele conversa, cria imagens, responde perguntas
tipadas e — mediante a sua aprovação — altera o código do projeto.

```bash
EXPERIENTIAL_API_KEY='xpl_...' npm start
# depois abra http://localhost:3000/ai
```

A chave é lida **apenas** de `EXPERIENTIAL_API_KEY`, no servidor. O navegador
nunca a recebe: ela fica no backend, que fala com o gateway
`https://api.experientiallabs.ai/v1` (compatível com a OpenAI). Sem a chave o
app avisa que está desativado e as rotas respondem `503`.

### O que dá para fazer

| Aba | O que faz | Rota |
|---|---|---|
| **Conversar** | Chat com `gpt-6-luna`, resposta em streaming (SSE) | `POST /api/ai/chat` |
| **Criar imagem** | Gera imagens e mostra o resultado na conversa | `POST /api/ai/image` |
| **Mudar o código** | Agente que lê o projeto, propõe mudanças e roda os testes | `POST /api/ai/agent` |
| **Decisão tipada** | Perguntas `predicate`, `choice` e `score` no `/v1/decisions` | `POST /api/ai/decision` |

O painel da direita mostra os arquivos do projeto, as mudanças pendentes (com
diff) e a saída dos testes.

### O agente de código não age sozinho

O agente recebe seis ferramentas: `list_files`, `read_file`, `write_file`,
`edit_file`, `delete_file` e `run_tests`. As três de escrita **não gravam
nada**: elas montam uma mudança pendente, o painel mostra o diff e só o botão
“Aplicar alterações” grava no disco. “Descartar” joga fora. O `run_tests`
roda o comando fixo configurado em `AI_TEST_COMMAND` — o modelo não escolhe o
comando.

Além disso:

- caminhos são resolvidos dentro da pasta do projeto: `..`, caminhos absolutos
  e links simbólicos para fora são recusados;
- `run_tests` e as escritas ficam registradas na sessão, com TTL de 30 minutos;
- nada de merge, push ou execução automática de uma escolha devolvida pelo
  modelo.

### Decisões tipadas

O app usa o `POST /v1/decisions` do gateway com o modelo `gpt-6-luna-decisions`
(nome exato). O corpo é `model`, `input` (texto, ou mensagens com partes
`input_text` e `input_image` base64) e `questions`. Cada pergunta tem
`instructions`, um `type` e, opcionalmente, um `name` único:

- `predicate` — devolve a probabilidade de a afirmação ser verdadeira;
- `choice` — devolve um valor entre as `choices` informadas;
- `score` — devolve a nota média ponderada sobre os `levels` ordenados.

Os limites do gateway são validados antes do envio: no máximo 32 perguntas, 64
opções por `choice` e de 2 a 10 níveis por `score`. As respostas voltam na
ordem das perguntas; uma pergunta sem `name` volta sem nome e uma recusa do
modelo aparece como recusa, não como erro. O painel mostra a resposta, as
probabilidades e o uso de tokens.

Probabilidade e confiança não são garantia de acerto: a decisão é sempre
inspeção humana, nunca execução automática.

### Uma requisição por chamada

Nenhuma chamada do app tem retry automático nem `Idempotency-Key`: um timeout
pode ter deixado a requisição já cobrada. O timeout é limitado
(`AI_TIMEOUT_MS`) e os erros de HTTP e de transporte aparecem na tela com o
status e o corpo da resposta.

### Arquivos

- `src/ai/config.js` — leitura das variáveis de ambiente.
- `src/ai/gateway.js` — cliente do gateway (chat, streaming, imagens, decisões).
- `src/ai/decisions.js` — montage e validação das perguntas tipadas.
- `src/ai/agent.js` — ferramentas do agente de código e mudanças pendentes.
- `src/ai/workspace.js` — leitura e escrita dentro da pasta do projeto.
- `src/ai/diff.js` — diff unificado para pré-visualizar as mudanças.
- `src/ai/router.js` — rotas HTTP e sessões do app.
- `public/ai.html` e `public/ai.js` — interface do app de IA.
- `test/ai-*.test.js` — testes com gateway e filesystem simulados (sem rede).

### Verificação real do gateway

```bash
EXPERIENTIAL_API_KEY='xpl_...' npm run ai:smoke
```

O script (`scripts/ai-smoke.mjs`) faz **uma requisição por seção**, sem retry e
sem `Idempotency-Key`, e imprime o status, a resposta e o uso de tokens:

| Seção | Comando | O que faz |
|---|---|---|
| Modelos | `--models` | `GET /v1/models` e confere se `gpt-6-luna-decisions` está liberado |
| Decisão | `--decision` | `POST /v1/decisions` com a pergunta de revisão e lê a resposta pela posição |
| Conversa | `--chat` | `POST /v1/chat/completions` em streaming |
| Imagem | `--image` | Gera uma imagem (custa mais; fora do padrão) |

A chave é lida só de `EXPERIENTIAL_API_KEY` e nunca é impressa. Sem a chave o
script sai com código 2 e explica o que falta.

O mesmo script roda no GitHub Actions pelo workflow `ci/ai-live-smoke.yml`,
que usa o secret `EXPERIENTIAL_API_KEY` do repositório (a chave nunca entra no
código, no log nem no histórico do git). O arquivo fica em `ci/` porque a
automação que publica este repositório não tem permissão para criar arquivos
em `.github/workflows/`; copie-o à mão:

```bash
cp ci/ai-live-smoke.yml .github/workflows/ai-live-smoke.yml
gh secret set EXPERIENTIAL_API_KEY   # cole a chave quando perguntar
```

Depois, em **Actions → AI live smoke → Run workflow**, ele roda a verificação
no runner do GitHub, que tem internet aberta.

## Testes e verificações

```bash
npm test
npm run check
npm audit --omit=dev
```

Para verificar o deployment em produção sem abrir o painel, ative o workflow de smoke test:

```bash
cp ci/smoke-production.yml .github/workflows/smoke-production.yml
git add .github/workflows/smoke-production.yml
git commit -m "Ativar smoke test de produção"
git push
```

Depois, em **Actions → Smoke test produção → Run workflow**, ele consulta `/healthz` e `/api/state` do domínio público e imprime a fase da conexão com o motivo do erro (se houver) e o placar atual. O arquivo fica em `ci/` porque a conexão de GitHub App usada pela automação não tem permissão `workflows` para criar arquivos em `.github/workflows/` diretamente.

Os testes cobrem regras de presentes, nomes normalizados, formato v3 e legado, combos, deduplicação, métricas, persistência lógica e troca automática de sessão por `roomId`. Também rodam o conector real contra um cliente Euler Stream falso (sem rede) para provar que, por padrão, a conexão não usa a rota premium `gift/list/` e que a recusa de plano vira `kind: "plan"`.

A integração com uma LIVE real ainda depende de uma conta que esteja transmitindo e do comportamento atual dos serviços do TikTok. Se o TikTok mudar o nome localizado de um presente, adicione o alias em `src/gifts.js` e inclua um caso de teste.

A conexão com uma LIVE real só pode ser considerada validada quando: `/healthz` mostra `connection: "connected"` com a `roomId`, um presente genuíno enviado por um espectador aparece no histórico e o placar do candidato muda. Os testes automatizados e o smoke test de `/healthz` **não** cobrem esse caminho: eles não abrem a LIVE nem recebem presentes.

## Estrutura

- `server.js` — HTTP, WebSocket, autenticação e integração dos componentes.
- `src/gifts.js` — regras e normalização dos eventos de presente.
- `src/state-store.js` — sessão e placar compartilhado.
- `src/persistence.js` — gravação atômica do estado.
- `src/live-manager.js` — conexão e reconexão com o TikTok LIVE.
- `src/ai/` — app de IA: gateway, decisões tipadas, agente de código e rotas.
- `public/index.html` e `public/app.js` — painel.
- `public/ai.html` e `public/ai.js` — app de IA.
- `test/` — testes automatizados.
- `ci/smoke-production.yml` — workflow de smoke test de produção (copie para `.github/workflows/` para ativar).
