const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
const server = http.createServer(app);

// Habilitar CORS para permitir peticiones desde Netlify
app.use(cors());
app.use(express.json());

// Configurar Socket.io con permisos CORS
const io = new Server(server, {
    cors: {
        origin: "*", // Permite conexiones desde cualquier origen (incluyendo Netlify)
        methods: ["GET", "POST"]
    }
});

// Variables de entorno
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'tu_token_de_verificacion';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// 1. Endpoint de verificación de Webhook Meta
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

// 2. Endpoint principal para recibir mensajes de WhatsApp
app.post('/webhook', async (req, res) => {
    // Confirmar recepción a Meta inmediatamente
    res.status(200).send('EVENT_RECEIVED');

    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        body.entry?.forEach(entry => {
            entry.changes?.forEach(async change => {
                const value = change.value;

                let nombreContacto = 'Desconocido';
                let waId = '';

                if (value.contacts && value.contacts.length > 0) {
                    const contacto = value.contacts[0];
                    nombreContacto = contacto.profile?.name || 'Sin Nombre';
                    waId = contacto.wa_id;
                    console.log(`👤 Contacto interactuando: ${nombreContacto} (${waId})`);
                }

                // A. Procesar mensajes entrantes
                if (value.messages && value.messages.length > 0) {
                    const mensaje = value.messages[0];
                    const remitente = mensaje.from;
                    const tipo = mensaje.type;
                    const texto = tipo === 'text' ? mensaje.text.body : '[Archivo multimedia/Otro]';

                    console.log(`📩 Mensaje recibido de ${nombreContacto} (${remitente}): "${texto}"`);

                    // Emitir evento en tiempo real por WebSockets a Netlify
                    io.emit('nuevo_mensaje', {
                        nombre: nombreContacto,
                        numero: remitente,
                        mensaje: texto,
                        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    });
                }

                // B. Procesar actualizaciones de estado (sent, delivered, read)
                if (value.statuses && value.statuses.length > 0) {
                    const estado = value.statuses[0];
                    console.log(`📊 Estado de mensaje ID ${estado.id}: ${estado.status}`);
                    
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

// 3. Endpoint para enviar mensajes desde el CRM de Netlify
app.post('/api/enviar', async (req, res) => {
    const { numero, mensaje } = req.body;

    if (!numero || !mensaje) {
        return res.status(400).json({ error: 'Faltan parámetros (numero o mensaje)' });
    }

    try {
        const respuesta = await enviarMensajeTexto(numero, mensaje);
        res.json({ success: true, data: respuesta });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 4. Función auxiliar para enviar mensajes a Meta
async function enviarMensajeTexto(numeroDestino, texto) {
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        console.error('⚠️ WHATSAPP_TOKEN o PHONE_NUMBER_ID no están configurados.');
        throw new Error('Configuración incompleta en variables de entorno');
    }

    const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to: numeroDestino,
        type: 'text',
        text: { body: texto }
    };

    const response = await axios.post(url, payload, {
        headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });

    console.log(`🚀 Mensaje enviado con éxito a ${numeroDestino}. ID: ${response.data.messages[0].id}`);
    return response.data;
}

// 5. Iniciar servidor usando el módulo HTTP en lugar de app.listen directo
server.listen(PORT, () => {
    console.log(`🚀 Servidor con Socket.IO ejecutándose en el puerto ${PORT}`);
});
