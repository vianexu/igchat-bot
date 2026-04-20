const express = require('express');
const axios   = require('axios');
const app     = express();

app.use(express.json());

const VERIFY_TOKEN   = process.env.VERIFY_TOKEN   || 'botinstagram123seguro';
const ACCESS_TOKEN   = process.env.ACCESS_TOKEN;
const DEEPSEEK_KEY   = process.env.DEEPSEEK_API_KEY;
const IG_USER_ID     = process.env.IG_USER_ID     || '34788431294134082';
const IG_USERNAME    = process.env.IG_USERNAME    || 'menosansiedade.site';
const IG_API         = 'https://graph.instagram.com/v21.0';

// IDs de comentários já respondidos (evita loop)
const repliedComments = new Set();

const BOT_PERSONA = process.env.BOT_PERSONA ||
  `Você é uma assistente humanizada de uma conta do Instagram chamada @menosasiedade. Responda de forma natural, simpática e breve (máximo 3 linhas). Use linguagem informal e acolhedora. Nunca mencione que é uma IA. Se não souber a resposta, diga que vai verificar e retornar em breve.`;

// ── Histórico por usuário (máx 10 trocas, TTL 30 min) ────────────────────────
const histories = new Map();
const HISTORY_TTL = 30 * 60 * 1000;

function getHistory(uid) {
  const entry = histories.get(uid);
  if (!entry || Date.now() - entry.ts > HISTORY_TTL) {
    histories.set(uid, { ts: Date.now(), msgs: [] });
  } else {
    entry.ts = Date.now();
  }
  return histories.get(uid).msgs;
}

function pushHistory(uid, role, content) {
  const msgs = getHistory(uid);
  msgs.push({ role, content });
  if (msgs.length > 20) msgs.splice(0, 2);
}

// ── DeepSeek ──────────────────────────────────────────────────────────────────
async function askDeepSeek(uid, userText) {
  if (!DEEPSEEK_KEY) throw new Error('DEEPSEEK_API_KEY não configurado');

  pushHistory(uid, 'user', userText);

  const response = await axios.post(
    'https://api.deepseek.com/chat/completions',
    {
      model: 'deepseek-chat',
      max_tokens: 200,
      messages: [
        { role: 'system', content: BOT_PERSONA },
        ...getHistory(uid)
      ]
    },
    { headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' } }
  );

  const reply = response.data.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('Resposta vazia do DeepSeek');

  pushHistory(uid, 'assistant', reply);
  return reply;
}

// ── Enviar DM ─────────────────────────────────────────────────────────────────
async function sendDM(recipientId, text) {
  if (!ACCESS_TOKEN) { console.error('❌ ACCESS_TOKEN não configurado'); return; }
  try {
    await axios.post(
      `${IG_API}/me/messages?access_token=${ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, message: { text } }
    );
    console.log('✅ DM enviado');
  } catch (e) {
    console.error('❌ Erro ao enviar DM:', e.response?.data || e.message);
  }
}

// ── Responder comentário ──────────────────────────────────────────────────────
async function replyComment(commentId, text) {
  if (!ACCESS_TOKEN) { console.error('❌ ACCESS_TOKEN não configurado'); return; }
  try {
    await axios.post(
      `${IG_API}/${commentId}/replies`,
      new URLSearchParams({ message: text, access_token: ACCESS_TOKEN }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    console.log('✅ Reply no comentário enviado');
  } catch (e) {
    console.error('❌ Erro ao responder comentário:', e.response?.data || e.message);
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'online', service: 'igchat-bot', timestamp: new Date().toISOString() });
});

// ── Webhook verification ──────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  console.log('🔍 Verificação webhook:', { mode, token });
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado!');
    return res.status(200).send(challenge);
  }
  console.log('❌ Token não bate');
  res.sendStatus(403);
});

// ── Webhook events ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Responde 200 imediatamente — Meta exige < 20s
  res.sendStatus(200);

  const body = req.body;
  console.log('📨 Evento:', JSON.stringify(body, null, 2));

  if (body.object !== 'instagram') return;

  for (const entry of (body.entry || [])) {
    // ── DMs ──────────────────────────────────────────────────────────────
    for (const event of (entry.messaging || [])) {
      const senderId = event.sender?.id;
      const text     = event.message?.text;

      if (!senderId || !text) continue;
      if (senderId === IG_USER_ID) continue; // ignorar eco próprio

      console.log(`📩 DM de ${senderId}: ${text}`);
      try {
        const reply = await askDeepSeek(senderId, text);
        console.log(`💬 Resposta: ${reply}`);
        await sendDM(senderId, reply);
      } catch (e) {
        console.error('❌ Erro ao responder DM:', e.message);
        await sendDM(senderId, 'Olá! No momento estou com dificuldades técnicas. Tente novamente em instantes 🙏');
      }
    }

    // ── Comentários ──────────────────────────────────────────────────────
    for (const change of (entry.changes || [])) {
      if (change.field !== 'comments') continue;

      const val       = change.value || {};
      const commentId = val.id;
      const fromId    = val.from?.id;
      const text      = val.text;

      if (!commentId || !text) continue;
      // Só responder comentários raiz — replies têm parent_id e causam loop
      if (val.parent_id) continue;
      // Ignorar próprios comentários (por ID, username e já respondidos)
      if (fromId === IG_USER_ID) continue;
      if (val.from?.username === IG_USERNAME) continue;
      if (repliedComments.has(commentId)) continue;

      repliedComments.add(commentId);
      // Limpar set após 1000 entradas para não vazar memória
      if (repliedComments.size > 1000) repliedComments.clear();

      console.log(`💬 Comentário de ${val.from?.username || fromId}: ${text}`);
      try {
        const reply = await askDeepSeek(`comment_${fromId}`, text);
        console.log(`💬 Resposta: ${reply}`);
        await replyComment(commentId, reply);
      } catch (e) {
        console.error('❌ Erro ao responder comentário:', e.message);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 igchat-bot rodando na porta ${PORT}`));
