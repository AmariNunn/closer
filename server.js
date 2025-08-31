const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Status page
app.get('/', (req, res) => {
  res.send(`
    <h1>Moving Company AI Agent</h1>
    <h2>Status: Running</h2>
    <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
    <p><strong>OpenAI Key:</strong> ${process.env.OPENAI_API_KEY ? 'Set' : 'Missing'}</p>
    <p><strong>Twilio:</strong> ${process.env.TWILIO_AUTH_TOKEN ? 'Set' : 'Missing'}</p>
    <a href="/test-ai">Test OpenAI</a>
  `);
});

// Test OpenAI connection
app.get('/test-ai', async (req, res) => {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Say "Hello from moving company AI"' }],
        max_tokens: 20
      })
    });
    
    const data = await response.json();
    res.send(`<h1>OpenAI Test: SUCCESS</h1><p>${data.choices[0].message.content}</p>`);
  } catch (error) {
    res.status(500).send(`OpenAI Test Failed: ${error.message}`);
  }
});

// Twilio voice webhook
app.post('/twiml', (req, res) => {
  const host = req.get('host');
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Please wait while we connect to the AI voice assistant.</Say>
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

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');
  
  let streamSid = '';
  
  // Connect to OpenAI Realtime API
  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });
  
  openaiWs.on('open', () => {
    console.log('OpenAI WebSocket connected');
    
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        model: 'gpt-4o-realtime-preview-2024-10-01',
        voice: 'alloy',
        instructions: 'You are a voice agent for a moving company. Greet warmly, ask for name, from/to addresses, moving date, items. Confirm and end.',
        temperature: 0.8,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw'
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
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: message.media.payload
        }));
      }
    }
  });
  
  // Handle OpenAI responses
  openaiWs.on('message', (data) => {
    const message = JSON.parse(data);
    
    if (message.type === 'response.audio.delta') {
      ws.send(JSON.stringify({
        event: 'media',
        streamSid: streamSid,
        media: { payload: message.delta }
      }));
    } else if (message.type === 'input_audio_buffer.speech_started') {
      ws.send(JSON.stringify({
        event: 'clear',
        streamSid: streamSid
      }));
    }
  });
  
  // Handle closes and errors
  ws.on('close', () => {
    console.log('Twilio WebSocket closed');
    openaiWs.close();
  });
  
  openaiWs.on('close', () => {
    console.log('OpenAI WebSocket closed');
    ws.close();
  });
  
  openaiWs.on('error', (error) => {
    console.error('OpenAI WebSocket error:', error);
    ws.close();
  });
});