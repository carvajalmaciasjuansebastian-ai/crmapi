const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// 1. Verificación del Webhook para Meta
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verificado correctamente');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// 2. Recepción de mensajes de los usuarios
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    try {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      if (message && message.type === 'text') {
        const from = message.from; // Número del cliente
        const text = message.text.body; // Mensaje del cliente

        console.log(`Mensaje recibido de ${from}: ${text}`);

        // Responder automáticamente
        await sendWhatsAppMessage(
          from,
          `¡Hola! 👋 Recibimos tu mensaje: "${text}". Te enviamos la información de las dinámicas en un momento.`
        );
      }

      res.sendStatus(200);
    } catch (error) {
      console.error('Error al procesar el mensaje:', error);
      res.sendStatus(500);
    }
  } else {
    res.sendStatus(404);
  }
});

// Función para enviar mensaje usando la API Oficial de Meta
async function sendWhatsAppMessage(to, text) {
  try {
    await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      data: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: { body: text }
      }
    });
  } catch (error) {
    console.error('Error al responder mensaje:', error.response ? error.response.data : error.message);
  }
}

app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});