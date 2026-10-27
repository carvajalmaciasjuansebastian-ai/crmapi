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

// Configuración de la plantilla aprobada en Meta (con el flyer oficial de El Duende de las Dos Cifras)
const TEMPLATE_NAME =
    process.env.WHATSAPP_TEMPLATE_NAME || 'notificacion_dinamica';

const TEMPLATE_LANGUAGE =
    process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'es_CO';

const TEMPLATE_HEADER_IMAGE_URL =
    process.env.WHATSAPP_TEMPLATE_IMAGE_URL ||
    'https://i.ibb.co/sjd0RWv7/El-Duende-de-las-Dos-Cifras.png';

// Normalizar el teléfono a formato internacional solo con dígitos.
function normalizarNumeroWhatsApp(numero) {
    return String(numero || '').replace(/\D/g, '');
}

function validarConfiguracionWhatsApp() {
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
        throw new Error(
            'Faltan WHATSAPP_TOKEN o PHONE_NUMBER_ID en las variables de entorno de Render.'
        );
    }
}

// Construye el payload de la plantilla.
function crearPayloadPlantilla(numero, nombre) {
    return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizarNumeroWhatsApp(numero),
        type: 'template',
        template: {
            name: TEMPLATE_NAME,
            language: {
                code: TEMPLATE_LANGUAGE
            },
            components: [
                {
                    type: 'header',
                    parameters: [
                        {
                            type: 'image',
                            image: {
                                link: TEMPLATE_HEADER_IMAGE_URL
                            }
                        }
                    ]
                },
                {
                    type: 'body',
                    parameters: [
                        {
                            type: 'text',
                            text: String(
                                nombre || 'Aventurero de la suerte'
                            ).trim()
                        }
                    ]
                }
            ]
        }
    };
}

// Envío de una plantilla a un único destinatario.
async function enviarPlantillaWhatsApp(numero, nombre) {
    validarConfiguracionWhatsApp();

    const destinatario = normalizarNumeroWhatsApp(numero);

    if (!/^\d{10,15}$/.test(destinatario)) {
        throw new Error(
            `Número inválido: ${numero}. Usa el formato internacional sin + ni espacios, por ejemplo 573001234567.`
        );
    }

    const url =
        `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

    const payload = crearPayloadPlantilla(destinatario, nombre);

    const response = await axios.post(url, payload, {
        headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });

    const messageId = response.data?.messages?.[0]?.id || null;

    console.log(
        '✅ META ACEPTÓ PLANTILLA:',
        JSON.stringify({
            destinatario,
            plantilla: TEMPLATE_NAME,
            messageId,
            respuesta: response.data
        })
    );

    return {
        response: response.data,
        messageId,
        recipient: destinatario
    };
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});

// Inicialización de las tablas de PostgreSQL.
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

        await pool.query(`
            ALTER TABLE contactos
                ADD COLUMN IF NOT EXISTS nombre VARCHAR(255);

            ALTER TABLE contactos
                ADD COLUMN IF NOT EXISTS ultimo_mensaje TEXT;

            ALTER TABLE contactos
                ADD COLUMN IF NOT EXISTS leido BOOLEAN DEFAULT FALSE;

            ALTER TABLE contactos
                ADD COLUMN IF NOT EXISTS fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        `);

        console.log(
            '🟢 Conectado y tablas sincronizadas exitosamente en PostgreSQL'
        );
    } catch (err) {
        console.error(
            '❌ Error al conectar o inicializar PostgreSQL:',
            err.message
        );
    }
}

initDB();

// 1. Verificación del webhook de Meta.
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ Webhook verificado correctamente');
            return res.status(200).send(challenge);
        }

        return res.sendStatus(403);
    }

    res.sendStatus(400);
});

// 2. Recepción de mensajes entrantes y estados de entrega.
app.post('/webhook', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED');

    const body = req.body;

    if (body.object !== 'whatsapp_business_account') {
        return;
    }

    body.entry?.forEach(entry => {
        entry.changes?.forEach(async change => {
            const value = change.value;

            if (!value) return;

            let nombreContacto = 'Desconocido';

            if (value.contacts && value.contacts.length > 0) {
                nombreContacto =
                    value.contacts[0].profile?.name || 'Sin Nombre';
            }

            if (value.messages && value.messages.length > 0) {
                for (const mensaje of value.messages) {
                    const remitente = mensaje.from;
                    const tipo = mensaje.type;

                    let contenido = '';

                    if (tipo === 'text') {
                        contenido = mensaje.text?.body || '';
                    } else if (tipo === 'image') {
                        contenido =
                            mensaje.image?.caption || '📷 [Imagen recibida]';
                    } else if (tipo === 'audio') {
                        contenido = '🎵 [Audio recibido]';
                    } else if (tipo === 'document') {
                        contenido =
                            mensaje.document?.filename ||
                            '📄 [Documento recibido]';
                    } else {
                        contenido = `[Archivo: ${tipo}]`;
                    }

                    console.log(
                        `📩 ENTRANTE [${String(tipo).toUpperCase()}] de ${nombreContacto} (${remitente}): ${contenido}`
                    );

                    try {
                        const contactoCheck = await pool.query(
                            'SELECT * FROM contactos WHERE numero = $1',
                            [remitente]
                        );

                        const esContactoNuevo =
                            contactoCheck.rows.length === 0;

                        await pool.query(
                            `INSERT INTO contactos
                                (numero, nombre, ultimo_mensaje, leido, fecha)
                             VALUES ($1, $2, $3, FALSE, NOW())
                             ON CONFLICT (numero) DO UPDATE SET
                                nombre = EXCLUDED.nombre,
                                ultimo_mensaje = EXCLUDED.ultimo_mensaje,
                                leido = FALSE,
                                fecha = NOW()`,
                            [remitente, nombreContacto, contenido]
                        );

                        await pool.query(
                            `INSERT INTO mensajes
                                (numero, tipo_envio, tipo_contenido, contenido, fecha)
                             VALUES ($1, 'entrante', $2, $3, NOW())`,
                            [remitente, tipo, contenido]
                        );

                        if (esContactoNuevo) {
                            const configRes = await pool.query(
                                'SELECT valor FROM configuracion WHERE clave = $1',
                                ['bienvenida_activa']
                            );

                            const bienvenidaActiva =
                                configRes.rows[0]?.valor === 'true';

                            if (bienvenidaActiva) {
                                const textoRes = await pool.query(
                                    'SELECT valor FROM configuracion WHERE clave = $1',
                                    ['bienvenida_texto']
                                );

                                const mensajeBienvenida =
                                    textoRes.rows[0]?.valor ||
                                    '¡Hola! Gracias por escribirnos. ¿En qué podemos ayudarte?';

                                setTimeout(async () => {
                                    try {
                                        const respuesta =
                                            await enviarMensajeWhatsApp(
                                                remitente,
                                                mensajeBienvenida,
                                                'text',
                                                null
                                            );

                                        await pool.query(
                                            `INSERT INTO mensajes
                                                (numero, tipo_envio, tipo_contenido, contenido, fecha)
                                             VALUES ($1, 'saliente', 'text', $2, NOW())`,
                                            [remitente, mensajeBienvenida]
                                        );

                                        io.emit('nuevo_mensaje', {
                                            nombre: nombreContacto,
                                            numero: remitente,
                                            mensaje: mensajeBienvenida,
                                            tipo: 'text',
                                            tipo_envio: 'saliente',
                                            messageId:
                                                respuesta.messages?.[0]?.id || null,
                                            timestamp: new Date().toLocaleTimeString(
                                                [],
                                                {
                                                    hour: '2-digit',
                                                    minute: '2-digit'
                                                }
                                            )
                                        });

                                        console.log(
                                            `🤖 Mensaje de bienvenida aceptado por Meta para ${remitente}`
                                        );
                                    } catch (welcomeErr) {
                                        console.error(
                                            '❌ Error enviando bienvenida automática:',
                                            welcomeErr.response?.data ||
                                            welcomeErr.message
                                        );
                                    }
                                }, 1500);
                            }
                        }
                    } catch (dbErr) {
                        console.error(
                            '❌ Error al guardar mensaje entrante en DB:',
                            dbErr.message
                        );
                    }

                    io.emit('nuevo_mensaje', {
                        nombre: nombreContacto,
                        numero: remitente,
                        mensaje: contenido,
                        tipo,
                        tipo_envio: 'entrante',
                        timestamp: new Date().toLocaleTimeString(
                            [],
                            {
                                hour: '2-digit',
                                minute: '2-digit'
                            }
                        )
                    });
                }
            }

            if (value.statuses && value.statuses.length > 0) {
                for (const estado of value.statuses) {
                    const detalleEstado = {
                        id: estado.id,
                        destinatario: estado.recipient_id,
                        estado: estado.status,
                        errores: estado.errors || [],
                        timestamp: estado.timestamp || null
                    };

                    console.log(
                        '📩 ESTADO WHATSAPP:',
                        JSON.stringify(detalleEstado)
                    );

                    io.emit('estado_mensaje', {
                        id: estado.id,
                        status: estado.status,
                        recipient_id: estado.recipient_id,
                        errors: estado.errors || [],
                        timestamp: estado.timestamp || null
                    });
                }
            }
        });
    });
});

// Endpoint para guardar o actualizar la configuración de bienvenida.
app.post('/api/configuracion', async (req, res) => {
    const { activa, texto } = req.body;

    try {
        await pool.query(
            `INSERT INTO configuracion (clave, valor)
             VALUES ('bienvenida_activa', $1)
             ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
            [String(activa)]
        );

        if (texto) {
            await pool.query(
                `INSERT INTO configuracion (clave, valor)
                 VALUES ('bienvenida_texto', $1)
                 ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
                [texto]
            );
        }

        res.json({ success: true });
    } catch (err) {
        console.error(
            '❌ Error guardando configuración:',
            err.message
        );
        res.status(500).json({
            success: false,
            error: 'Error al guardar configuración'
        });
    }
});

// Endpoint para obtener la configuración actual.
app.get('/api/configuracion', async (req, res) => {
    try {
        const rows = await pool.query('SELECT * FROM configuracion');
        const config = {};

        rows.rows.forEach(r => {
            config[r.clave] = r.valor;
        });

        res.json(config);
    } catch (err) {
        console.error(
            '❌ Error al obtener configuración:',
            err.message
        );
        res.status(500).json({
            success: false,
            error: 'Error al obtener configuración'
        });
    }
});

// 3. Obtener el historial de chats desde la base de datos.
app.get('/api/chats', async (req, res) => {
    try {
        const contactos = await pool.query(
            'SELECT * FROM contactos ORDER BY fecha DESC'
        );

        const mensajes = await pool.query(
            'SELECT * FROM mensajes ORDER BY fecha ASC'
        );

        res.json({
            contactos: contactos.rows,
            mensajes: mensajes.rows
        });
    } catch (err) {
        console.error(
            '❌ Error al obtener chats:',
            err.message
        );
        res.status(500).json({
            success: false,
            error: 'Error de servidor al cargar chats'
        });
    }
});

// Marcar un chat como leído.
app.post('/api/leer', async (req, res) => {
    const { numero } = req.body;

    if (!numero) {
        return res.status(400).json({
            success: false,
            error: 'Falta el número del contacto'
        });
    }

    try {
        await pool.query(
            'UPDATE contactos SET leido = TRUE WHERE numero = $1',
            [numero]
        );

        res.json({ success: true });
    } catch (err) {
        console.error(
            '❌ Error al actualizar estado de lectura:',
            err.message
        );
        res.status(500).json({
            success: false,
            error: 'Error al actualizar estado'
        });
    }
});

// 4. Enviar mensajes salientes de texto, imagen o audio.
app.post('/api/enviar', async (req, res) => {
    const {
        numero,
        mensaje = '',
        tipo = 'text',
        mediaBase64,
        mimeType
    } = req.body;

    if (!numero) {
        return res.status(400).json({
            success: false,
            error: 'Falta el número de destino'
        });
    }

    try {
        let mediaId = null;

        if (mediaBase64) {
            console.log(
                `📤 Subiendo archivo multimedia (${tipo}) a Meta...`
            );

            mediaId = await subirMediaAMeta(
                mediaBase64,
                mimeType ||
                (tipo === 'audio' ? 'audio/ogg' : 'image/jpeg')
            );
        }

        const respuesta = await enviarMensajeWhatsApp(
            numero,
            mensaje,
            tipo,
            mediaId
        );

        const textoGuardar =
            tipo === 'text'
                ? mensaje
                : tipo === 'audio'
                    ? '🎵 [Nota de voz enviada]'
                    : '📷 [Imagen enviada]';

        await pool.query(
            `INSERT INTO contactos
                (numero, nombre, ultimo_mensaje, leido, fecha)
             VALUES ($1, $1, $2, TRUE, NOW())
             ON CONFLICT (numero) DO UPDATE SET
                ultimo_mensaje = EXCLUDED.ultimo_mensaje,
                leido = TRUE,
                fecha = NOW()`,
            [numero, textoGuardar]
        );

        await pool.query(
            `INSERT INTO mensajes
                (numero, tipo_envio, tipo_contenido, contenido, fecha)
             VALUES ($1, 'saliente', $2, $3, NOW())`,
            [numero, tipo, textoGuardar]
        );

        io.emit('nuevo_mensaje', {
            nombre: numero,
            numero,
            mensaje: textoGuardar,
            tipo,
            tipo_envio: 'saliente',
            messageId: respuesta.messages?.[0]?.id || null,
            timestamp: new Date().toLocaleTimeString(
                [],
                {
                    hour: '2-digit',
                    minute: '2-digit'
                }
            )
        });

        res.json({
            success: true,
            data: respuesta,
            message: 'Meta aceptó la solicitud de envío.'
        });
    } catch (error) {
        const detalle = error.response?.data || error.message;

        console.error(
            '❌ Error en /api/enviar:',
            JSON.stringify(detalle)
        );

        res.status(error.response?.status || 500).json({
            success: false,
            error: detalle
        });
    }
});

// 5. Prueba individual de la plantilla aprobada.
app.post('/api/probar-plantilla-unica', async (req, res) => {
    const numero = normalizarNumeroWhatsApp(req.body?.numero);

    if (!numero) {
        return res.status(400).json({
            success: false,
            error: 'Falta el número de destino.'
        });
    }

    try {
        const resultado = await enviarPlantillaWhatsApp(
            numero,
            'Aventurero de la suerte'
        );

        return res.json({
            success: true,
            accepted: true,
            messageId: resultado.messageId,
            recipient: resultado.recipient,
            data: resultado.response,
            message:
                'Meta aceptó la solicitud. Consulta el webhook para confirmar sent, delivered o failed.'
        });
    } catch (err) {
        const detalle = err.response?.data || err.message;

        console.error(
            '❌ ERROR PRUEBA PLANTILLA:',
            JSON.stringify({
                numero,
                error: detalle
            })
        );

        return res.status(err.response?.status || 500).json({
            success: false,
            error: detalle
        });
    }
});

// 6. Difusión masiva con la plantilla aprobada.
app.post('/api/masivo-plantilla', async (req, res) => {
    const nombrePlantillaSolicitado = String(
        req.body?.nombrePlantilla || TEMPLATE_NAME
    ).trim();

    if (nombrePlantillaSolicitado !== TEMPLATE_NAME) {
        return res.status(400).json({
            success: false,
            error: `La plantilla configurada es '${TEMPLATE_NAME}'.`
        });
    }

    try {
        validarConfiguracionWhatsApp();

        const resultadoContactos = await pool.query(
            `SELECT numero, nombre
             FROM contactos
             WHERE numero IS NOT NULL AND numero <> ''
             ORDER BY fecha DESC`
        );

        const contactos = resultadoContactos.rows;

        if (!contactos.length) {
            return res.status(400).json({
                success: false,
                error: 'No hay contactos con número en la base de datos.'
            });
        }

        let aceptados = 0;
        let fallidos = 0;
        const errores = [];

        console.log(
            `🚀 Iniciando difusión de '${TEMPLATE_NAME}' a ${contactos.length} contactos.`
        );

        for (const contacto of contactos) {
            const numero = normalizarNumeroWhatsApp(
                contacto.numero
            );

            try {
                const resultado = await enviarPlantillaWhatsApp(
                    numero,
                    contacto.nombre || 'Aventurero de la suerte'
                );

                const textoGuardar =
                    `📋 [Plantilla ${TEMPLATE_NAME}] ID: ${resultado.messageId || 'sin ID'}`;

                await pool.query(
                    `INSERT INTO mensajes
                        (numero, tipo_envio, tipo_contenido, contenido, fecha)
                     VALUES ($1, 'saliente', 'template', $2, NOW())`,
                    [numero, textoGuardar]
                );

                await pool.query(
                    `UPDATE contactos
                     SET ultimo_mensaje = $1, fecha = NOW()
                     WHERE numero = $2`,
                    [textoGuardar, numero]
                );

                io.emit('nuevo_mensaje', {
                    nombre: contacto.nombre || numero,
                    numero,
                    mensaje: textoGuardar,
                    tipo: 'template',
                    tipo_envio: 'saliente',
                    status: 'sent',
                    messageId: resultado.messageId,
                    timestamp: new Date().toLocaleTimeString(
                        [],
                        {
                            hour: '2-digit',
                            minute: '2-digit'
                        }
                    )
                });

                aceptados++;

                await new Promise(resolve => setTimeout(resolve, 1200));
            } catch (err) {
                const detalle = err.response?.data || err.message;

                console.error(
                    `❌ ERROR PLANTILLA PARA ${numero}:`,
                    JSON.stringify(detalle)
                );

                fallidos++;

                errores.push({
                    numero,
                    error: detalle
                });
            }
        }

        console.log(
            `🏁 Difusión terminada. Aceptados por Meta: ${aceptados}; fallidos en solicitud: ${fallidos}.`
        );

        return res.json({
            success: true,
            aceptados,
            exitosos: aceptados,
            fallidos,
            total: contactos.length,
            errores: errores.slice(0, 20),
            message:
                'Aceptados indica que Meta aceptó la solicitud, no que todos los mensajes hayan sido entregados.'
        });
    } catch (error) {
        const detalle = error.response?.data || error.message;

        console.error(
            '❌ ERROR GENERAL DIFUSIÓN:',
            JSON.stringify(detalle)
        );

        return res.status(500).json({
            success: false,
            error: detalle
        });
    }
});

// Subir un archivo multimedia a Meta.
async function subirMediaAMeta(base64Data, mimeType) {
    validarConfiguracionWhatsApp();

    const cleanBase64 = base64Data.replace(
        /^data:(.*);base64,/,
        ''
    );

    const buffer = Buffer.from(cleanBase64, 'base64');

    let finalMimeType = mimeType;

    if (
        mimeType.includes('audio') ||
        mimeType.includes('webm')
    ) {
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
                Authorization: `Bearer ${WHATSAPP_TOKEN}`
            }
        }
    );

    return response.data.id;
}

function obtenerNombreArchivo(mimeType) {
    if (mimeType.includes('audio')) {
        return 'nota_de_voz.ogg';
    }

    if (mimeType.includes('png')) {
        return 'imagen.png';
    }

    return 'imagen.jpg';
}

// Enviar mensajes normales por la API de WhatsApp.
async function enviarMensajeWhatsApp(
    numeroDestino,
    texto,
    tipo,
    mediaId
) {
    validarConfiguracionWhatsApp();

    const numero = normalizarNumeroWhatsApp(numeroDestino);

    if (!/^\d{10,15}$/.test(numero)) {
        throw new Error(
            `Número inválido: ${numeroDestino}. Usa formato internacional, por ejemplo 573001234567.`
        );
    }

    const url =
        `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: numero,
        type: mediaId
            ? (tipo === 'audio' ? 'audio' : 'image')
            : 'text'
    };

    if (mediaId) {
        if (tipo === 'audio') {
            payload.audio = { id: mediaId };
        } else if (tipo === 'image') {
            payload.image = { id: mediaId };

            if (texto) {
                payload.image.caption = texto;
            }
        }
    } else {
        payload.text = {
            preview_url: false,
            body: texto
        };
    }

    const response = await axios.post(url, payload, {
        headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });

    console.log(
        `🚀 Meta aceptó mensaje (${tipo}) para ${numero}:`,
        JSON.stringify(response.data)
    );

    return response.data;
}

server.listen(PORT, () => {
    console.log(
        `🚀 Servidor CRM ejecutándose en el puerto ${PORT}`
    );
});

