const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// Variáveis de ambiente (Railway irá configurar)
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "botinstagram123seguro";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

// ====================== VERIFICAÇÃO ======================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log("🔍 Verificação recebida:", { mode, token, challenge });

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado!");
    return res.status(200).send(challenge);
  }
  
  console.log("❌ Token não bate");
  res.sendStatus(403);
});

// ====================== HEALTH CHECK ======================
app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'Instagram Bot',
    timestamp: new Date().toISOString()
  });
});

// ====================== RECEBER E RESPONDER ======================
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log("📨 Evento recebido:", JSON.stringify(body, null, 2));

    // Processa mensagens
    if (body.object === "instagram") {
      for (const entry of body.entry) {
        // Formato mais comum
        if (entry.messaging) {
          for (const event of entry.messaging) {
            if (event.message && event.message.text) {
              const senderId = event.sender.id;
              const text = event.message.text;

              console.log(`📩 Mensagem de ${senderId}: ${text}`);

              // Resposta automática
              await sendMessage(senderId, `Olá! Recebi sua mensagem: "${text}" 👋\nEstou funcionando via bot!`);
            }
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro:", err);
    res.sendStatus(200);
  }
});

async function sendMessage(recipientId, text) {
  try {
    if (!ACCESS_TOKEN) {
      console.error("❌ ACCESS_TOKEN não configurado!");
      return;
    }

    const response = await axios.post(
      `https://graph.instagram.com/v21.0/me/messages?access_token=${ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: { text: text }
      }
    );
    console.log("✅ Resposta enviada com sucesso!");
  } catch (err) {
    console.error("❌ Erro ao enviar resposta:", err.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}...`));