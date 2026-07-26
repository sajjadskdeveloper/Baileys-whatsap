# Baileys WhatsApp Web API Server

A lightweight WhatsApp Web automation server using the Baileys library. This project allows you to send and receive WhatsApp messages, media, and voice notes via a simple REST API.

## Features

- ✅ Send text messages
- ✅ Send images, videos, audio, and documents
- ✅ Send media from URLs
- ✅ Send voice notes (PTT)
- ✅ Receive incoming messages via webhooks
- ✅ Auto-reply functionality
- ✅ Web-based dashboard for testing
- ✅ QR code authentication
- ✅ Minimal resource footprint (~200MB RAM)

## Prerequisites

- Node.js 16+ 
- npm or yarn
- 512MB+ RAM (recommended for VPS)
- 1GB+ disk space

---

## Quick Start (Local Machine)

### 1. Clone the Repository

```bash
git clone https://github.com/sajjadskdeveloper/Baileys-whatsap.git
cd Baileys-whatsap
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start the Server

```bash
npm start
```

The server will start on `http://localhost:3000`

### 4. Access the Dashboard

- Open your browser and go to **`http://localhost:3000`**
- Click **"Start Session"** button
- Scan the QR code with your WhatsApp phone app (Settings > Linked Devices > Link a Device)
- Wait for connection confirmation

---

## Deployment on Oracle Cloud Ubuntu VPS (Limited Resources)

### Prerequisites for Oracle VPS Setup

- Oracle Cloud free tier Ubuntu 22.04 LTS instance (1 OCPU, 1GB RAM minimum)
- SSH access to your VPS
- Domain name (optional but recommended)
- Basic Linux command knowledge

---

## Step 1: Connect to Your Oracle Cloud VPS

```bash
ssh ubuntu@<YOUR_VPS_IP_ADDRESS>
# Replace <YOUR_VPS_IP_ADDRESS> with your actual VPS IP
```

---

## Step 2: Update System and Install Dependencies

```bash
# Update package lists
sudo apt update
sudo apt upgrade -y

# Install Node.js and npm
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs git

# Verify installation
node --version
npm --version
```

---

## Step 3: Clone and Setup the Project

```bash
# Clone the repository
git clone https://github.com/sajjadskdeveloper/Baileys-whatsap.git
cd Baileys-whatsap

# Install dependencies (this may take 2-3 minutes on limited VPS)
npm install --production
```

**Note:** Use `--production` flag to skip unnecessary dev dependencies and save disk space on limited VPS.

---

## Step 4: Optimize for Limited Resources

### Create a `.env` file

```bash
cat > .env << EOF
PORT=3000
NODE_ENV=production
EOF
```

### Install PM2 for Process Management (Important for VPS Stability)

```bash
sudo npm install -g pm2

# Create PM2 startup configuration
pm2 startup
pm2 start server.js --name "whatsapp-api"
pm2 save
```

This ensures your application:
- ✅ Automatically restarts if it crashes
- ✅ Starts on system reboot
- ✅ Runs in the background

### Check if the server is running

```bash
pm2 status
pm2 logs whatsapp-api
```

---

## Step 5: Configure Oracle Cloud Firewall Rules

### Enable Port 3000 in Oracle Cloud Security Rules

1. **Go to Oracle Cloud Console** → Compute → Instances
2. Click on your instance
3. Under "Primary VNIC" → Security Lists
4. Click the default security list
5. Click **"Add Ingress Rules"**
6. Add this rule:
   - **Source Type:** CIDR
   - **Source CIDR:** `0.0.0.0/0` (accessible from anywhere)
   - **IP Protocol:** TCP
   - **Destination Port Range:** `3000`
7. Click **"Add Ingress Rule"**

### Ubuntu Firewall Configuration

```bash
# Check UFW status
sudo ufw status

# If UFW is active, enable port 3000
sudo ufw allow 3000/tcp

# Verify the rule was added
sudo ufw status numbered
```

---

## Step 6: Setup Reverse Proxy with Nginx (Optional but Recommended)

If you want to use a domain name and avoid showing the port number:

### Install Nginx

```bash
sudo apt install -y nginx
```

### Create Nginx Configuration

```bash
sudo tee /etc/nginx/sites-available/whatsapp-api > /dev/null << EOF
server {
    listen 80;
    server_name _;
    
    client_max_body_size 50M;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF
```

### Enable the Configuration

```bash
# Create symbolic link
sudo ln -s /etc/nginx/sites-available/whatsapp-api /etc/nginx/sites-enabled/

# Remove default site
sudo rm /etc/nginx/sites-enabled/default

# Test Nginx configuration
sudo nginx -t

# Start Nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

### Update Firewall for HTTP

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

---

## Step 7: Port Forwarding & Getting a Working Link

### Option A: Using Your VPS IP Address (No Domain Required)

Your working link will be:

```
http://<YOUR_VPS_IP>:3000
```

**Example:**
```
http://158.101.200.45:3000
```

### Option B: Using a Domain Name (Recommended)

If you have a domain and want HTTPS:

#### 1. Point Your Domain to VPS IP

In your domain registrar's DNS settings:
- Add `A` record pointing to your VPS IP
- Example: `whatsapp-api.example.com` → `158.101.200.45`

Wait 15-30 minutes for DNS propagation.

#### 2. Install SSL Certificate with Let's Encrypt

```bash
# Install Certbot
sudo apt install -y certbot python3-certbot-nginx

# Get SSL certificate
sudo certbot certonly --standalone -d whatsapp-api.example.com

# Update Nginx to use SSL
sudo tee /etc/nginx/sites-available/whatsapp-api > /dev/null << EOF
server {
    listen 80;
    server_name whatsapp-api.example.com;
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name whatsapp-api.example.com;
    
    ssl_certificate /etc/letsencrypt/live/whatsapp-api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/whatsapp-api.example.com/privkey.pem;
    
    client_max_body_size 50M;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF

# Test and reload Nginx
sudo nginx -t
sudo systemctl reload nginx
```

#### 3. Auto-Renew SSL Certificate

```bash
sudo certbot renew --dry-run
```

#### Your Working HTTPS Link

```
https://whatsapp-api.example.com
```

---

## Accessing Your Application

### Via IP Address
- **Dashboard:** `http://YOUR_VPS_IP:3000`
- **Status API:** `http://YOUR_VPS_IP:3000/api/session/status`

### Via Domain (If configured)
- **Dashboard:** `https://whatsapp-api.example.com`
- **Status API:** `https://whatsapp-api.example.com/api/session/status`

---

## API Endpoints

### Session Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/session/start` | POST | Start WhatsApp session |
| `/api/session/qr` | GET | Get QR code (HTML or JSON) |
| `/api/session/status` | GET | Check connection status |
| `/api/session/logout` | POST | Logout and clear credentials |

### Send Messages

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/send/text` | POST | Send text message |
| `/api/send/media` | POST | Send media (image/video/audio) |
| `/api/send/media-url` | POST | Send media from URL |

### Examples

#### Start Session
```bash
curl -X POST http://YOUR_VPS_IP:3000/api/session/start
```

#### Send Text Message
```bash
curl -X POST http://YOUR_VPS_IP:3000/api/send/text \
  -H "Content-Type: application/json" \
  -d '{"to": "923001234567", "message": "Hello from API!"}'
```

#### Check Status
```bash
curl http://YOUR_VPS_IP:3000/api/session/status
```

---

## Webhook Configuration (For Auto-Replies)

To enable automatic replies on incoming messages:

### 1. Set Webhook URL via Environment Variable

```bash
# Edit PM2 configuration
pm2 delete whatsapp-api

# Set environment variable and restart
WEBHOOK_URL="https://your-webhook-endpoint.com/webhook" npm start

# Or use PM2 ecosystem file
pm2 start server.js --name "whatsapp-api" \
  --env "WEBHOOK_URL=https://your-webhook-endpoint.com/webhook"
```

### 2. Webhook Request Format

The server sends POST requests with this structure:

```json
{
  "type": "message_received",
  "at": "2024-01-15T10:30:45.123Z",
  "payload": {
    "id": "false_923001234567@c.us_ABC123",
    "from": "923001234567",
    "body": "Hello!",
    "timestamp": 1705317045
  }
}
```

### 3. Webhook Response Format

Your webhook endpoint should return:

```json
{
  "reply": "Thanks for your message!",
  "quote": true
}
```

Or with media:

```json
{
  "image": "https://example.com/image.jpg",
  "reply": "Here's your image",
  "quote": false
}
```

---

## Troubleshooting

### Issue: "Port already in use"
```bash
# Find process using port 3000
lsof -i :3000

# Kill the process
kill -9 <PID>

# Or use different port
PORT=3001 npm start
```

### Issue: Server crashes on VPS
```bash
# Check PM2 logs
pm2 logs whatsapp-api

# Increase Node.js memory limit
pm2 start server.js --name "whatsapp-api" --max-memory-restart 512M
```

### Issue: Cannot connect via domain
```bash
# Check DNS resolution
nslookup your-domain.com

# Check if port 80 is open
sudo netstat -tulpn | grep :80

# Check Nginx status
sudo systemctl status nginx
```

### Issue: SSL certificate issues
```bash
# Check certificate expiry
sudo certbot certificates

# Renew certificate manually
sudo certbot renew --force-renewal
```

---

## Performance Tips for Limited Resources

1. **Enable Caching** - Nginx caches responses automatically
2. **Use PM2 Monitoring** - `pm2 monit` to watch resource usage
3. **Disable Logging in Production** - Reduces disk I/O
4. **Monitor Disk Space** - Auth credentials accumulate over time
   ```bash
   df -h
   du -sh auth_info_baileys/
   ```
5. **Restart Periodically** - Prevent memory leaks
   ```bash
   pm2 restart whatsapp-api
   ```

---

## Security Best Practices

⚠️ **IMPORTANT:** Never commit sensitive data to git

```bash
# Create .gitignore if not exists
echo "auth_info_baileys/" >> .gitignore
echo ".env" >> .gitignore
echo "node_modules/" >> .gitignore

# Secure your API with authentication (add custom middleware)
```

---

## Getting Your Working Link

### Summary

After completing all steps, your application is accessible at:

**Option 1 - Direct IP (Immediate Access):**
```
http://YOUR_VPS_IP:3000
```

**Option 2 - Domain with HTTP:**
```
http://your-domain.com
```

**Option 3 - Domain with HTTPS (Recommended):**
```
https://your-domain.com
```

### Verify Your Link

Open in browser and you should see the dashboard with:
- ✅ Start Session button
- ✅ Status indicator
- ✅ Message sending form

---

## Environment Variables

```
PORT=3000
NODE_ENV=production
WEBHOOK_URL=https://your-webhook-endpoint.com/webhook
```

---

## License

MIT

## Support

For issues and feature requests, please open an issue on GitHub.

---

## Advanced: Using Custom Domain + Subdomain

If you want multiple services on one VPS:

```bash
# Create separate Nginx blocks
sudo tee /etc/nginx/sites-available/api.example.com > /dev/null << EOF
server {
    listen 80;
    server_name api.example.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host \$host;
    }
}
EOF

# Create symbolic link and reload
sudo ln -s /etc/nginx/sites-available/api.example.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## Useful Commands Reference

```bash
# Server Management
pm2 status                          # Check server status
pm2 logs whatsapp-api               # View server logs
pm2 restart whatsapp-api            # Restart server
pm2 stop whatsapp-api               # Stop server
pm2 delete whatsapp-api             # Remove from PM2

# System Monitoring
df -h                               # Disk usage
free -h                             # Memory usage
htop                                # System resources (requires install)

# Networking
sudo ufw status                      # Firewall status
curl http://localhost:3000          # Test local server
curl http://YOUR_VPS_IP:3000        # Test from outside

# Nginx
sudo systemctl status nginx          # Nginx status
sudo systemctl reload nginx          # Reload configuration
sudo nginx -t                        # Test configuration

# SSL Certificates
sudo certbot certificates           # List certificates
sudo certbot renew                  # Renew all certificates
```

---

**Last Updated:** July 2024  
**Project:** Baileys WhatsApp Web API Server  
**Repository:** https://github.com/sajjadskdeveloper/Baileys-whatsap
