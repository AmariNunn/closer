const express = require('express');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuration
const ELEVENLABS_AGENT_ID = 'agent_0601k48kfwszftatpy3eh4rp0wa4';
const SKYIQ_API_KEY = 'skyiq_3_1756755581321_uthzi8f52i';
const SKYIQ_BASE_URL = 'https://skyiq.app/api';
const BUSINESS_ID = '3';

// Function to get voice prompt from SkyIQ API
async function getVoicePrompt(callContext = {}) {
  try {
    const response = await fetch(`${SKYIQ_BASE_URL}/voice-prompt/${BUSINESS_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': SKYIQ_API_KEY
      },
      body: JSON.stringify({
        callType: callContext.callType || 'inbound',
        customerIntent: callContext.customerIntent || 'general inquiry',
        urgency: callContext.urgency || 'medium',
        specificTopic: callContext.specificTopic || 'general'
      })
    });

    if (!response.ok) {
      throw new Error(`SkyIQ API error: ${response.status}`);
    }

    const data = await response.json();
    console.log('Voice prompt fetched from SkyIQ');
    return data.prompt;
    
  } catch (error) {
    console.error('Failed to get voice prompt:', error);
    return null;
  }
}

// Status page
app.get('/', (req, res) => {
  res.send(`
    <h1>AI Voice Agent</h1>
    <h2>Status: Running</h2>
    <p><strong>11Labs Key:</strong> ${process.env.ELEVENLABS_API_KEY ? 'Set' : 'Missing'}</p>
    <p><strong>Agent ID:</strong> ${ELEVENLABS_AGENT_ID}</p>
    <div>
      <a href="/test-prompt">Test SkyIQ Prompt</a>
    </div>
  `);
});

// Test prompt generation
app.get('/test-prompt', async (req, res) => {
  try {
    const testContext = {
      callType: 'inbound',
      customerIntent: 'pricing inquiry',
      urgency: 'medium',
      specificTopic: 'custom shirts'
    };
    
    const prompt = await getVoicePrompt(testContext);
    res.json({ 
      status: 'SUCCESS', 
      context: testContext,
      prompt: prompt
    });
  } catch (error) {
    res.status(500).json({ status: 'FAILED', error: error.message });
  }
});

// Twilio webhook
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

// WebSocket server
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', async (ws) => {
  console.log('New call connected');
  let streamSid = '';

  // Get current context for this call
  const currentHour = new Date().getHours();
  const callContext = {
    callType: 'inbound',
    customerIntent: currentHour >= 9 && currentHour <= 17 ? 'general inquiry' : 'after hours inquiry',
    urgency: 'medium',
    specificTopic: 'general'
  };

  // Get fresh prompt from SkyIQ
  const prompt = await getVoicePrompt(callContext);
  console.log('Using SkyIQ prompt for this call');

  // Connect to 11Labs Conversational AI
  const elevenWs = new WebSocket(
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`,
    {
      headers: {
        'Authorization': `Bearer ${process.env.ELEVENLABS_API_KEY}`
      }
    }
  );

  elevenWs.on('open', () => {
    console.log('11Labs agent connected');
    
    // Send configuration with SkyIQ prompt and ensure first message
    const config = {
      type: 'conversation_initiation_client_data',
      conversation_config_override: {
        agent: {
          first_message: "Hi there! How can I help you today?"
        }
      }
    };

    if (prompt) {
      config.conversation_config_override.agent.prompt = { prompt: prompt };
      console.log('Sending SkyIQ prompt to agent');
    }

    elevenWs.send(JSON.stringify(config));
  });

  // Handle Twilio messages
  ws.on('message', (data) => {
    const message = JSON.parse(data);

    if (message.event === 'start') {
      streamSid = message.start.streamSid;
      console.log('Stream started:', streamSid);
    } else if (message.event === 'media' && elevenWs.readyState === WebSocket.OPEN) {
      // Forward audio to 11Labs
      elevenWs.send(JSON.stringify({
        type: 'user_audio_chunk',
        user_audio_chunk: message.media.payload
      }));
    }
  });

  // Handle 11Labs responses
  elevenWs.on('message', (data) => {
    const message = JSON.parse(data);

    if (message.type === 'conversation_initiation_metadata') {
      console.log('Conversation initialized');
    } 
    else if (message.type === 'audio' && message.audio_event?.audio_base_64) {
      // Forward audio to Twilio
      ws.send(JSON.stringify({
        event: 'media',
        streamSid: streamSid,
        media: { payload: message.audio_event.audio_base_64 }
      }));
    }
    else if (message.type === 'user_transcript') {
      console.log('User said:', message.user_transcription_event.user_transcript);
    }
    else if (message.type === 'agent_response') {
      console.log('Agent responded:', message.agent_response_event.agent_response);
    }
    else if (message.type === 'ping') {
      // Respond to ping
      elevenWs.send(JSON.stringify({
        type: 'pong',
        event_id: message.ping_event.event_id
      }));
    }
  });

  // Handle connection cleanup
  ws.on('close', () => {
    console.log('Call ended');
    elevenWs.close();
  });

  elevenWs.on('close', () => {
    ws.close();
  });

  elevenWs.on('error', (error) => {
    console.error('11Labs error:', error);
    ws.close();
  });
});
