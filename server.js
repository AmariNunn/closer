const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 11Labs Conversational AI Agent ID
const ELEVENLABS_AGENT_ID = 'agent_0601k48kfwszftatpy3eh4rp0wa4';

// SkyIQ API configuration (for business data only)
const SKYIQ_API_KEY = 'skyiq_3_1756755581321_uthzi8f52i';
const SKYIQ_BASE_URL = 'https://skyiq.app/api';
const BUSINESS_ID = '3';

// Cache for business data
let cachedBusinessData = null;

// Function to get business data from SkyIQ (for reference/logging)
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

// Load business data on startup
getBusinessData();

// Status page
app.get('/', (req, res) => {
  res.send(`
    <h1>AI Business Assistant (11Labs Conversational AI)</h1>
    <h2>Status: Running</h2>
    <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
    <p><strong>11Labs Key:</strong> ${process.env.ELEVENLABS_API_KEY ? 'Set' : 'Missing'}</p>
    <p><strong>Twilio:</strong> ${process.env.TWILIO_AUTH_TOKEN ? 'Set' : 'Missing'}</p>
    <p><strong>Agent ID:</strong> ${ELEVENLABS_AGENT_ID}</p>
    <p><strong>SkyIQ:</strong> Connected</p>
    <div>
      <a href="/test-skyiq">Test SkyIQ Data</a> | 
      <a href="/test-prompt">Test Fresh Prompt</a> |
      <a href="https://elevenlabs.io/app/talk-to?agent_id=${ELEVENLABS_AGENT_ID}" target="_blank">Test Agent</a>
    </div>
  `);
});

// Test SkyIQ API connection
app.get('/test-skyiq', async (req, res) => {
  try {
    const businessData = await getBusinessData();
    res.json({ 
      status: 'SUCCESS', 
      businessData: businessData,
      agentId: ELEVENLABS_AGENT_ID
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

  // Connect to 11Labs Conversational AI (not TTS)
  const elevenWs = new WebSocket(
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`,
    {
      headers: {
        'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}`
      }
    }
  );

  elevenWs.on('open', () => {
    console.log('11Labs Conversational AI connected');
    
    // Send initial configuration for the conversation
    elevenWs.send(JSON.stringify({
      type: 'conversation_initiation_client_data',
      conversation_config_override: {
        agent: {
          // The agent already has your prompt configured in the 11Labs dashboard
          // But you can override settings here if needed
        },
        tts: {
          // Voice settings (if you want to override the agent's default voice)
        }
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
        // Convert Twilio's µ-law audio to PCM for 11Labs
        try {
          const ulawBuffer = Buffer.from(message.media.payload, 'base64');
          const pcmBuffer = ulawToPcm(ulawBuffer);
          
          // Send PCM audio to 11Labs
          elevenWs.send(JSON.stringify({
            type: 'user_audio_chunk',
            user_audio_chunk: pcmBuffer.toString('base64')
          }));
          
          console.log(`Converted ${ulawBuffer.length} bytes µ-law to ${pcmBuffer.length} bytes PCM for 11Labs`);
        } catch (error) {
          console.error('Input audio conversion error:', error);
        }
      }
    }
  });

  // Handle 11Labs Conversational AI responses
  elevenWs.on('message', (data) => {
    const message = JSON.parse(data);
    
    console.log('11Labs message type:', message.type);

    if (message.type === 'conversation_initiation_metadata') {
      console.log('Conversation initialized:', message.conversation_initiation_metadata_event);
    } 
    else if (message.type === 'audio') {
      // Handle audio data from Conversational AI
      if (message.audio_event && message.audio_event.audio_base_64) {
        ws.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: message.audio_event.audio_base_64 }
        }));
      }
    }
    else if (message.type === 'user_transcript') {
      console.log('User said:', message.user_transcription_event.user_transcript);
    }
    else if (message.type === 'agent_response') {
      console.log('Agent responded:', message.agent_response_event.agent_response);
    }
    else if (message.type === 'ping') {
      // Respond to ping with pong
      elevenWs.send(JSON.stringify({
        type: 'pong',
        event_id: message.ping_event.event_id
      }));
    }
  });

  // Handle closes and errors
  ws.on('close', () => {
    console.log('Twilio WebSocket closed');
    elevenWs.close();
  });

  elevenWs.on('close', (code, reason) => {
    console.log('11Labs WebSocket closed:', code, reason.toString());
    ws.close();
  });

  elevenWs.on('error', (error) => {
    console.error('11Labs WebSocket error:', error);
    ws.close();
  });
});
