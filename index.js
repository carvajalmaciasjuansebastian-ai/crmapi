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

            ALTER TABLE contactos ADD COLUMN IF NOT EXISTS fase_bot INT DEFAULT 0;

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
        console.log('🟢 Base de datos sincronizada y actualizada con éxito.');
    } catch (err) {
        console.error('❌ Error al inicializar DB:', err.message);
    }
}
initDB();

async function enviarMensajeMeta(destinatario, texto) {
    try {
        await axios.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: destinatario,
                type: "text",
                text: { 
                    body: texto,
                    preview_url: true // Activa la vista previa de forma nativa permitida por Meta
                }
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

app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
        try {
            for (const entry of body.entry) {
                for (const change of entry.changes) {
                    if (change.value && change.value.messages) {
                        const msgObj = change.value.messages[0];
                        const numeroLimpio = msgObj.from;
                        const textoMensaje = msgObj.text?.body || '';
                        
                        if (numeroLimpio === PHONE_NUMBER_ID || numeroLimpio === "573042187204") {
                            continue;
                        }

                        let nombreContacto = change.value.contacts?.[0]?.profile?.name || 'Aventurero';

                        console.log(`📩 Mensaje entrante Cloud API de ${nombreContacto} (${numeroLimpio}): ${textoMensaje}`);

                        let contactoRes = await pool.query('SELECT * FROM contactos WHERE numero = $1', [numeroLimpio]);
                        let faseActual = 0;

                        if (contactoRes.rows.length === 0) {
                            await pool.query(
                                `INSERT INTO contactos (numero, nombre, ultimo_mensaje, leido, fase_bot, fecha) VALUES ($1, $2, $3, FALSE, 0, NOW())`,
                                [numeroLimpio, nombreContacto, textoMensaje]
                            );
                            faseActual = 0;
                        } else {
                            faseActual = contactoRes.rows[0].fase_bot !== null ? Number(contactoRes.rows[0].fase_bot) : 0;
                            if (contactoRes.rows[0].nombre && contactoRes.rows[0].nombre !== 'Aventurero') {
                                nombreContacto = contactoRes.rows[0].nombre;
                            }
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

                        if (faseActual === 0) {
                            const configRes = await pool.query('SELECT * FROM configuracion');
                            let bienvenidaActiva = false;
                            let bienvenidaTexto = '';

                            configRes.rows.forEach(row => {
                                if (row.clave === 'bienvenida_activa') bienvenidaActiva = (row.valor === 'true');
                                if (row.clave === 'bienvenida_texto') bienvenidaTexto = row.valor;
                            });

                            if (bienvenidaActiva && bienvenidaTexto.trim() !== '') {
                                await pool.query('UPDATE contactos SET fase_bot = 1 WHERE numero = $1', [numeroLimpio]);

                                setTimeout(async () => {
                                    await enviarMensajeMeta(numeroLimpio, bienvenidaTexto);
                                    
                                    await pool.query(
                                        `INSERT INTO mensajes (numero, tipo_envio, tipo_contenido, contenido, fecha) VALUES ($1, 'saliente', 'text', $2, NOW())`,
                                        [numeroLimpio, bienvenidaTexto]
                                    );
                                    io.emit('nuevo_mensaje', {
                                        nombre: nombreContacto,
                                        numero: numeroLimpio,
                                        mensaje: bienvenidaTexto,
                                        tipo: 'text',
                                        tipo_envio: 'saliente',
                                        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                    });
                                }, 1000);
                            }
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

app.get('/api/configuracion', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM configuracion');
        const config = {};
        result.rows.forEach(row => {
            config[row.clave] = row.valor;
        });
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/configuracion', async (req, res) => {
    const { activa, texto } = req.body;
    try {
        await pool.query(
            `INSERT INTO configuracion (clave, valor) VALUES ('bienvenida_activa', $1)
             ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
            [String(activa)]
        );
        await pool.query(
            `INSERT INTO configuracion (clave, valor) VALUES ('bienvenida_texto', $1)
             ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
            [texto || '']
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/leer', async (req, res) => {
    const { numero } = req.body;
    if (!numero) return res.status(400).json({ error: 'Falta número' });
    try {
        await pool.query('UPDATE contactos SET leido = TRUE WHERE numero = $1', [numero]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/status', (req, res) => {
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

        await pool.query(
            `UPDATE contactos SET ultimo_mensaje = $1, leido = TRUE, fecha = NOW() WHERE numero = $2`,
            [mensaje, numero]
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor CRM Cloud API corriendo en el puerto ${PORT}`);
});
