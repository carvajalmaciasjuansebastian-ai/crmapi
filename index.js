const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Variables de entorno (asegúrate de tenerlas configuradas en Render)
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'tu_token_de_verificacion';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// 1. Endpoint de verificación para la configuración del Webhook en Meta
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ Webhook verificado correctamente');
            return res.status(200).send(challenge);
        } else {
            console.error('❌ Token de verificación inválido');
            return res.sendStatus(403);
        }
    }
    res.sendStatus(400);
});

// 2. Endpoint principal para recibir los eventos de WhatsApp
app.post('/webhook', async (req, res) => {
    // Confirmar recepción a Meta inmediatamente para evitar reintentos
    res.status(200).send('EVENT_RECEIVED');

    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        body.entry?.forEach(entry => {
            entry.changes?.forEach(async change => {
                const value = change.value;

                // Capturar datos del contacto (Nombre y WhatsApp ID)
                let nombreContacto = 'Desconocido';
                if (value.contacts && value.contacts.length > 0) {
                    const contacto = value.contacts[0];
                    nombreContacto = contacto.profile?.name || 'Sin Nombre';
                    const waId = contacto.wa_id;
                    console.log(`👤 Contacto interactuando: ${nombreContacto} (${waId})`);
                }

                // A. Procesar mensajes entrantes enviados por los clientes
                if (value.messages && value.messages.length > 0) {
                    const mensaje = value.messages[0];
                    const remitente = mensaje.from; // Número de teléfono del remitente
                    const idMensaje = mensaje.id;
                    const tipo = mensaje.type;

                    console.log(`📩 Mensaje recibido de ${nombreContacto} (${remitente}):`);

                    if (tipo === 'text') {
                        const texto = mensaje.text.body;
                        console.log(`   💬 Contenido: "${texto}"`);

                        // Ejemplo de respuesta automática
                        /*
                        await enviarMensajeTexto(
                            remitente,
                            `¡Hola ${nombreContacto}! He recibido tu mensaje: "${texto}"`
                        );
                        */
                    } else {
                        console.log(`   📎 Tipo de mensaje no estructurado como texto: ${tipo}`);
                    }
                }

                // B. Procesar actualizaciones de estado de mensajes (sent, delivered, read)
                if (value.statuses && value.statuses.length > 0) {
                    const estado = value.statuses[0];
                    console.log(`📊 Estado de mensaje ID ${estado.id}: ${estado.status} (Destinatario: ${estado.recipient_id})`);
                }
            });
        });
    }
});

// 3. Función auxiliar para enviar mensajes a través de la API Cloud de Meta
async function enviarMensajeTexto(numeroDestino, texto) {
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        console.error('⚠️ WHATSAPP_TOKEN o PHONE_NUMBER_ID no están configurados.');
        return;
    }

    try {
        const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
        const payload = {
            messaging_product: 'whatsapp',
            to: numeroDestino,
            type: 'text',
            text: {
                body: texto
            }
        };

        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`🚀 Mensaje enviado con éxito a ${numeroDestino}. ID: ${response.data.messages[0].id}`);
    } catch (error) {
        console.error('❌ Error al enviar mensaje:', error.response?.data || error.message);
    }
}

// 4. Iniciar el servidor Express
app.listen(PORT, () => {
    console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});
