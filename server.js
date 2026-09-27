const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const cloudflared = require('cloudflared');

const app = express();
const rawPort = process.env.PORT || '8080';
const isNamedPipe = typeof rawPort === 'string' && rawPort.startsWith('\\\\.\\pipe');

let cloudflareTunnelUrl = null;
let tunnelInstance = null;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (HTML, CSS, JS, images)
app.use(express.static(__dirname));

// Health check endpoint for Azure App Service probes
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    port: rawPort,
    cloudflareUrl: cloudflareTunnelUrl || 'connecting...',
    timestamp: new Date().toISOString()
  });
});

// Status API endpoint for current Cloudflare URL
app.get('/api/tunnel', (req, res) => {
  res.json({
    active: !!cloudflareTunnelUrl,
    url: cloudflareTunnelUrl,
    port: rawPort
  });
});

// Fallback: serve index.html for any web page route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Handle listening on port or Windows IISNode named pipe
let tunnelTargetPort = 8080;

if (isNamedPipe) {
  // Windows Azure App Service (IISNode) named pipe
  app.listen(rawPort, () => {
    console.log(`[AZURE IISNODE] Listening on named pipe: ${rawPort}`);
  });

  // Secondary internal HTTP listener for Cloudflared tunnel
  tunnelTargetPort = 3000;
  const internalServer = http.createServer(app);
  internalServer.listen(tunnelTargetPort, '127.0.0.1', () => {
    console.log(`[INTERNAL HTTP] Listening on http://127.0.0.1:${tunnelTargetPort} for Cloudflare tunnel`);
    startCloudflareTunnel(tunnelTargetPort);
  });
} else {
  // Linux Azure App Service / Local Node
  const portNumber = parseInt(rawPort, 10) || 8080;
  tunnelTargetPort = portNumber;

  app.listen(portNumber, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(68));
    console.log(` [AZURE WEB APP] HTTP Server is listening on http://0.0.0.0:${portNumber}`);
    console.log(' [AZURE WEB APP] Ready to receive requests');
    console.log('='.repeat(68) + '\n');

    startCloudflareTunnel(portNumber);
  });
}

/**
 * Initializes and starts the Cloudflare TryCloudflare Tunnel
 */
async function startCloudflareTunnel(port) {
  try {
    console.log('[Cloudflare] Checking cloudflared binary...');

    // Auto-install binary if missing or if cross-platform deployment
    if (!fs.existsSync(cloudflared.bin)) {
      console.log(`[Cloudflare] Binary not found at "${cloudflared.bin}". Downloading for ${process.platform}-${process.arch}...`);
      try {
        await cloudflared.install(cloudflared.bin);
        console.log('[Cloudflare] Binary installed successfully.');
      } catch (installErr) {
        console.error('[Cloudflare] Binary download failed:', installErr.message);
      }
    }

    console.log(`[Cloudflare] Launching quick tunnel for http://127.0.0.1:${port}...`);
    tunnelInstance = cloudflared.Tunnel.quick(`http://127.0.0.1:${port}`);

    function notifyUrl(url) {
      if (!cloudflareTunnelUrl) {
        cloudflareTunnelUrl = url;
        console.log('\n' + '*'.repeat(74));
        console.log('  🔥 CLOUDFLARE TRYCLOUDFLARE TUNNEL IS ONLINE! 🔥');
        console.log('  ');
        console.log(`  👉  ${url}  👈`);
        console.log('  ');
        console.log('  The URL above is publicly accessible from anywhere in the world!');
        console.log('*'.repeat(74) + '\n');
      }
    }

    // Event emitted by TryCloudflareHandler
    tunnelInstance.on('url', (url) => {
      notifyUrl(url);
    });

    // Fallback regex scanner on stderr/stdout
    const parseOutput = (text) => {
      if (!text) return;
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) {
        notifyUrl(match[0]);
      }
    };

    tunnelInstance.on('stdout', parseOutput);
    tunnelInstance.on('stderr', parseOutput);

    tunnelInstance.on('error', (err) => {
      console.error('[Cloudflare Warning/Error]:', err.message || err);
    });

    tunnelInstance.on('exit', (code, signal) => {
      console.log(`[Cloudflare Tunnel process stopped] code=${code} signal=${signal}`);
    });

  } catch (error) {
    console.error('[Cloudflare Tunnel Init Error]:', error.message || error);
    console.log('[Notice] Azure Web App server is running normally.');
  }
}

// Graceful termination
function shutdown(signal) {
  console.log(`\nCaught ${signal}. Terminating gracefully...`);
  if (tunnelInstance && typeof tunnelInstance.stop === 'function') {
    try {
      tunnelInstance.stop();
      console.log('[Cloudflare] Tunnel stopped.');
    } catch (e) {}
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
