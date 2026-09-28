const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 10000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'tu_token_de_verificacion';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Inicializar tablas incluyendo configuración y estado de leídos
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS contactos (
                numero VARCHAR(50) PRIMARY KEY,
                nombre VARCHAR(255),
                ultimo_mensaje TEXT,
                leido BOOLEAN DEFAULT FALSE,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS mensajes (
                id SERIAL PRIMARY KEY,
                numero VARCHAR(50),
                tipo_envio VARCHAR(10),
                tipo_contenido VARCHAR(20),
                contenido TEXT,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS configuracion (
                clave VARCHAR(50) PRIMARY KEY,
                valor TEXT
            );
        `);

        // Asegurar columnas si ya existían las tablas
        await pool.query(`
            ALTER TABLE contactos ADD COLUMN IF NOT EXISTS nombre VARCHAR(255);
            ALTER TABLE contactos ADD COLUMN IF NOT EXISTS ultimo_mensaje TEXT;
            ALTER TABLE contactos ADD COLUMN IF NOT EXISTS leido BOOLEAN DEFAULT FALSE;
            ALTER TABLE contactos ADD COLUMN IF NOT EXISTS fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        `);

        console.log("🟢 Conectado y tablas sincronizadas exitosamente en PostgreSQL");
    } catch (err) {
        console.error("❌ Error al conectar o inicializar PostgreSQL:", err.message);
    }
}
initDB();

// 1. Verificación del Webhook de Meta
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

// 2. Recepción de mensajes desde WhatsApp (Webhook de Meta)
app.post('/webhook', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED');

    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        body.entry?.forEach(entry => {
            entry.changes?.forEach(async change => {
                const value = change.value;
                let nombreContacto = 'Desconocido';

                if (value.contacts && value.contacts.length > 0) {
                    nombreContacto = value.contacts[0].profile?.name || 'Sin Nombre';
                }

                if (value.messages && value.messages.length > 0) {
                    const mensaje = value.messages[0];
                    const remitente = mensaje.from;
                    const tipo = mensaje.type;

                    if (remitente === PHONE_NUMBER_ID) {
                        return;
                    }

                    let contenido = '';

                    if (tipo === 'text') {
                        contenido = mensaje.text.body;
                    } else if (tipo === 'image') {
                        contenido = mensaje.image.caption || '📷 [Imagen recibida]';
                    } else if (tipo === 'audio') {
                        contenido = '🎵 [Audio recibido]';
                    } else if (tipo === 'document') {
                        contenido = mensaje.document.filename || '📄 [Documento recibido]';
                    } else {
                        contenido = `[Archivo: ${tipo}]`;
                    }

                    console.log(`📩 ENTRANTE [${tipo.toUpperCase()}] de ${nombreContacto} (${remitente}): ${contenido}`);

                    try {
                        // Verificar si el contacto ya existía antes de este mensaje
                        const contactoCheck = await pool.query('SELECT * FROM contactos WHERE numero = $1', [remitente]);
                        const esContactoNuevo = contactoCheck.rows.length === 0;

                        // Guardar o actualizar contacto (marcando leido = false para indicar mensaje nuevo pendiente)
                        await pool.query(
                            `INSERT INTO contactos (numero, nombre, ultimo_mensaje, leido, fecha) 
                             VALUES ($1, $2, $3, FALSE, NOW()) 
                             ON CONFLICT (numero) DO UPDATE SET nombre = EXCLUDED.nombre, ultimo_mensaje = EXCLUDED.ultimo_mensaje, leido = FALSE, fecha = NOW()`,
                            [remitente, nombreContacto, contenido]
                        );

                        await pool.query(
                            `INSERT INTO mensajes (numero, tipo_envio, tipo_contenido, contenido, fecha) 
                             VALUES ($1, 'entrante', $2, $3, NOW())`,
                            [remitente, tipo, contenido]
                        );

                        // DISPARAR MENSAJE DE BIENVENIDA SI ES NUEVO
                        if (esContactoNuevo) {
                            const configRes = await pool.query('SELECT valor FROM configuracion WHERE clave = $1', ['bienvenida_activa']);
                            const bienvenidaActiva = configRes.rows[0]?.valor === 'true';

                            if (bienvenidaActiva) {
                                const textoRes = await pool.query('SELECT valor FROM configuracion WHERE clave = $1', ['bienvenida_texto']);
                                const mensajeBienvenida = textoRes.rows[0]?.valor || '¡Hola! Gracias por escribirnos. ¿En qué podemos ayudarte?';

                                setTimeout(async () => {
                                    try {
                                        await enviarMensajeWhatsApp(remitente, mensajeBienvenida, 'text', null);
                                        
                                        // Registrar el mensaje de bienvenida automático en la base de datos como saliente
                                        await pool.query(
                                            `INSERT INTO mensajes (numero, tipo_envio, tipo_contenido, contenido, fecha) 
                                             VALUES ($1, 'saliente', 'text', $2, NOW())`,
                                            [remitente, mensajeBienvenida]
                                        );

                                        io.emit('nuevo_mensaje', {
                                            nombre: nombreContacto,
                                            numero: remitente,
                                            mensaje: mensajeBienvenida,
                                            tipo: 'text',
                                            tipo_envio: 'saliente',
                                            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                        });
                                        console.log(`🤖 Mensaje de bienvenida enviado automáticamente a ${remitente}`);
                                    } catch (welcomeErr) {
                                        console.error("❌ Error enviando bienvenida automática:", welcomeErr.message);
                                    }
                                }, 1500);
                            }
                        }

                    } catch (dbErr) {
                        console.error("❌ Error al guardar en DB:", dbErr.message);
                    }

                    io.emit('nuevo_mensaje', {
                        nombre: nombreContacto,
                        numero: remitente,
                        mensaje: contenido,
                        tipo: tipo,
                        tipo_envio: 'entrante',
                        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    });
                }

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

// Endpoint para guardar o actualizar la configuración de bienvenida desde el CRM
app.post('/api/configuracion', async (req, res) => {
    const { activa, texto } = req.body;
    try {
        await pool.query(
            `INSERT INTO configuracion (clave, valor) VALUES ('bienvenida_activa', $1) 
             ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
            [String(activa)]
        );
        if (texto) {
            await pool.query(
                `INSERT INTO configuracion (clave, valor) VALUES ('bienvenida_texto', $1) 
                 ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
                [texto]
            );
        }
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Error guardando configuración:", err.message);
        res.status(500).json({ error: "Error al guardar configuración" });
    }
});

// Endpoint para obtener configuración actual
app.get('/api/configuracion', async (req, res) => {
    try {
        const rows = await pool.query('SELECT * FROM configuracion');
        const config = {};
        rows.rows.forEach(r => { config[r.clave] = r.valor; });
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: "Error al obtener configuración" });
    }
});

// 3. Endpoint para obtener el historial de chats desde la DB
app.get('/api/chats', async (req, res) => {
    try {
        const contactos = await pool.query('SELECT * FROM contactos ORDER BY fecha DESC');
        const mensajes = await pool.query('SELECT * FROM mensajes ORDER BY fecha ASC');
        
        res.json({
            contactos: contactos.rows,
            mensajes: mensajes.rows
        });
    } catch (err) {
        console.error("❌ Error al obtener chats:", err.message);
        res.status(500).json({ error: "Error de servidor al cargar chats" });
    }
});

// Endpoint para marcar chat como leído (quita el indicador rojo)
app.post('/api/leer', async (req, res) => {
    const { numero } = req.body;
    try {
        await pool.query('UPDATE contactos SET leido = TRUE WHERE numero = $1', [numero]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Error al actualizar estado" });
    }
});

// 4. Endpoint para Enviar Mensajes SALIENTES desde el CRM
app.post('/api/enviar', async (req, res) => {
    const { numero, mensaje = '', tipo = 'text', mediaBase64, mimeType } = req.body;

    if (!numero) {
        return res.status(400).json({ error: 'Falta el número de destino' });
    }

    try {
        let mediaId = null;

        if (mediaBase64) {
            console.log(`📤 Subiendo archivo multimedia (${tipo}) a Meta...`);
            mediaId = await subirMediaAMeta(mediaBase64, mimeType || (tipo === 'audio' ? 'audio/ogg' : 'image/jpeg'));
        }

        const respuesta = await enviarMensajeWhatsApp(numero, mensaje, tipo, mediaId);

        const textoGuardar = tipo === 'text' ? mensaje : (tipo === 'audio' ? '🎵 [Nota de voz enviada]' : '📷 [Imagen enviada]');
        
        // Al responder, marcamos automáticamente el chat como leído para que se quite la alerta roja
        await pool.query(
            `INSERT INTO contactos (numero, nombre, ultimo_mensaje, leido, fecha) 
             VALUES ($1, $1, $2, TRUE, NOW()) 
             ON CONFLICT (numero) DO UPDATE SET ultimo_mensaje = EXCLUDED.ultimo_mensaje, leido = TRUE, fecha = NOW()`,
            [numero, textoGuardar]
        );

        await pool.query(
            `INSERT INTO mensajes (numero, tipo_envio, tipo_contenido, contenido, fecha) 
             VALUES ($1, 'saliente', $2, $3, NOW())`,
            [numero, tipo, textoGuardar]
        );

        io.emit('nuevo_mensaje', {
            nombre: numero,
            numero: numero,
            mensaje: textoGuardar,
            tipo: tipo,
            tipo_envio: 'saliente',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        res.json({ success: true, data: respuesta });
    } catch (error) {
        console.error("❌ Error en /api/enviar:", error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});

async function subirMediaAMeta(base64Data, mimeType) {
    const cleanBase64 = base64Data.replace(/^data:(.*);base64,/, '');
    const buffer = Buffer.from(cleanBase64, 'base64');

    let finalMimeType = mimeType;
    if (mimeType.includes('audio') || mimeType.includes('webm')) {
        finalMimeType = 'audio/ogg';
    }

    const form = new FormData();
    form.append('file', buffer, {
        filename: obtenerNombreArchivo(finalMimeType),
        contentType: finalMimeType
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

async function enviarMensajeWhatsApp(numeroDestino, texto, tipo, mediaId) {
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        throw new Error('Variables WHATSAPP_TOKEN o PHONE_NUMBER_ID no configuradas en Render.');
    }

    const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
    
    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: numeroDestino,
        type: mediaId ? (tipo === 'audio' ? 'audio' : 'image') : 'text'
    };

    if (mediaId) {
        if (tipo === 'audio') {
            payload.audio = { id: mediaId };
        } else if (tipo === 'image') {
            payload.image = { id: mediaId };
            if (texto) payload.image.caption = texto;
        }
    } else {
        payload.text = { preview_url: false, body: texto };
    }

    const response = await axios.post(url, payload, {
        headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });

    console.log(`🚀 Mensaje (${tipo}) enviado con éxito a ${numeroDestino}`);
    return response.data;
}

server.listen(PORT, () => {
    console.log(`🚀 Servidor CRM ejecutándose en el puerto ${PORT}`);
});
