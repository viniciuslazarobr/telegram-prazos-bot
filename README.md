# ⚖️ Bot de Telegram para Controle e Lembretes de Prazos de Escritório

Aplicação completa em **Node.js + TypeScript** de um Bot de Telegram multi-usuário para escritórios de advocacia e consultorias (voltado para 3 usuários: **Irmão, Amigo e Chefe**).

O bot roda **gratuitamente 24/7 no Render (Web Service)**, mantido acordado pelo **UptimeRobot**, utilizando **Supabase (PostgreSQL)** como banco de dados na nuvem e **Google Gemini** para compreensão de áudios de voz e texto livre.

---

## 🎯 Como Funciona no Escritório

```
                   ┌──────────────────────────────────────────────┐
                   │               3 USUÁRIOS                     │
                   │        (Irmão, Amigo e Chefe)                │
                   └───────┬──────────────┬──────────────┬────────┘
                           │              │              │
                   (Áudio, Texto,      (Áudio,       (Áudio,
                    Comandos)           Texto)        Texto)
                           │              │              │
                           ▼              ▼              ▼
                     ┌─────────────────────────────────────────┐
                     │          BOT DE TELEGRAM                │
                     │          (Long Polling)                 │
                     └────┬───────────────────────────────┬────┘
                          │                               │
                          ▼                               ▼
       ┌─────────────────────────────────────┐  ┌──────────────────────────────────┐
       │     NOTIFICAÇÕES INDIVIDUAIS        │  │     GRUPO GERAL DO ESCRITÓRIO    │
       │                                     │  │                                  │
       │  • Lembrete no privado do dono      │  │  • Avisos instantâneos de novos  │
       │  • Horários: 08:30, 14:00 e 17:00   │  │    prazos e conclusões           │
       │  • Botão [✅ Concluir Prazo]        │  │  • Painel diário às 08:30 com    │
       │                                     │  │    todos os prazos por pessoa    │
       └─────────────────────────────────────┘  └──────────────────────────────────┘
                          │
                          ▼
             ┌─────────────────────────┐
             │    SUPABASE POSTGRES    │
             │ team_members, processes │
             └─────────────────────────┘
```

1. **Cadastro e Responsabilidade Automática:**
   - Cada membro envia mensagens de voz, textos livres ou comandos no privado ou no grupo.
   - O sistema identifica quem enviou e salva automaticamente como responsável (`owner_telegram_id` e `owner_name`).
2. **Cobrança Direta no Celular:**
   - Às **08:30**, **14:00** e **17:00**, o bot envia uma mensagem privada no Telegram de quem está responsável por aquele processo com o botão inline `[✅ Concluir Prazo]`.
3. **Visão Compartilhada no Grupo Geral:**
   - Existe um **Grupo do Escritório** onde estão os 3 membros e o Bot.
   - Sempre que alguém cadastra um prazo ou conclui uma tarefa, um aviso é enviado imediatamente no grupo para todos acompanharem.
   - Às **08:30**, o bot envia o **Painel do Dia da Equipe**, listando os prazos de cada membro.
   - Comandos `/meus` (vê os próprios prazos) e `/geral` (vê os prazos dos 3 membros agrupados).

---

## 🚀 Stack Tecnológica

- **Linguagem & Runtime:** Node.js (v18+) com TypeScript.
- **Framework do Telegram:** `grammy` (Long Polling robusto com teclado inline).
- **Banco de Dados:** `@supabase/supabase-js` (PostgreSQL na nuvem com RLS).
- **Servidor HTTP Keep-Alive:** `express` (para monitoramento do UptimeRobot no Render).
- **Agendador (Cron):** `node-cron` com timezone fixo em `America/Sao_Paulo`.
- **Inteligência Artificial:** `@google/generative-ai` (Gemini 2.5 Flash / 1.5 Flash para transcrição de áudio e extração de datas relativas).

---

## 🗄️ Estrutura do Banco de Dados (Supabase)

O arquivo [`schema.sql`](./schema.sql) cria 3 tabelas essenciais:

1. `team_members`:
   - `telegram_user_id` (PK)
   - `name` (Nome de exibição, ex: "Irmão", "Chefe", "Amigo")
   - `username`
   - `created_at`
2. `processes`:
   - `id` (PK auto-incremento)
   - `process_number` (Número do processo)
   - `client_name` (Nome do cliente)
   - `deadline_info` (Descrição do prazo: apelação, contestação, etc.)
   - `owner_telegram_id` (ID de quem recebe a cobrança no privado)
   - `owner_name` (Nome do responsável)
   - `due_date` (Data `YYYY-MM-DD`)
   - `remind_days_before` (Padrão: 3 dias de antecedência)
   - `status` (`PENDENTE`, `CONCLUIDO`, `CANCELADO`)
   - `completed_by` / `completed_at`
3. `app_settings`:
   - `key` (PK, ex: `'office_group_chat_id'`)
   - `value`

---

## 📋 Guia de Instalação Passo a Passo

### Passo 1: Configurar o Supabase (Gratuito)
1. Crie uma conta em [supabase.com](https://supabase.com/) e crie um novo projeto.
2. No menu lateral, acesse **SQL Editor**.
3. Copie todo o conteúdo do arquivo [`schema.sql`](./schema.sql), cole no editor e clique em **Run**.
4. Acesse **Project Settings** -> **API**:
   - Copie o **Project URL** (`SUPABASE_URL`).
   - Copie a chave **service_role (secret)** (`SUPABASE_SERVICE_ROLE_KEY`). *Atenção: use a `service_role` para permitir que o bot salve dados no backend.*

---

### Passo 2: Criar o Bot no Telegram
1. Abra o Telegram e pesquise por `@BotFather`.
2. Envie o comando `/newbot`.
3. Escolha um nome (ex: `Prazos Escritório Bot`) e um username (ex: `prazos_escritorio_xyz_bot`).
4. Guarde o **Token HTTP API** fornecido (`TELEGRAM_BOT_TOKEN`).
5. No `@BotFather`, desative o modo de privacidade para que o bot leia mensagens no grupo:
   - Digite `/setprivacy` -> Escolha seu bot -> Selecione **Disable**.
   - *(Ou torne o bot Administrador no Grupo do Escritório).*

---

### Passo 3: Obter a Chave da API do Google Gemini (Gratuito)
1. Acesse [Google AI Studio](https://aistudio.google.com/).
2. Clique em **Get API Key** e crie uma nova chave gratuita.
3. Copie a chave (`GEMINI_API_KEY`).

---

### Passo 4: Teste Local
1. Clone o repositório ou navegue até a pasta do projeto:
   ```bash
   cd telegram-prazos-bot
   ```
2. Instale as dependências:
   ```bash
   npm install
   ```
3. Crie o arquivo `.env` baseado no `.env.example`:
   ```bash
   cp .env.example .env
   ```
4. Preencha as variáveis no `.env`:
   ```env
   TELEGRAM_BOT_TOKEN=seu_token_do_botfather
   SUPABASE_URL=https://seu-projeto.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=sua_service_role_key
   PORT=3000
   GEMINI_API_KEY=sua_chave_gemini
   TIMEZONE=America/Sao_Paulo
   ```
5. Inicie em modo de desenvolvimento:
   ```bash
   npm run dev
   ```

---

### Passo 5: Deploy Gratuito no Render (Web Service)
1. Suba este projeto para um repositório no **GitHub** (pode ser público ou privado).
2. Acesse [dashboard.render.com](https://dashboard.render.com/) e clique em **New +** -> **Web Service**.
3. Conecte seu repositório do GitHub.
4. Preencha as configurações:
   - **Name:** `bot-prazos-escritorio`
   - **Language:** `Node`
   - **Branch:** `main` (ou `master`)
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
5. Na seção **Environment Variables**, adicione as seguintes variáveis:
   - `TELEGRAM_BOT_TOKEN`: Token do BotFather
   - `SUPABASE_URL`: URL do Supabase
   - `SUPABASE_SERVICE_ROLE_KEY`: Service Role Key do Supabase
   - `GEMINI_API_KEY`: Chave do Google Gemini
   - `TIMEZONE`: `America/Sao_Paulo`
6. Clique em **Create Web Service**.
7. Após o deploy, o Render fornecerá uma URL pública como:
   `https://bot-prazos-escritorio.onrender.com`

---

### Passo 6: Manter o Bot 24/7 com UptimeRobot (Gratuito)
Os serviços gratuitos do Render entram em modo de suspensão após 15 minutos sem receber requisições HTTP. O `UptimeRobot` faz requisições periódicas a cada 5 minutos na rota `/health`, mantendo seu bot 100% acordado sem custos:

1. Acesse [uptimerobot.com](https://uptimerobot.com/) e crie uma conta gratuita.
2. Clique em **+ Add New Monitor**.
3. Configure:
   - **Monitor Type:** `HTTP(s)`
   - **Friendly Name:** `Bot Prazos Escritório`
   - **URL (or IP):** `https://seu-app.onrender.com/health`
   - **Monitoring Interval:** `5 minutes`
4. Clique em **Create Monitor**. Pronto! O bot nunca mais dormirá.

---

## 📱 Guia de Uso no Dia a Dia da Equipe

### 1. Primeiro Passo: Conectar os 3 Membros e o Grupo
1. **No Grupo do Escritório:**
   - Adicione o Bot ao grupo onde estão o **Irmão**, o **Amigo** e o **Chefe**.
   - Qualquer membro digita:
     ```
     /definir_grupo
     ```
   - O bot responde confirmando que aquele grupo agora é o Painel Oficial!
2. **No Privado do Bot:**
   - Cada um dos 3 abre uma conversa privada com o bot e digita:
     ```
     /start
     ```
   - Em seguida, define seu nome ou apelido com `/nome`:
     ```
     /nome Irmão
     /nome Chefe
     /nome Amigo
     ```

---

### 2. Cadastrando Prazos

#### Opção A: Por Mensagem de Voz (Áudio) 🎙️
Basta mandar um áudio no Telegram dizendo naturalmente:
> *"Processo 1002345 do cliente Banco Alfa, prazo de contestação vence na próxima sexta-feira."*

O Gemini transcreve, calcula a data correta no fuso de Brasília, salva no Supabase, responde com botões de ação e avisa imediatamente o Grupo Geral!

#### Opção B: Por Texto Livre ✍️
No privado do bot (ou no grupo começando com "Prazo:"):
> *"Processo 005544 do cliente Carlos Silva, prazo de réplica vence 10/11/2026"*

#### Opção C: Por Comando Direto ⚡
```
/novo 0012345-67.2024.8.26.0100 | Banco Itaú | Apelação | 28/11/2026
```

---

### 3. Consultas e Painéis

- `/meus` — Mostra apenas os prazos em aberto do usuário que digitou, com botões `[✅ Concluir #ID]`.
- `/geral` — Mostra os prazos de todos os 3 membros separados por responsável:
  ```
  📊 PAINEL GERAL DO ESCRITÓRIO

  👤 Chefe (2 prazos):
    ⚠️ 12345 | Banco X (Contestação - Vence: 24/10)
    📅 67890 | Silva (Apelação - Vence: 30/10)

  👤 Irmão (1 prazo):
    ⏳ 99887 | Construtora Y (Réplica - Vence: 25/10)
  ```
- `/hoje` — Lista todos os prazos do escritório que vencem hoje, amanhã ou estão atrasados.
- `/teste_alerta` — Dispara na hora a rotina de notificações (privado + grupo) para testar sem esperar 08:30.

---

### 4. Como Dar Baixa no Prazo
Quando você cumprir o prazo:
1. No lembrete privado ou na listagem do `/meus`, clique em **[✅ Concluir Prazo]**.
2. O bot atualiza o banco para `CONCLUIDO`, para de enviar lembretes e envia um aviso no Grupo Geral:
   > *✅ **Irmão** concluiu o prazo do Processo `12345` (Cliente: Banco Alfa)!*

---

## ⏰ Tabela de Horários dos Lembretes Automáticos

| Horário | O que o Bot faz |
| :--- | :--- |
| **08:30** | Dispara cobrança privada para cada membro com botão de concluir + Envia o **Painel do Dia da Equipe** no Grupo Geral. |
| **14:00** | Cobrança urgente no privado e no grupo apenas para prazos que **vencem hoje, amanhã ou estão atrasados**. |
| **17:00** | Última cobrança urgente de fim de expediente para prazos críticos. |

---

## 🛡️ Segurança e Robustez

- **Timezone Garantido:** Todos os cálculos de dias restantes utilizam `America/Sao_Paulo`.
- **Prevenção de Quedas:** Middleware `bot.catch()` impede que erros de rede ou bloqueios de usuários derrubem a aplicação.
- **Graceful Shutdown:** Encerramento seguro de conexões ao reiniciar containers no Render.
- **Supabase Service Role:** Acesso seguro direto ao banco via token de backend protegido.
