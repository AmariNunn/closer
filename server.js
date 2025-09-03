const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// SkyIQ API configuration
const SKYIQ_API_KEY = 'skyiq_3_1756755581321_uthzi8f52i';
const SKYIQ_BASE_URL = 'https://skyiq.app/api';
const BUSINESS_ID = '3';

// Cache for business data and prompts
let cachedBusinessData = null;
let cachedPrompt = null;

// Function to get business data from SkyIQ
async function getBusinessData() {
  if (!cachedBusinessData) {
    try {
      const response = await fetch(`${SKYIQ_BASE_URL}/business/${BUSINESS_ID}`);
      cachedBusinessData = await response.json();
      console.log('Business data loaded:', cachedBusinessData?.name || 'Unknown business');
    } catch (error) {
      console.error('Failed to fetch business data:', error);
      cachedBusinessData = { name: 'Tri Creative Group' };
    }
  }
  return cachedBusinessData;
}

// Function to get voice prompt from SkyIQ API
async function getVoicePrompt() {
  if (!cachedPrompt) {
    try {
      const response = await fetch(`${SKYIQ_BASE_URL}/voice-prompt/${BUSINESS_ID}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': SKYIQ_API_KEY
        },
        body: JSON.stringify({
          callType: 'inbound',
          customerIntent: 'general inquiry',
          urgency: 'medium',
          specificTopic: 'general'
        })
      });

      if (!response.ok) {
        throw new Error(`SkyIQ API error: ${response.status}`);
      }

      const data = await response.json();
      cachedPrompt = data.prompt;
      console.log('Voice prompt loaded from SkyIQ');
      
    } catch (error) {
      console.error('Failed to get voice prompt:', error);
      cachedPrompt = `You are a professional assistant for Tri Creative Group. We sell custom apparel - shirts, mugs, and pens are our specialty. Shirts cost about $20 and mugs cost about $10, but prices vary. Speak clearly and naturally. Help customers with their inquiries and provide information about our services. Be conversational and helpful.`;
    }
  }
  return cachedPrompt;
}

// Load data on startup
getBusinessData();
getVoicePrompt();

// Status page
app.get('/', (req, res) => {
  res.send(`
    <h1>AI Business Assistant (11Labs + SkyIQ)</h1>
    <h2>Status: Running</h2>
    <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
    <p><strong>11Labs Key:</strong> ${process.env.ELEVENLABS_API_KEY ? 'Set' : 'Missing'}</p>
    <p><strong>Twilio:</strong> ${process.env.TWILIO_AUTH_TOKEN ? 'Set' : 'Missing'}</p>
    <p><strong>SkyIQ:</strong> Connected</p>
    <div>
      <a href="/test-skyiq">Test SkyIQ Data</a>
    </div>
  `);
});

// Test SkyIQ API connection
app.get('/test-skyiq', async (req, res) => {
  try {
    const businessData = await getBusinessData();
    const prompt = await getVoicePrompt();
    
    res.json({ 
      status: 'SUCCESS', 
      businessData: businessData,
      prompt: prompt.substring(0, 200) + '...'
    });
  } catch (error) {
    res.status(500).json({ status: 'FAILED', error: error.message });
  }
});

// Twilio voice webhook
app.post('/twiml', (req, res) => {
  const host = req.get('host');
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;

  res.type('text/xml').send(twiml);
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// WebSocket server for voice streaming
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', async (ws) => {
  console.log('New Twilio WebSocket connection');
  let streamSid = '';

  // Get prompt from SkyIQ API
  const instructions = await getVoicePrompt();
  console.log('Using SkyIQ prompt for this call');

  // Connect to 11Labs Realtime API
  const elevenWs = new WebSocket(
    'wss://api.elevenlabs.io/v1/realtime/ws?model=eleven_monolingual_v1',
    {
      headers: {
        'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}`
      }
    }
  );

  elevenWs.on('open', () => {
    console.log('11Labs WebSocket connected');

    // Initialize session with SkyIQ prompt
    elevenWs.send(JSON.stringify({
      type: 'session',
      session: {
        voice: 'Rachel',
        conversation: instructions,
        input_format: 'g711_ulaw',
        output_format: 'g711_ulaw'
      }
    }));
  });

  // Handle Twilio messages
  ws.on('message', (data) => {
    const message = JSON.parse(data);

    if (message.event === 'start') {
      streamSid = message.start.streamSid;
      console.log('Stream started:', streamSid);
    } else if (message.event === 'media') {
      if (elevenWs.readyState === WebSocket.OPEN) {
        // Forward audio to 11Labs
        elevenWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: message.media.payload
        }));
        // Commit after each chunk
        elevenWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      }
    }
  });

  // Handle 11Labs responses
  elevenWs.on('message', (data) => {
    const message = JSON.parse(data);

    if (message.type === 'output_audio_buffer.delta') {
      ws.send(JSON.stringify({
        event: 'media',
        streamSid: streamSid,
        media: { payload: message.audio }
      }));
    }
  });

  // Handle closes and errors
  ws.on('close', () => {
    console.log('Twilio WebSocket closed');
    elevenWs.close();
  });

  elevenWs.on('close', () => {
    console.log('11Labs WebSocket closed');
    ws.close();
  });

  elevenWs.on('error', (error) => {
    console.error('11Labs WebSocket error:', error);
    ws.close();
  });
});
