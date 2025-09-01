const express = require('express');
const WebSocket = require('ws');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Function to fetch business data from SkyIQ
async function fetchBusinessData() {
  try {
    const response = await fetch('https://skyiq.app/api/business/3');
    const businessData = await response.json();
    return businessData;
  } catch (error) {
    console.error('Error fetching business data:', error);
    return null;
  }
}

// Generate dynamic instructions based on business data
function generateInstructions(businessData) {
  if (!businessData) {
    return 'You are a professional business assistant. Speak clearly and naturally. Help customers with their inquiries and gather any necessary information. Be conversational and helpful.';
  }

  let instructions = `You are a professional assistant for ${businessData.name || 'this business'}. `;
  
  if (businessData.description) {
    instructions += `About the business: ${businessData.description}. `;
  }
  
  if (businessData.services && Array.isArray(businessData.services)) {
    instructions += `Our services include: ${businessData.services.join(', ')}. `;
  } else if (businessData.services) {
    instructions += `Our services: ${businessData.services}. `;
  }
  
  if (businessData.hours) {
    instructions += `Our business hours are: ${businessData.hours}. `;
  }
  
  if (businessData.phone) {
    instructions += `Our phone number is ${businessData.phone}. `;
  }
  
  if (businessData.email) {
    instructions += `Our email is ${businessData.email}. `;
  }
  
  if (businessData.address) {
    instructions += `Our location is: ${businessData.address}. `;
  }
  
  if (businessData.website) {
    instructions += `Our website is: ${businessData.website}. `;
  }

  instructions += `

Speak clearly and naturally. Help customers with their inquiries, provide information about our business, and gather any necessary contact information or details about their needs. Be conversational, helpful, and professional. Use the business information above to provide accurate details when asked.`;

  return instructions;
}

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
    const businessData = await fetchBusinessData();
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

// WebSocket server for voice streaming
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', async (ws) => {
  console.log('New Twilio WebSocket connection');
  
  // CRITICAL: Initialize streamSid as null
  let streamSid = null;
  
  // Fetch business data for this session
  const businessData = await fetchBusinessData();
  const instructions = generateInstructions(businessData);
  
  // Connect to OpenAI Realtime API
  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });
  
  openaiWs.on('open', () => {
    console.log('OpenAI WebSocket connected');
    
    // CRITICAL: Wait 250ms before sending session config
    setTimeout(() => {
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
    }, 250);
  });
  
  // Handle Twilio messages
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log('Received Twilio message:', message.event, message);
      
      switch (message.event) {
        case 'connected':
          console.log('Twilio Media Stream connected');
          break;
          
        case 'start':
          // CRITICAL: Extract streamSid correctly - try both locations
          streamSid = message.start?.streamSid || message.streamSid;
          console.log('Stream started with SID:', streamSid);
          if (!streamSid) {
            console.error('Failed to extract streamSid from message:', message);
          }
          break;
          
        case 'media':
          // Only forward audio if OpenAI is ready
          if (openaiWs.readyState === WebSocket.OPEN && message.media?.payload) {
            console.log('Forwarding audio to OpenAI');
            openaiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: message.media.payload
            }));
          } else {
            console.log('Cannot forward audio - OpenAI ready:', openaiWs.readyState === WebSocket.OPEN, 'payload present:', !!message.media?.payload);
          }
          break;
          
        case 'stop':
          console.log('Stream stopped');
          break;
      }
    } catch (error) {
      console.error('Error processing Twilio message:', error);
    }
  });
  
  // Handle OpenAI responses
  openaiWs.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      switch (message.type) {
        case 'session.created':
          console.log('OpenAI session created');
          break;
          
        case 'session.updated':
          console.log('OpenAI session updated');
          break;
          
        case 'input_audio_buffer.speech_started':
          // User started speaking - clear Twilio buffer
          if (streamSid) {
            console.log('User interruption detected');
            ws.send(JSON.stringify({
              event: 'clear',
              streamSid: streamSid
            }));
          }
          break;
          
        case 'response.audio.delta':
          // CRITICAL: Send audio response back to Twilio
          if (streamSid && message.delta) {
            console.log('Sending audio to Twilio, streamSid:', streamSid);
            ws.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: message.delta }
            }));
          } else {
            console.log('Cannot send audio - streamSid:', streamSid, 'delta present:', !!message.delta);
          }
          break;
          
        case 'response.audio.done':
          console.log('AI response complete');
          break;
          
        case 'error':
          console.error('OpenAI error:', message.error);
          break;
      }
    } catch (error) {
      console.error('Error processing OpenAI message:', error);
    }
  });
  
  // Handle connection cleanup
  ws.on('close', () => {
    console.log('Twilio WebSocket closed');
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
  
  openaiWs.on('close', () => {
    console.log('OpenAI WebSocket closed');
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });
  
  openaiWs.on('error', (error) => {
    console.error('OpenAI WebSocket error:', error);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });
});
