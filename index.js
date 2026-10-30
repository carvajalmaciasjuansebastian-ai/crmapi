const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Pool } = require('pg');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs');
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

let sock;
let qrCodeGlobal = '';
let connectionStatus = 'disconnected';

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

async function startWhatsApp() {
    // Limpiamos sesión previa corrupta para forzar un QR limpio
    if (connectionStatus === 'disconnected' && fs.existsSync('auth_info_baileys')) {
        try {
            // Comenta la siguiente línea si quieres mantener la sesión guardada al reiniciar
            // fs.rmSync('auth_info_baileys', { recursive: true, force: true });
        } catch (e) {}
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        logger: P({ level: 'silent' }),
        printQRInTerminal: false // Lo manejamos por Web/Socket
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeGlobal = qr;
            connectionStatus = 'qr';
            console.log('📌 NUEVO QR GENERADO. Abre tu CRM para escanearlo.');
        }

        if (connection === 'close') {
            connectionStatus = 'disconnected';
            qrCodeGlobal = '';
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`🔄 Conexión cerrada (Código: ${statusCode}). Reconectando en 5 segundos...`);

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('⚠️ Sesión cerrada. Limpiando credenciales...');
                try {
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                } catch (e) {}
            }

            if (shouldReconnect) {
                setTimeout(startWhatsApp, 5000);
            }
        } else if (connection === 'open') {
            connectionStatus = 'connected';
            qrCodeGlobal = '';
            console.log('✅ ¡WhatsApp conectado exitosamente mediante Baileys!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        
        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const remitente = msg.key.remoteJid;
            const numeroLimpio = remitente.replace(/\D/g, '');
            const textoMensaje = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const nombreContacto = msg.pushName || 'Aventurero';

            console.log(`📩 Mensaje entrante de ${nombreContacto} (${numeroLimpio}): ${textoMensaje}`);

            try {
                let contactoRes = await pool.query('SELECT * FROM contactos WHERE numero = $1', [numeroLimpio]);
                let faseActual = 0;

                if (contactoRes.rows.length === 0) {
                    await pool.query(
                        `INSERT INTO contactos (numero, nombre, ultimo_mensaje, leido, fase_bot, fecha) VALUES ($1, $2, $3, FALSE, 0, NOW())`,
                        [numeroLimpio, nombreContacto, textoMensaje]
                    );
                } else {
                    faseActual = contactoRes.rows[0].fase_bot || 0;
                    await pool.query(
                        `UPDATE contactos SET ultimo_mensaje = $1, leido = FALSE, fecha = NOW() WHERE numero = $2`,
                        [textoMensaje, numeroLimpio]
                    );
                }

                await pool.query(
                    `INSERT INTO mensajes (numero, tipo_envio, tipo_contenido, contenido, fecha) VALUES ($1, 'entrante', 'text', $2, NOW())`,
                    [numeroLimpio, textoMensaje]
                );

                io.emit('nuevo_mensaje', {
                    nombre: nombreContacto,
                    numero: numeroLimpio,
                    mensaje: textoMensaje,
                    tipo: 'text',
                    tipo_envio: 'entrante',
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                });

                const delayHumano = Math.floor(Math.random() * (8000 - 4000 + 1)) + 4000;

                if (faseActual === 0) {
                    const saludos = [
                        `¡Hola! 👋 Qué gusto saludarte. Para darte la mejor atención, ¿me regalarías tu nombre por favor?`,
                        `¡Hola! Bienvenido. 📲 Cuéntame, ¿cómo te llamas para tenerte presente?`,
                        `¡Hola! Qué bueno tenerte por aquí. ¿Cuál es tu nombre?`
                    ];
                    const saludoElegido = saludos[Math.floor(Math.random() * saludos.length)];

                    setTimeout(async () => {
                        await sock.sendMessage(remitente, { text: saludoElegido });
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
                        await sock.sendMessage(remitente, { text: mensajeReglas });
                        
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

            } catch (dbErr) {
                console.error('❌ Error procesando mensaje:', dbErr.message);
            }
        }
    });
}

startWhatsApp();

app.get('/api/status', (req, res) => {
    res.json({ status: connectionStatus, qr: qrCodeGlobal });
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
        const jid = `${numero}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: mensaje });

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
    console.log(`🚀 Servidor CRM con Baileys corriendo en el puerto ${PORT}`);
});
