const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Simple function to get basic business info (non-blocking)
let cachedBusinessData = null;
async function getCachedBusinessData() {
  if (!cachedBusinessData) {
    try {
      const response = await fetch('https://skyiq.app/api/business/3');
      cachedBusinessData = await response.json();
      console.log('Business data cached:', cachedBusinessData?.name || 'Unknown business');
    } catch (error) {
      console.error('Failed to fetch business data:', error);
      cachedBusinessData = { name: 'our business' }; // fallback
    }
  }
  return cachedBusinessData;
}

// Pre-cache business data on startup
getCachedBusinessData();

// Status page
app.get('/', (req, res) => {
  res.send(`
    <h1>AI Business Assistant</h1>
    <h2>Status: Running</h2>
    <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
    <p><strong>OpenAI Key:</strong> ${process.env.OPENAI_API_KEY ? 'Set' : 'Missing'}</p>
    <p><strong>Twilio:</strong> ${process.env.TWILIO_AUTH_TOKEN ? 'Set' : 'Missing'}</p>
    <a href="/test-ai">Test OpenAI</a> | <a href="/test-websocket">Test WebSocket</a> | <a href="/test-skyiq">Test SkyIQ</a>
  `);
});

// Test SkyIQ API connection
app.get('/test-skyiq', async (req, res) => {
  try {
    const businessData = await getCachedBusinessData();
    res.json({ status: 'SUCCESS', data: businessData });
  } catch (error) {
    res.status(500).json({ status: 'FAILED', error: error.message });
  }
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
        messages: [{ role: 'user', content: 'Say "Hello from AI business assistant"' }],
        max_tokens: 20
      })
    });
    
    const data = await response.json();
    res.send(`<h1>OpenAI Test: SUCCESS</h1><p>${data.choices[0].message.content}</p>`);
  } catch (error) {
    res.status(500).send(`OpenAI Test Failed: ${error.message}`);
  }
});

// Test WebSocket connection to OpenAI
app.get('/test-websocket', (req, res) => {
  const testWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });
  
  testWs.on('open', () => {
    console.log('WebSocket test: Connected to OpenAI');
    res.json({ status: 'SUCCESS', message: 'WebSocket to OpenAI works!' });
    testWs.close();
  });
  
  testWs.on('error', (error) => {
    console.error('WebSocket test error:', error);
    res.json({ status: 'FAILED', error: error.message });
  });
  
  setTimeout(() => {
    if (testWs.readyState === WebSocket.CONNECTING) {
      testWs.close();
      res.json({ status: 'TIMEOUT', message: 'WebSocket connection timed out' });
    }
  }, 5000);
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

// WebSocket server for voice streaming - KEEPING THE WORKING VERSION
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');
  
  let streamSid = '';
  
  // Get cached business data (no await needed since it's cached)
  const businessData = cachedBusinessData || { name: 'our business' };
  
  // Simple instructions with business name
  const instructions = `You are a professional assistant for ${businessData.name || 'our business'}. Speak clearly and naturally. Help customers with their inquiries and provide information about our services. Be conversational and helpful.`;
  
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
        instructions: instructions,
        temperature: 0.7,
        max_response_output_tokens: 4096,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 200
        }
      }
    }));
  });
  
  // Handle Twilio messages - EXACT SAME AS WORKING VERSION
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
  
  // Handle OpenAI responses - EXACT SAME AS WORKING VERSION
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
  
  // Handle closes and errors - EXACT SAME AS WORKING VERSION
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
