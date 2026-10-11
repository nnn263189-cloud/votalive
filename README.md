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
- `public/index.html` e `public/app.js` — painel.
- `test/` — testes automatizados.
- `ci/smoke-production.yml` — workflow de smoke test de produção (copie para `.github/workflows/` para ativar).
