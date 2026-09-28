const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'tu_token_de_verificacion';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// 1. Verificación de Webhook Meta
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ Webhook verificado correctamente');
            return res.status(200).send(challenge);
        } else {
            return res.sendStatus(403);
        }
    }
    res.sendStatus(400);
});

// 2. Recepción de mensajes (Texto, Imagen, Audio)
app.post('/webhook', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED');

    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        body.entry?.forEach(entry => {
            entry.changes?.forEach(async change => {
                const value = change.value;
                let nombreContacto = 'Desconocido';
                let waId = '';

                if (value.contacts && value.contacts.length > 0) {
                    nombreContacto = value.contacts[0].profile?.name || 'Sin Nombre';
                    waId = value.contacts[0].wa_id;
                }

                // A. Procesar mensajes entrantes multimedia y texto
                if (value.messages && value.messages.length > 0) {
                    const mensaje = value.messages[0];
                    const remitente = mensaje.from;
                    const tipo = mensaje.type;
                    
                    let contenido = '';
                    let mediaId = null;

                    // Identificar qué tipo de mensaje llegó
                    if (tipo === 'text') {
                        contenido = mensaje.text.body;
                    } else if (tipo === 'image') {
                        contenido = mensaje.image.caption || '📷 [Imagen recibida]';
                        mediaId = mensaje.image.id;
                    } else if (tipo === 'audio') {
                        contenido = '🎵 [Audio recibido]';
                        mediaId = mensaje.audio.id;
                    } else if (tipo === 'document') {
                        contenido = mensaje.document.filename || '📄 [Documento recibido]';
                        mediaId = mensaje.document.id;
                    } else {
                        contenido = `[Archivo multimedia no soportado: ${tipo}]`;
                    }

                    console.log(`📩 [${tipo.toUpperCase()}] de ${nombreContacto}: ${contenido}`);

                    io.emit('nuevo_mensaje', {
                        nombre: nombreContacto,
                        numero: remitente,
                        mensaje: contenido,
                        tipo: tipo,
                        mediaId: mediaId, // El HTML puede usar este ID para solicitar la url del archivo luego si lo necesitas
                        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    });
                }

                // B. Actualizaciones de estado
                if (value.statuses && value.statuses.length > 0) {
                    const estado = value.statuses[0];
                    io.emit('estado_mensaje', {
                        id: estado.id,
                        status: estado.status,
                        recipient_id: estado.recipient_id
                    });
                }
            });
        });
    }
});

// 3. Endpoint para enviar desde tu HTML (Soporta URL de imagen y audio)
app.post('/api/enviar', async (req, res) => {
    // Tu HTML ahora debe enviar: numero, tipo ('text', 'image', 'audio'), urlMedia (si aplica) y mensaje (caption)
    const { numero, mensaje, tipo = 'text', urlMedia } = req.body;

    if (!numero) {
        return res.status(400).json({ error: 'Falta el número de destino' });
    }
    if (tipo !== 'text' && !urlMedia) {
        return res.status(400).json({ error: 'Para enviar multimedia se requiere una urlMedia' });
    }

    try {
        const respuesta = await enviarMensajeWhatsApp(numero, mensaje, tipo, urlMedia);
        res.json({ success: true, data: respuesta });
    } catch (error) {
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});

// 4. Función de envío dinámica a la API de Meta
async function enviarMensajeWhatsApp(numeroDestino, texto, tipo, urlMedia) {
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        throw new Error('Variables de entorno incompletas');
    }

    const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
    
    // Estructura base
    const payload = {
        messaging_product: 'whatsapp',
        to: numeroDestino,
        type: tipo
    };

    // Estructura según el tipo de archivo a enviar
    if (tipo === 'text') {
        payload.text = { body: texto };
    } else if (tipo === 'image') {
        payload.image = { link: urlMedia };
        if (texto) payload.image.caption = texto; // Texto acompañando la imagen
    } else if (tipo === 'audio') {
        payload.audio = { link: urlMedia };
    }

    const response = await axios.post(url, payload, {
        headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });

    console.log(`🚀 Mensaje (${tipo}) enviado a ${numeroDestino}`);
    return response.data;
}

server.listen(PORT, () => {
    console.log(`🚀 Servidor con soporte multimedia ejecutándose en el puerto ${PORT}`);
});
