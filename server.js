const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const express = require('express');
const multer = require('multer');
const fs = require('fs');

// Global safety net to prevent process crashes on VPS (e.g. auth timeouts, stream errors)
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Process Error] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('[Process Error] Uncaught Exception:', error);
});

const app = express();
const port = process.env.PORT || 3000;

// Setup multer for in-memory file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Enable JSON parsing for requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Pino logger for Baileys (quiet logger to avoid flooding terminal)
const logger = pino({ level: 'silent' });

// Global session state
let sessionState = {
    status: 'not_started', // not_started, initializing, qr, ready, logged_out
    ready: false,
    initializing: false,
    hasQr: false,
    startedAt: null,
    lastError: null,
    info: null
};

let qrCodeString = null;
let qrCodeImage = null; // Base64 representation of QR code
let sock = null;

// Helpers to format JIDs between Baileys and WhatsApp Web API specs
const toBaileysJid = (to) => {
    if (!to) return null;
    let clean = to.toString().replace(/[^0-9]/g, '');
    if (to.toString().endsWith('@g.us')) {
        return to.toString();
    }
    return `${clean}@s.whatsapp.net`;
};

const toCleanNumber = (jid) => {
    if (!jid) return '';
    return jid.split('@')[0].split(':')[0];
};

const formatSentMessageResponse = (to, body, response, type = 'chat', hasMedia = false) => {
    const cleanTo = toCleanNumber(to);
    const cleanFrom = sock?.user?.id ? toCleanNumber(sock.user.id) : '';
    return {
        ok: true,
        delivery: "pending",
        message: {
            id: `true_${cleanTo}@c.us_${response.key.id}`,
            ack: 0,
            from: `${cleanFrom}@c.us`,
            to: `${cleanTo}@c.us`,
            author: null,
            body: body || "",
            type: type,
            timestamp: Number(response.messageTimestamp) || Math.floor(Date.now() / 1000),
            fromMe: true,
            hasMedia: hasMedia,
            isForwarded: false,
            mentionedIds: []
        }
    };
};

// Middleware to verify if WhatsApp client is connected and ready
const verifyClientState = (req, res, next) => {
    if (sessionState.status === 'not_started' || sessionState.status === 'logged_out' || !sock) {
        return res.status(409).json({
            ok: false,
            error: "WhatsApp client is not started. Call POST /api/session/start first."
        });
    }
    if (sessionState.status !== 'ready') {
        return res.status(409).json({
            ok: false,
            error: "WhatsApp client is not ready. Scan QR code and wait for ready status."
        });
    }
    next();
};

// Auto-reply processor from Webhook response
const handleWebhookReply = async (remoteJid, replyData, originalMsg) => {
    try {
        if (!sock) return;

        let messageOptions = {};
        let isMedia = false;
        
        if (replyData.audio) {
            isMedia = true;
            let mimetype = 'audio/mp4';
            if (replyData.audio.toLowerCase().endsWith('.ogg') || replyData.audio.toLowerCase().includes('.ogg?')) {
                mimetype = 'audio/ogg; codecs=opus';
            }
            messageOptions = {
                audio: { url: replyData.audio },
                mimetype: mimetype,
                ptt: replyData.ptt === true || replyData.ptt === 'true'
            };
        } else if (replyData.image) {
            isMedia = true;
            messageOptions = {
                image: { url: replyData.image },
                caption: replyData.reply || ''
            };
        } else if (replyData.reply) {
            messageOptions = {
                text: replyData.reply
            };
        } else {
            // Nothing to reply
            return;
        }

        // Quoting the message if requested
        const sendOptions = replyData.quote === true ? { quoted: originalMsg } : {};

        const response = await sock.sendMessage(remoteJid, messageOptions, sendOptions);
        console.log(`[Auto-Reply Success] Sent reply to ${toCleanNumber(remoteJid)} (Msg ID: ${response.key.id})`);
    } catch (err) {
        console.error('[Auto-Reply Error] Failed to send auto-reply:', err.message);
    }
};

// Initialize WhatsApp connection
async function startWhatsApp() {
    if (sessionState.initializing) return;

    sessionState.status = 'initializing';
    sessionState.initializing = true;
    sessionState.ready = false;
    sessionState.hasQr = false;
    sessionState.startedAt = new Date().toISOString();
    sessionState.lastError = null;
    sessionState.info = null;

    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        // Fetch latest WhatsApp Web version to prevent stream error disconnects (515)
        const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => {
            return { version: [2, 3000, 1017531287], isLatest: false }; // fallback version
        });
        console.log(`Using WhatsApp Web Version: ${version.join('.')}, isLatest: ${isLatest}`);

        sock = makeWASocket({
            version: version,
            auth: state,
            printQRInTerminal: true, // Output to terminal for convenience
            logger: logger,
            browser: ['Ubuntu', 'Chrome', '110.0.5481.177'], // Chrome on Ubuntu browser string
            connectTimeoutMs: 60000, // Timeout after 60 seconds
            keepAliveIntervalMs: 30000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCodeString = qr;
                try {
                    qrCodeImage = await QRCode.toDataURL(qr);
                    sessionState.status = 'qr';
                    sessionState.hasQr = true;
                } catch (err) {
                    console.error('Failed to generate base64 QR Code:', err.message);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`Connection closed. Reconnecting: ${shouldReconnect}`, lastDisconnect?.error);
                
                qrCodeString = null;
                qrCodeImage = null;
                sessionState.ready = false;
                sessionState.hasQr = false;

                if (shouldReconnect) {
                    sessionState.status = 'initializing';
                    sessionState.initializing = false; // Reset flag to allow reconnect function to pass the guard
                    console.log('Waiting 3 seconds before reconnecting to allow session credentials to write to disk...');
                    setTimeout(() => {
                        startWhatsApp();
                    }, 3000);
                } else {
                    sessionState.status = 'logged_out';
                    sessionState.initializing = false;
                    console.log('Session disconnected and logged out. Cleaning up credentials folder...');
                    if (fs.existsSync('auth_info_baileys')) {
                        try {
                            fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                            console.log('Successfully cleared invalid credentials folder.');
                        } catch (err) {
                            console.error('Failed to clear credentials folder:', err.message);
                        }
                    }
                }
            } else if (connection === 'open') {
                console.log('WhatsApp connection opened successfully!');
                qrCodeString = null;
                qrCodeImage = null;
                sessionState.status = 'ready';
                sessionState.ready = true;
                sessionState.initializing = false;
                sessionState.hasQr = false;

                const userJid = sock.user.id;
                const cleanNumber = toCleanNumber(userJid);
                sessionState.info = {
                    pushname: sock.user.name || 'WhatsApp Session',
                    wid: {
                        server: 'c.us',
                        user: cleanNumber,
                        _serialized: `${cleanNumber}@c.us`
                    }
                };
            }
        });

        // Event listener for incoming text messages and Webhook forwarding
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    // Skip outgoing messages
                    if (msg.key.fromMe) continue;

                    const remoteJid = msg.key.remoteJid;
                    const messageText = msg.message?.conversation || 
                                        msg.message?.extendedTextMessage?.text || 
                                        '';

                    // Only handle incoming text messages
                    if (!messageText) continue;

                    const cleanSender = toCleanNumber(remoteJid);
                    console.log(`[Incoming Message] From: ${cleanSender} | Message: ${messageText}`);

                    // Send webhook POST if WEBHOOK_URL is set
                    const webhookUrl = process.env.WEBHOOK_URL;
                    if (webhookUrl) {
                        try {
                            const payload = {
                                type: 'message_received',
                                at: new Date().toISOString(),
                                payload: {
                                    id: `false_${cleanSender}@c.us_${msg.key.id}`,
                                    from: cleanSender,
                                    body: messageText,
                                    timestamp: msg.messageTimestamp
                                }
                            };

                            const response = await fetch(webhookUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(payload)
                            });

                            if (response.ok) {
                                const replyData = await response.json().catch(() => null);
                                if (replyData) {
                                    await handleWebhookReply(remoteJid, replyData, msg);
                                }
                            }
                        } catch (error) {
                            console.error('[Webhook Error] Failed to send/process webhook:', error.message);
                        }
                    }
                }
            }
        });

    } catch (err) {
        sessionState.status = 'not_started';
        sessionState.initializing = false;
        sessionState.lastError = err.message;
        console.error('Failed to initialize WhatsApp connection:', err);
    }
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// Start session
app.post('/api/session/start', (req, res) => {
    if (sessionState.status === 'ready' || sessionState.status === 'initializing') {
        return res.json({ ok: true, session: sessionState });
    }
    startWhatsApp();
    res.json({ ok: true, session: sessionState });
});

// Show QR Code Page (HTML or JSON)
app.get('/api/session/qr', (req, res) => {
    const isJson = req.query.format === 'json';

    if (sessionState.ready) {
        return isJson ? res.json({
            ok: true,
            message: "WhatsApp is already connected.",
            session: sessionState
        }) : res.send('<h2>WhatsApp is already connected.</h2>');
    }

    if (!sessionState.hasQr || !qrCodeImage) {
        return isJson ? res.json({
            ok: true,
            message: "QR code is not available yet. Try again shortly.",
            session: sessionState
        }) : res.send('<h2>QR code is not available yet. Refresh in a few seconds...</h2><script>setTimeout(() => location.reload(), 3000)</script>');
    }

    if (isJson) {
        return res.json({
            ok: true,
            qr: qrCodeString,
            image: qrCodeImage,
            session: sessionState
        });
    }

    // HTML Response
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Web QR Code</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #f0f2f5; margin: 0; }
                .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); text-align: center; max-width: 320px; }
                img { max-width: 100%; margin: 20px 0; border: 1px solid #e9ecef; border-radius: 6px; }
                h1 { color: #00a884; margin-top: 0; font-size: 24px; }
                p { color: #54656f; font-size: 15px; line-height: 1.4; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>Scan QR Code</h1>
                <p>Open WhatsApp on your phone, tap Menu or Settings, select Linked Devices, and scan this QR code.</p>
                <img src="${qrCodeImage}" alt="WhatsApp QR Code">
                <p style="color: #8696a0; font-size: 13px;">Checking status automatically...</p>
            </div>
            <script>
                async function checkStatus() {
                    try {
                        const res = await fetch('/api/session/status');
                        const data = await res.json();
                        if (data.session && data.session.ready) {
                            document.body.innerHTML = '<div class="card"><h1>Connected!</h1><p>WhatsApp client is ready. You can close this tab now.</p></div>';
                            return;
                        }
                    } catch (e) {}
                    setTimeout(checkStatus, 2500);
                }
                checkStatus();
            </script>
        </body>
        </html>
    `);
});

// Check Session Status
app.get('/api/session/status', (req, res) => {
    res.json({ ok: true, session: sessionState });
});

// Logout and Reset Session
app.post('/api/session/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout().catch(() => {});
            sock.end();
            sock = null;
        }
        
        // Remove local credentials cache
        if (fs.existsSync('auth_info_baileys')) {
            fs.rmSync('auth_info_baileys', { recursive: true, force: true });
        }

        sessionState.status = 'logged_out';
        sessionState.ready = false;
        sessionState.initializing = false;
        sessionState.hasQr = false;
        sessionState.startedAt = null;
        sessionState.info = null;

        qrCodeString = null;
        qrCodeImage = null;

        res.json({ ok: true, session: sessionState });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Send Text Message
app.post('/api/send/text', verifyClientState, async (req, res) => {
    const { to, message } = req.body;

    if (!to || !message) {
        return res.status(400).json({ ok: false, error: 'Missing "to" or "message" parameter' });
    }

    try {
        const jid = toBaileysJid(to);
        const response = await sock.sendMessage(jid, { text: message });
        res.json(formatSentMessageResponse(jid, message, response, 'chat', false));
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Send Media From File Upload
app.post('/api/send/media', verifyClientState, upload.single('file'), async (req, res) => {
    const to = req.body.to;
    const caption = req.body.caption;

    if (!to) {
        return res.status(400).json({ ok: false, error: 'to is required' });
    }
    if (!req.file) {
        return res.status(400).json({ ok: false, error: 'file is required' });
    }

    try {
        const jid = toBaileysJid(to);
        let mimetype = req.file.mimetype;
        if (req.file.originalname.toLowerCase().endsWith('.ogg') || mimetype.includes('ogg')) {
            mimetype = 'audio/ogg; codecs=opus';
        }

        let messageOptions = {};
        let type = 'document';

        if (mimetype.startsWith('image/')) {
            messageOptions = { image: req.file.buffer, caption: caption || '' };
            type = 'image';
        } else if (mimetype.startsWith('video/')) {
            messageOptions = { video: req.file.buffer, caption: caption || '' };
            type = 'video';
        } else if (mimetype.startsWith('audio/')) {
            messageOptions = { 
                audio: req.file.buffer, 
                mimetype: mimetype, 
                ptt: req.body.ptt === 'true' || req.body.ptt === true 
            };
            type = 'audio';
        } else {
            messageOptions = { 
                document: req.file.buffer, 
                mimetype: mimetype, 
                fileName: req.file.originalname,
                caption: caption || '' 
            };
        }

        const response = await sock.sendMessage(jid, messageOptions);
        res.json(formatSentMessageResponse(jid, caption || '', response, type, true));
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Send Media From URL
app.post('/api/send/media-url', verifyClientState, async (req, res) => {
    const { to, url, caption } = req.body;

    if (!to || !url) {
        return res.status(400).json({ ok: false, error: 'Missing "to" or "url" parameter' });
    }

    try {
        const jid = toBaileysJid(to);
        
        // Fetch content type headers
        const headResponse = await fetch(url, { method: 'HEAD' }).catch(() => null);
        let contentType = headResponse ? headResponse.headers.get('content-type') : null;
        
        // Fallback mimetype mapping based on extension
        if (!contentType) {
            const ext = url.split('.').pop().toLowerCase().split('?')[0];
            const mimeMap = {
                pdf: 'application/pdf',
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                png: 'image/png',
                gif: 'image/gif',
                mp4: 'video/mp4',
                mp3: 'audio/mpeg',
                ogg: 'audio/ogg; codecs=opus'
            };
            contentType = mimeMap[ext] || 'application/octet-stream';
        }

        if (url.toLowerCase().endsWith('.ogg') || url.toLowerCase().includes('.ogg?') || contentType.includes('ogg')) {
            contentType = 'audio/ogg; codecs=opus';
        }

        let messageOptions = {};
        let type = 'document';

        if (contentType.startsWith('image/')) {
            messageOptions = { image: { url: url }, caption: caption || '' };
            type = 'image';
        } else if (contentType.startsWith('video/')) {
            messageOptions = { video: { url: url }, caption: caption || '' };
            type = 'video';
        } else if (contentType.startsWith('audio/')) {
            messageOptions = { 
                audio: { url: url }, 
                mimetype: contentType, 
                ptt: req.body.ptt === 'true' || req.body.ptt === true 
            };
            type = 'audio';
        } else {
            const fileName = url.split('/').pop().split('?')[0] || 'file';
            messageOptions = { 
                document: { url: url }, 
                mimetype: contentType, 
                fileName: fileName,
                caption: caption || '' 
            };
        }

        const response = await sock.sendMessage(jid, messageOptions);
        res.json(formatSentMessageResponse(jid, caption || '', response, type, true));
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ----------------------------------------------------
// UI Dashboard Homepage
// ----------------------------------------------------
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Web API Dashboard</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 40px; background-color: #f0f2f5; color: #111b21; }
                .container { max-width: 700px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                h1 { color: #00a884; margin-top: 0; }
                .status { display: inline-block; padding: 6px 12px; border-radius: 5px; font-weight: bold; margin-bottom: 20px; text-transform: uppercase; font-size: 14px; }
                .status.ready { background-color: #d9fdd3; color: #128c7e; }
                .status.initializing { background-color: #fff9db; color: #f08c00; }
                .status.qr { background-color: #e8f4fd; color: #0066cc; }
                .status.not_started, .status.logged_out { background-color: #ffe0e0; color: #ea003b; }
                .btn-group { display: flex; gap: 10px; margin-bottom: 25px; }
                .btn-action { padding: 10px 18px; border-radius: 6px; font-weight: bold; cursor: pointer; border: none; font-size: 14px; text-decoration: none; text-align: center; }
                .btn-primary { background-color: #00a884; color: white; }
                .btn-primary:hover { background-color: #008f72; }
                .btn-danger { background-color: #ea003b; color: white; }
                .btn-danger:hover { background-color: #c90032; }
                .btn-secondary { background-color: #e9ecef; color: #495057; }
                .btn-secondary:hover { background-color: #dee2e6; }
                .form-group { margin-bottom: 15px; }
                .form-group label { display: block; font-weight: bold; margin-bottom: 5px; font-size: 14px; }
                .form-group input[type="text"], .form-group textarea { width: 100%; padding: 10px; border: 1px solid #ced4da; border-radius: 5px; box-sizing: border-box; }
                .form-group input[type="file"] { display: block; margin-top: 5px; }
                #notification { display: none; padding: 12px; border-radius: 5px; margin-bottom: 20px; font-weight: bold; font-size: 14px; }
                #notification.success { background-color: #d9fdd3; color: #128c7e; border: 1px solid #128c7e; }
                #notification.error { background-color: #ffe0e0; color: #ea003b; border: 1px solid #ea003b; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>WhatsApp Web API Dashboard</h1>
                
                <!-- Status Panel -->
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 25px; background: #f8f9fa; padding: 15px; border-radius: 8px; border: 1px solid #e9ecef;">
                    <div>
                        <span style="font-weight: bold; color: #54656f; margin-right: 8px;">Status:</span>
                        <span id="statusBadge" class="status ${sessionState.status}">${sessionState.status.replace('_', ' ')}</span>
                    </div>
                    <div id="sessionInfo" style="font-size: 14px; color: #54656f; display: ${sessionState.status === 'ready' ? 'block' : 'none'};">
                        Connected as: <strong id="connectedUser">${sessionState.info?.pushname || 'User'} (${sessionState.info?.wid?.user || ''})</strong>
                    </div>
                </div>
                
                <div class="btn-group">
                    <button id="startBtn" onclick="startSession()" class="btn-action btn-primary" style="display: ${(sessionState.status === 'ready' || sessionState.status === 'initializing' || sessionState.status === 'qr') ? 'none' : 'inline-block'};">Start Session</button>
                    <button id="logoutBtn" onclick="logoutSession()" class="btn-action btn-danger" style="display: ${(sessionState.status === 'ready' || sessionState.status === 'initializing' || sessionState.status === 'qr') ? 'inline-block' : 'none'};">Logout/Close Session</button>
                </div>

                <div id="notification"></div>

                <!-- QR Code View Embedded on Homepage -->
                <div id="qrContainer" style="display: ${(sessionState.status === 'qr' || sessionState.status === 'initializing') ? 'block' : 'none'}; background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 25px; text-align: center; margin-bottom: 25px;">
                    <h3 style="margin-top: 0; color: #00a884;">Scan QR Code to Connect</h3>
                    <p style="color: #54656f; font-size: 14px; margin-bottom: 20px;">Open WhatsApp on your phone, go to Settings > Linked Devices, and scan this QR code.</p>
                    <div id="qrSpinner" style="color: #666; font-size: 14px; padding: 20px; display: ${sessionState.status === 'initializing' ? 'block' : 'none'};">Generating QR code...</div>
                    <img id="qrImage" src="${qrCodeImage || ''}" alt="WhatsApp QR Code" style="display: ${sessionState.status === 'qr' ? 'block' : 'none'}; max-width: 250px; margin: 0 auto; border: 1px solid #e9ecef; border-radius: 6px; padding: 5px; background: white;">
                </div>

                <!-- Send Message Testing Form -->
                <form id="sendMessageForm" enctype="multipart/form-data" style="background: #f8f9fa; border: 1px solid #e9ecef; padding: 25px; border-radius: 8px; margin-bottom: 25px; display: ${sessionState.status === 'ready' ? 'block' : 'none'};">
                    <h3 style="margin-top: 0; color: #00a884; margin-bottom: 15px;">Send WhatsApp Message (Test)</h3>
                    
                    <div class="form-group">
                        <label for="toInput">Recipient Phone Number (with Country Code):</label>
                        <input id="toInput" type="text" name="to" placeholder="e.g. 923001234567" required>
                    </div>

                    <div class="form-group">
                        <label for="messageInput">Message / Caption:</label>
                        <textarea id="messageInput" name="message" placeholder="Enter message text or image caption" rows="3"></textarea>
                    </div>

                    <div style="border-top: 1px solid #dee2e6; margin: 15px 0; padding-top: 15px;">
                        <h4 style="margin: 0 0 10px 0; color: #495057; font-size: 14px;">Add Image (Optional)</h4>
                        <div class="form-group">
                            <label for="imageUrlInput">Image URL:</label>
                            <input id="imageUrlInput" type="text" name="image" placeholder="https://example.com/image.jpg">
                        </div>
                        <div class="form-group">
                            <label for="imageFileInput">Or Upload Image File:</label>
                            <input id="imageFileInput" type="file" name="imageFile" accept="image/*">
                        </div>
                    </div>

                    <div style="border-top: 1px solid #dee2e6; margin: 15px 0; padding-top: 15px;">
                        <h4 style="margin: 0 0 10px 0; color: #495057; font-size: 14px;">Add Audio / Voice Note (Optional)</h4>
                        <div class="form-group">
                            <label for="audioUrlInput">Audio URL:</label>
                            <input id="audioUrlInput" type="text" name="audio" placeholder="https://example.com/sound.mp3">
                        </div>
                        <div class="form-group">
                            <label for="audioFileInput">Or Upload Audio File:</label>
                            <input id="audioFileInput" type="file" name="audioFile" accept="audio/*">
                        </div>
                        <div class="form-group" style="display: flex; align-items: center; gap: 8px;">
                            <input id="pttCheckbox" type="checkbox" name="ptt" value="true" style="margin:0;">
                            <label for="pttCheckbox" style="margin:0; font-weight: normal; font-size: 13px;">Send as Push-to-Talk Voice Note (PTT)</label>
                        </div>
                    </div>

                    <button type="submit" class="btn-action btn-primary" style="width: 100%; padding: 12px; margin-top: 10px;">Send Message</button>
                </form>
            </div>

            <script>
                async function startSession() {
                    const notify = document.getElementById('notification');
                    notify.style.display = 'none';
                    try {
                        const res = await fetch('/api/session/start', { method: 'POST' });
                        const data = await res.json();
                        if (data.ok) {
                            showNotification('Session starting...', 'success');
                            updateStatus();
                        } else {
                            showNotification('Error starting session: ' + data.error, 'error');
                        }
                    } catch (e) {
                        showNotification('Network error starting session: ' + e.message, 'error');
                    }
                }

                async function logoutSession() {
                    const notify = document.getElementById('notification');
                    notify.style.display = 'none';
                    if (!confirm('Are you sure you want to logout and reset credentials?')) return;
                    try {
                        const res = await fetch('/api/session/logout', { method: 'POST' });
                        const data = await res.json();
                        if (data.ok) {
                            showNotification('Logged out successfully.', 'success');
                            updateStatus();
                        } else {
                            showNotification('Error: ' + data.error, 'error');
                        }
                    } catch (e) {
                        showNotification('Network error logging out: ' + e.message, 'error');
                    }
                }

                function showNotification(msg, type) {
                    const notify = document.getElementById('notification');
                    notify.textContent = msg;
                    notify.className = type;
                    notify.style.display = 'block';
                }

                async function updateStatus() {
                    try {
                        const res = await fetch('/api/session/status');
                        const data = await res.json();
                        const session = data.session || {};

                        const statusBadge = document.getElementById('statusBadge');
                        const startBtn = document.getElementById('startBtn');
                        const logoutBtn = document.getElementById('logoutBtn');
                        const qrContainer = document.getElementById('qrContainer');
                        const qrSpinner = document.getElementById('qrSpinner');
                        const qrImage = document.getElementById('qrImage');
                        const sendMessageForm = document.getElementById('sendMessageForm');
                        const sessionInfo = document.getElementById('sessionInfo');
                        const connectedUser = document.getElementById('connectedUser');

                        // Update Badge
                        statusBadge.className = 'status ' + session.status;
                        statusBadge.textContent = session.status.replace('_', ' ').toUpperCase();

                        if (session.status === 'ready') {
                            startBtn.style.display = 'none';
                            logoutBtn.style.display = 'inline-block';
                            qrContainer.style.display = 'none';
                            sendMessageForm.style.display = 'block';
                            sessionInfo.style.display = 'block';
                            connectedUser.textContent = (session.info?.pushname || 'User') + ' (' + (session.info?.wid?.user || '') + ')';
                        } else if (session.status === 'initializing') {
                            startBtn.style.display = 'none';
                            logoutBtn.style.display = 'inline-block';
                            qrContainer.style.display = 'block';
                            qrSpinner.style.display = 'block';
                            qrImage.style.display = 'none';
                            sendMessageForm.style.display = 'none';
                            sessionInfo.style.display = 'none';
                        } else if (session.status === 'qr') {
                            startBtn.style.display = 'none';
                            logoutBtn.style.display = 'inline-block';
                            qrContainer.style.display = 'block';
                            sendMessageForm.style.display = 'none';
                            sessionInfo.style.display = 'none';

                            const qrRes = await fetch('/api/session/qr?format=json');
                            const qrData = await qrRes.json();
                            if (qrData.ok && qrData.image) {
                                qrSpinner.style.display = 'none';
                                qrImage.src = qrData.image;
                                qrImage.style.display = 'block';
                            }
                        } else {
                            startBtn.style.display = 'inline-block';
                            logoutBtn.style.display = 'none';
                            qrContainer.style.display = 'none';
                            sendMessageForm.style.display = 'none';
                            sessionInfo.style.display = 'none';
                        }
                    } catch (e) {
                        console.error('Failed to sync status:', e);
                    }
                }

                // Handle sending message via dashboard form
                document.getElementById('sendMessageForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const notify = document.getElementById('notification');
                    notify.style.display = 'none';

                    const toVal = document.getElementById('toInput').value;
                    const messageVal = document.getElementById('messageInput').value;
                    const imageFile = document.getElementById('imageFileInput').files[0];
                    const audioFile = document.getElementById('audioFileInput').files[0];
                    const imageUrl = document.getElementById('imageUrlInput').value;
                    const audioUrl = document.getElementById('audioUrlInput').value;
                    const pttVal = document.getElementById('pttCheckbox').checked;

                    let url = '/api/send/text';
                    let sendMode = 'text'; // text, media, media-url

                    if (imageFile || audioFile) {
                        sendMode = 'media';
                        url = '/api/send/media';
                    } else if (imageUrl || audioUrl) {
                        sendMode = 'media-url';
                        url = '/api/send/media-url';
                    }

                    try {
                        let response;
                        if (sendMode === 'text') {
                            response = await fetch(url, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ to: toVal, message: messageVal })
                            });
                        } else if (sendMode === 'media-url') {
                            const mediaUrl = imageUrl || audioUrl;
                            response = await fetch(url, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ to: toVal, url: mediaUrl, caption: messageVal, ptt: pttVal })
                            });
                        } else {
                            // Construct clean FormData manually to prevent Multer "Unexpected field" error
                            const cleanFormData = new FormData();
                            cleanFormData.append('to', toVal);
                            cleanFormData.append('caption', messageVal);
                            if (imageFile) {
                                cleanFormData.append('file', imageFile);
                            } else if (audioFile) {
                                cleanFormData.append('file', audioFile);
                                cleanFormData.append('ptt', pttVal ? 'true' : 'false');
                            }
                            
                            response = await fetch(url, {
                                method: 'POST',
                                body: cleanFormData
                            });
                        }

                        const result = await response.json();
                        if (response.ok && result.ok) {
                            showNotification('Message sent successfully! Message ID: ' + result.message.id, 'success');
                            // Reset form except recipient
                            e.target.reset();
                            document.getElementById('toInput').value = toVal;
                        } else {
                            showNotification('Failed to send: ' + (result.error || 'Unknown error'), 'error');
                        }
                    } catch (error) {
                        showNotification('Network error: ' + error.message, 'error');
                    }
                });

                // Poll status every 2 seconds
                setInterval(updateStatus, 2000);
                updateStatus();
            </script>
        </body>
        </html>
    `);
});

// Start express server
app.listen(port, () => {
    console.log(`HTTP Server running on http://localhost:${port}`);
    
    // Auto-connect WhatsApp if session credentials already exist on startup
    if (fs.existsSync('auth_info_baileys')) {
        console.log('Credentials cache found, auto-starting session on boot...');
        startWhatsApp();
    }
});
