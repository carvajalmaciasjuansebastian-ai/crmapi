const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const server = http.createServer(app);

// Aumentar el límite del body para recibir imágenes y audios en Base64 desde el CRM
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));

// Configurar Socket.io
const io = new Server(server, {
    cors: {
        origin: "*", 
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

// 2. Endpoint principal para recibir mensajes de WhatsApp (Entrantes)
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
                    const contacto = value.contacts[0];
                    nombreContacto = contacto.profile?.name || 'Sin Nombre';
                    waId = contacto.wa_id;
                    console.log(`👤 Contacto interactuando: ${nombreContacto} (${waId})`);
                }

                // A. Procesar mensajes entrantes (Texto, Imagen, Audio, Documentos)
                if (value.messages && value.messages.length > 0) {
                    const mensaje = value.messages[0];
                    const remitente = mensaje.from;
                    const tipo = mensaje.type;
                    
                    let contenido = '';
                    let mediaId = null;

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

                    console.log(`📩 [${tipo.toUpperCase()}] de ${nombreContacto} (${remitente}): "${contenido}"`);

                    // Emitir evento por WebSockets al CRM de Netlify
                    io.emit('nuevo_mensaje', {
                        nombre: nombreContacto,
                        numero: remitente,
                        mensaje: contenido,
                        tipo: tipo,
                        mediaId: mediaId,
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

// 3. Endpoint Unificado para Enviar Mensajes, Audios e Imágenes desde el CRM
app.post('/api/enviar', async (req, res) => {
    const { numero, mensaje, tipo = 'text', mediaBase64, mimeType } = req.body;

    if (!numero) {
        return res.status(400).json({ error: 'Falta el número de destino' });
    }

    try {
        let mediaId = null;

        // Si incluye un archivo multimedia en Base64 (Audio o Imagen), se sube a Meta primero
        if (mediaBase64) {
            console.log(`📤 Subiendo archivo multimedia (${tipo}) a servidores de Meta...`);
            mediaId = await subirMediaAMeta(mediaBase64, mimeType || (tipo === 'audio' ? 'audio/ogg' : 'image/jpeg'));
        }

        const respuesta = await enviarMensajeWhatsApp(numero, mensaje, tipo, mediaId);
        res.json({ success: true, data: respuesta });
    } catch (error) {
        console.error("❌ Error en /api/enviar:", error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});

// Función para subir archivos multimedia a los servidores de Meta y obtener un mediaId
async function subirMediaAMeta(base64Data, mimeType) {
    const cleanBase64 = base64Data.replace(/^data:(.*);base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');

    const form = new FormData();
    form.append('file', buffer, {
        filename: obtenerNombreArchivo(mimeType),
        contentType: mimeType
    });
    form.append('messaging_product', 'whatsapp');

    const response = await axios.post(
        `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`,
        form,
        {
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`
            }
        }
    );

    return response.data.id;
}

function obtenerNombreArchivo(mimeType) {
    if (mimeType.includes('audio')) return 'nota_de_voz.ogg';
    if (mimeType.includes('png')) return 'imagen.png';
    return 'imagen.jpg';
}

// Función auxiliar para construir el payload final hacia la API Graph de Meta
async function enviarMensajeWhatsApp(numeroDestino, texto, tipo, mediaId) {
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        console.error('⚠️ WHATSAPP_TOKEN o PHONE_NUMBER_ID no están configurados.');
        throw new Error('Configuración incompleta en variables de entorno');
    }

    const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
    
    const payload = {
        messaging_product: 'whatsapp',
        to: numeroDestino,
        type: mediaId ? tipo : 'text'
    };

    if (mediaId) {
        if (tipo === 'audio') {
            payload.audio = { id: mediaId };
        } else if (tipo === 'image') {
            payload.image = { id: mediaId };
            if (texto) payload.image.caption = texto;
        }
    } else {
        payload.text = { body: texto };
    }

    const response = await axios.post(url, payload, {
        headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });

    console.log(`🚀 Mensaje (${tipo}) enviado con éxito a ${numeroDestino}. ID: ${response.data.messages[0].id}`);
    return response.data;
}

// 4. Iniciar servidor HTTP con WebSockets
server.listen(PORT, () => {
    console.log(`🚀 Servidor CRM ejecutándose en el puerto ${PORT}`);
});
