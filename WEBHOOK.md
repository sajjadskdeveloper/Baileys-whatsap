# Webhook Integration & Auto-Reply Guide

This document explains how to set up your webhook receiver server and automatically respond to incoming WhatsApp messages with text, images, or audio files using this server.

---

## 1. Webhook Configuration

Start your WhatsApp server with the `WEBHOOK_URL` environment variable configured:

```bash
# Set webhook url and start the server
PORT=3000 WEBHOOK_URL=https://your-webhook-domain.com/webhook-endpoint npm start
```

On Windows (PowerShell):
```powershell
$env:WEBHOOK_URL="https://your-webhook-domain.com/webhook-endpoint"
npm start
```

---

## 2. Webhook Event Payload

When your linked WhatsApp account receives a new text message, the server makes an HTTP `POST` request to your `WEBHOOK_URL` with the following JSON payload:

```json
{
  "type": "message_received",
  "at": "2026-07-18T05:30:00.000Z",
  "payload": {
    "id": "false_923001234567@c.us_XYZ12345",
    "from": "923001234567",
    "body": "Hi there!",
    "timestamp": 1780200000
  }
}
```

---

## 3. Webhook Reply Schema

To auto-reply to the received message, your webhook server must respond to the HTTP `POST` request with a **`200 OK`** status code and a JSON response matching one of these structures:

### A. Reply with Text Message
```json
{
  "reply": "Thank you for messaging! We will get back to you shortly.",
  "quote": true
}
```
* `reply`: (String) Text message to send.
* `quote`: (Boolean, Optional) If `true`, the bot replies by quoting the user's original message.

### B. Reply with Image
```json
{
  "image": "https://example.com/images/welcome.jpg",
  "reply": "Here is your welcome package!",
  "quote": false
}
```
* `image`: (String) Absolute URL to a public image (.png, .jpg, .jpeg, etc.).
* `reply`: (String, Optional) Used as the caption text under the image.

### C. Reply with Voice Note / Audio
```json
{
  "audio": "https://example.com/assets/voice-greeting.ogg",
  "ptt": true
}
```
* `audio`: (String) Absolute URL to a public audio file (.mp3, .ogg, .wav).
* `ptt`: (Boolean, Optional) If `true`, sends it as a Push-to-Talk (PTT) voice note. If `false`, sends it as a regular audio attachment.

---

## 4. Webhook Receiver Examples

Here are template servers you can run on your side to process incoming messages and reply.

### Node.js (Express) Webhook Example
Create a new file `webhook-receiver.js` on your external server and paste this:

```javascript
const express = require('express');
const app = express();
app.use(express.json());

app.post('/webhook-endpoint', (req, res) => {
    const { type, payload } = req.body;

    // Check if the event is a message_received event
    if (type === 'message_received') {
        const sender = payload.from;
        const incomingText = payload.body.trim().toLowerCase();

        console.log(`Received message from ${sender}: "${incomingText}"`);

        // Business logic to decide the reply
        if (incomingText === 'hi' || incomingText === 'hello') {
            return res.json({
                reply: "Hello! How can I help you today?",
                quote: true
            });
        } 
        
        if (incomingText === 'image') {
            return res.json({
                image: "https://raw.githubusercontent.com/whiskeysockets/baileys/master/VALENTINES.md",
                reply: "Here is your requested image!",
                quote: false
            });
        }

        if (incomingText === 'voice' || incomingText === 'audio') {
            return res.json({
                audio: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
                ptt: true
            });
        }

        // Catch-all response
        return res.json({
            reply: "Sorry, I didn't catch that. Type 'hello', 'image', or 'voice' to test.",
            quote: false
        });
    }

    // Acknowledge other event types without replying
    res.sendStatus(200);
});

app.listen(4000, () => {
    console.log('Webhook receiver listening on port 4000');
});
```

---

### Python (Flask) Webhook Example
Create a new file `webhook_receiver.py` on your external server and paste this:

```python
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route('/webhook-endpoint', methods=['POST'])
def webhook():
    data = request.json
    event_type = data.get('type')
    payload = data.get('payload', {})

    if event_type == 'message_received':
        sender = payload.get('from')
        incoming_text = payload.get('body', '').strip().lower()

        print(f"Received message from {sender}: {incoming_text}")

        # Auto reply logic
        if incoming_text in ['hi', 'hello']:
            return jsonify({
                "reply": "Hi! Greetings from the Python Flask webhook!",
                "quote": True
            })
            
        elif incoming_text == 'image':
            return jsonify({
                "image": "https://raw.githubusercontent.com/whiskeysockets/baileys/master/VALENTINES.md",
                "reply": "Image sent from python Flask server",
                "quote": False
            })
            
        elif incoming_text == 'voice':
            return jsonify({
                "audio": "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
                "ptt": True
            })

        return jsonify({
            "reply": "I am a Python webhook. Try typing 'hello', 'image', or 'voice'."
        })

    return '', 200

if __name__ == '__main__':
    app.run(port=4000)
```

---

## 5. Testing Your Setup Localhost

To test webhooks locally:
1. Use a tool like `ngrok` to expose your webhook receiver port (e.g. `4000`):
   ```bash
   ngrok http 4000
   ```
2. Copy the forwarding HTTPS URL provided by ngrok (e.g., `https://xxxx.ngrok-free.app`).
3. Start the WhatsApp Web API server with that URL:
   ```bash
   PORT=3000 WEBHOOK_URL=https://xxxx.ngrok-free.app/webhook-endpoint npm start
   ```
4. Scan the QR code, send a message to your WhatsApp account from another number, and check the replies!
