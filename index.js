const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
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

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Credenciales de Meta Cloud API (las configuras en las variables de entorno de Render)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS contactos (
                numero VARCHAR(50) PRIMARY KEY,
                nombre VARCHAR(255),
                ultimo_mensaje TEXT,
                leido BOOLEAN DEFAULT FALSE,
                fase_bot INT DEFAULT 0,
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
        `);
        console.log('🟢 Base de datos sincronizada con éxito.');
    } catch (err) {
        console.error('❌ Error al inicializar DB:', err.message);
    }
}
initDB();

// Función auxiliar para enviar mensajes usando la Cloud API oficial de Meta
async function enviarMensajeMeta(destinatario, texto) {
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: destinatario,
                type: "text",
                text: { body: texto }
            },
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (err) {
        console.error('❌ Error enviando mensaje por Meta Cloud API:', err.response?.data || err.message);
    }
}

// 1. Ruta GET para que Meta valide el Webhook
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
            console.log('✅ WEBHOOK_VERIFIED con éxito por Meta.');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

// 2. Ruta POST para recibir los mensajes entrantes de Meta
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        try {
            for (const entry of body.entry) {
                for (const change of entry.changes) {
                    if (change.value && change.value.messages) {
                        const msgObj = change.value.messages[0];
                        const numeroLimpio = msgObj.from; // Número del cliente
                        const textoMensaje = msgObj.text?.body || '';
                        
                        // Obtener nombre del contacto si viene en la metadata de Meta
                        let nombreContacto = change.value.contacts?.[0]?.profile?.name || 'Aventurero';

                        console.log(`📩 Mensaje entrante Cloud API de ${nombreContacto} (${numeroLimpio}): ${textoMensaje}`);

                        let contactoRes = await pool.query('SELECT * FROM contactos WHERE numero = $1', [numeroLimpio]);
                        let faseActual = 0;

                        if (contactoRes.rows.length === 0) {
                            await pool.query(
                                `INSERT INTO contactos (numero, nombre, ultimo_mensaje, leido, fase_bot, fecha) VALUES ($1, $2, $3, FALSE, 0, NOW())`,
                                [numeroLimpio, nombreContacto, textoMensaje]
                            );
                        } else {
                            faseActual = contactoRes.rows[0].fase_bot || 0;
                            // Si ya tenía nombre guardado, lo respetamos, si no, actualizamos
                            if (contactoRes.rows[0].nombre) {
                                nombreContacto = contactoRes.rows[0].nombre;
                            }
                            await pool.query(
                                `UPDATE contactos SET ultimo_mensaje = $1, leido = FALSE, fecha = NOW() WHERE numero = $2`,
                                [textoMensaje, numeroLimpio]
                            );
                        }

                        // Guardar mensaje entrante
                        await pool.query(
                            `INSERT INTO mensajes (numero, tipo_envio, tipo_contenido, contenido, fecha) VALUES ($1, 'entrante', 'text', $2, NOW())`,
                            [numeroLimpio, textoMensaje]
                        );

                        // Emitir al CRM web en tiempo real
                        io.emit('nuevo_mensaje', {
                            nombre: nombreContacto,
                            numero: numeroLimpio,
                            mensaje: textoMensaje,
                            tipo: 'text',
                            tipo_envio: 'entrante',
                            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                        });

                        const delayHumano = Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000;

                        // Lógica del bot (Fase 0 y Fase 1)
                        if (faseActual === 0) {
                            const saludos = [
                                `¡Hola! 👋 Qué gusto saludarte. Para darte la mejor atención, ¿me regalarías tu nombre por favor?`,
                                `¡Hola! Bienvenido. 📲 Cuéntame, ¿cómo te llamas para tenerte presente?`,
                                `¡Hola! Qué bueno tenerte por aquí. ¿Cuál es tu nombre?`
                            ];
                            const saludoElegido = saludos[Math.floor(Math.random() * saludos.length)];

                            setTimeout(async () => {
                                await enviarMensajeMeta(numeroLimpio, saludoElegido);
                                await pool.query('UPDATE contactos SET fase_bot = 1 WHERE numero = $1', [numeroLimpio]);
                                
                                await pool.query(
                                    `INSERT INTO mensajes (numero, tipo_envio, tipo_contenido, contenido, fecha) VALUES ($1, 'saliente', 'text', $2, NOW())`,
                                    [numeroLimpio, saludoElegido]
                                );
                                io.emit('nuevo_mensaje', {
                                    nombre: nombreContacto,
                                    numero: numeroLimpio,
                                    mensaje: saludoElegido,
                                    tipo: 'text',
                                    tipo_envio: 'saliente',
                                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                });
                            }, delayHumano);

                        } else if (faseActual === 1) {
                            const nombreUsuario = textoMensaje.trim();
                            await pool.query('UPDATE contactos SET nombre = $1, fase_bot = 2 WHERE numero = $2', [nombreUsuario, numeroLimpio]);

                            const mensajeReglas = `¡Mucho gusto, ${nombreUsuario}! 🎉 Te explico brevemente cómo funcionamos:

1️⃣ Con un número de **dos cifras** tienes **hasta 3 oportunidades** de participar y ganar.
2️⃣ **Garantía Total:** Si tu número coincide con el último dígito, ¡te devolvemos tu dinero y recuperas tu ticket!
3️⃣ Toda la información de las dinámicas, elección de números y ganadores se comparte exclusivamente en nuestro grupo oficial.

🔗 Únete al grupo de WhatsApp aquí mismo para comenzar:
https://chat.whatsapp.com/CF7FdHHK7NyHQrtI0AUbIv

¡Te esperamos adentro! 🚀`;

                            setTimeout(async () => {
                                await enviarMensajeMeta(numeroLimpio, mensajeReglas);
                                
                                await pool.query(
                                    `INSERT INTO mensajes (numero, tipo_envio, tipo_contenido, contenido, fecha) VALUES ($1, 'saliente', 'text', $2, NOW())`,
                                    [numeroLimpio, mensajeReglas]
                                );
                                io.emit('nuevo_mensaje', {
                                    nombre: nombreUsuario,
                                    numero: numeroLimpio,
                                    mensaje: mensajeReglas,
                                    tipo: 'text',
                                    tipo_envio: 'saliente',
                                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                });
                            }, delayHumano);
                        }
                    }
                }
            }
            res.sendStatus(200);
        } catch (err) {
            console.error('❌ Error procesando webhook de Meta:', err.message);
            res.sendStatus(500);
        }
    } else {
        res.sendStatus(404);
    }
});

app.get('/api/status', (req, res) => {
    // Como es Cloud API, el estado operativo depende de que el token y webhook estén activos
    res.json({ status: 'connected', qr: '' });
});

app.get('/api/chats', async (req, res) => {
    try {
        const contactos = await pool.query('SELECT * FROM contactos ORDER BY fecha DESC');
        const mensajes = await pool.query('SELECT * FROM mensajes ORDER BY fecha ASC');
        res.json({ contactos: contactos.rows, mensajes: mensajes.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/enviar', async (req, res) => {
    const { numero, mensaje } = req.body;
    if (!numero || !mensaje) return res.status(400).json({ success: false, error: 'Faltan datos' });

    try {
        await enviarMensajeMeta(numero, mensaje);

        await pool.query(
            `INSERT INTO mensajes (numero, tipo_envio, tipo_contenido, contenido, fecha) VALUES ($1, 'saliente', 'text', $2, NOW())`,
            [numero, mensaje]
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor CRM Cloud API corriendo en el puerto ${PORT}`);
});
