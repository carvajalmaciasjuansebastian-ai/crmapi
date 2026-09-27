const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// 1. Verificación del Webhook para Meta (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verificado correctamente');
      return res.status(200).send(challenge);
    } else {
      console.error('❌ Token de verificación incorrecto');
      return res.sendStatus(403);
    }
  }
  res.sendStatus(400);
});

// 2. Recepción de eventos y mensajes de Meta (POST)
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Imprime todo el evento recibido para depurar
  console.log('📩 Evento recibido en /webhook:', JSON.stringify(body, null, 2));

  // Responder inmediatamente a Meta con 200 OK para evitar reintentos duplicados
  res.status(200).send('EVENT_RECEIVED');

  if (body.object === 'whatsapp_business_account') {
    try {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      // Verificar si hay un mensaje entrante
      if (message) {
        const from = message.from; // Número de teléfono del cliente

        // Manejar mensajes de tipo texto
        if (message.type === 'text') {
          const text = message.text.body;
          console.log(`💬 Mensaje recibido de ${from}: "${text}"`);

          // Responder automáticamente
          await sendWhatsAppMessage(
            from,
            `¡Hola! 👋 Recibimos tu mensaje: "${text}". Te enviamos la información de las dinámicas en un momento.`
          );
        } else {
          console.log(`ℹ️ Mensaje recibido de tipo '${message.type}' desde ${from}.`);
        }
      } else if (value?.statuses) {
        // Notificaciones de estado (enviado, entregado, leído)
        const status = value.statuses[0];
        console.log(`📊 Estado de mensaje ID ${status.id}: ${status.status}`);
      }
    } catch (error) {
      console.error('⚠️ Error al procesar la entrada del webhook:', error.message);
    }
  }
});

// 3. Función para enviar mensaje usando la API Oficial de Meta
async function sendWhatsAppMessage(to, text) {
  try {
    const response = await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
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

    console.log(`🚀 Mensaje enviado con éxito a ${to}. ID: ${response.data.messages[0].id}`);
  } catch (error) {
    console.error('❌ Error al enviar mensaje a WhatsApp:');
    if (error.response) {
      console.error(JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en el puerto ${PORT}`);
});
