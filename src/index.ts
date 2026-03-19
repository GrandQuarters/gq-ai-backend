import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { gmailService } from './services/gmail.service';
import { databaseService } from './services/database.service';
import { messageMonitorService } from './services/message-monitor.service';
import { openAIService } from './services/openai.service';
import { emailParserService } from './services/email-parser.service';
import { whatsappService } from './services/whatsapp.service';
import { whatsappMonitorService } from './services/whatsapp-monitor.service';

dotenv.config();

process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((u) => u.trim().replace(/\/+$/, ''));
console.log('🌐 CORS allowed origins:', allowedOrigins);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'GQ-AI Backend running' });
});

// Get all conversations
app.get('/api/conversations', async (req, res) => {
  try {
    const conversations = await databaseService.getConversations();
    const contacts = await databaseService.getContacts();
    const lastMessageTimes = await databaseService.getLastMessageTimes();

    const result = conversations.map((conv) => {
      const contact = contacts.find((c) => c.id === conv.contact_id);
      const lastMsgTime = lastMessageTimes[conv.id];
      return {
        id: conv.id,
        name: contact?.name || 'Unknown Guest',
        avatar: contact?.avatar || '/Logos/Download.png',
        isGroup: false,
        participants: [],
        lastMessage: conv.last_message || '',
        lastMessageTime: lastMsgTime ? new Date(lastMsgTime) : (conv.updated_at ? new Date(conv.updated_at) : new Date()),
        unreadCount: conv.unread_count || 0,
        pinned: conv.is_pinned,
        online: false,
        readOnly: false,
      };
    });

    res.json(result);
  } catch (error) {
    console.error('❌ Error fetching conversations:', error);
    res.status(200).json([]);
  }
});

// Get messages for a conversation
app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const messages = await databaseService.getMessagesByConversation(req.params.id);
    const result = messages.map((msg) => ({
      id: msg.id,
      content: msg.content,
      originalContent: msg.original_content || null,
      senderId: msg.sender_id,
      senderName: msg.sender_name,
      senderAvatar: msg.sender_avatar,
      timestamp: new Date(msg.sent_at),
      isOwn: msg.is_own,
      reactions: [],
      attachments: [],
    }));

    res.json(result);
  } catch (error: any) {
    // #region agent log
    console.error(`📋 GET /messages ERROR for ${req.params.id}:`, error?.message || error);
    // #endregion
    console.error('❌ Error fetching messages:', error);
    res.status(200).json([]);
  }
});

// Get raw email data for a message
app.get('/api/messages/:id/raw', async (req, res) => {
  try {
    const message = await databaseService.getMessageById(req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    if (!message.raw_email_data) {
      return res.json({ hasRawData: false });
    }
    const rawData = JSON.parse(message.raw_email_data);
    return res.json({ hasRawData: true, ...rawData });
  } catch (error) {
    console.error('❌ Error fetching raw email:', error);
    res.status(500).json({ error: 'Failed to fetch raw email data' });
  }
});

// Mark conversation as read (reset unread count)
app.post('/api/conversations/:id/read', async (req, res) => {
  try {
    await databaseService.updateConversation(req.params.id, { unread_count: 0 });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error marking conversation as read:', error);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// Send a message (reply to email or WhatsApp)
app.post('/api/messages/send', async (req, res) => {
  try {
    const { conversationId, content } = req.body;

    if (!conversationId || !content) {
      return res.status(400).json({ error: 'Missing conversationId or content' });
    }

    // Get conversation
    const conversations = await databaseService.getConversations();
    const conversation = conversations.find((c) => c.id === conversationId);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    console.log(`📤 Reply for conversation: ${conversationId}, contact_id: ${conversation.contact_id}`);

    // Get contact info
    const contacts = await databaseService.getContacts();
    const contact = contacts.find((c) => c.id === conversation.contact_id);

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // Check platform and send accordingly
    if (conversation.platform === 'whatsapp') {
      // Send via WhatsApp
      const phoneNumber = conversation.platform_conversation_hash || contact.phone_number;
      if (!phoneNumber) {
        return res.status(400).json({ error: 'No phone number found for WhatsApp contact' });
      }

      const success = await whatsappService.sendMessage(phoneNumber, content);
      
      if (!success) {
        return res.status(500).json({ error: 'Failed to send WhatsApp message' });
      }

      console.log(`✅ Sent WhatsApp reply to ${contact.name} at ${phoneNumber}`);
    } else {
      // Send via Gmail (existing logic)
      const messages = await databaseService.getMessagesByConversation(conversationId);
      const firstMessage = messages[0];

      if (!firstMessage || !firstMessage.external_message_id) {
        return res.status(400).json({ error: 'Cannot reply: No original email found' });
      }

      const originalGmailMsg = await gmailService.getMessage(firstMessage.external_message_id);
      const originalMessageId = await gmailService.getMessageIdHeader(firstMessage.external_message_id);

      console.log(`📤 Sending reply to: ${contact.email} (Contact: ${contact.name})`);
      
      await gmailService.sendReply(
        contact.email || '',
        `${originalGmailMsg.subject}`,
        content,
        conversation.email_thread_id || '',
        originalMessageId || firstMessage.external_message_id || ''
      );
      
      console.log(`✅ Sent reply to ${contact.name} at ${contact.email} via Gmail`);
    }

    // Save message to database
    const savedMessage = await databaseService.createMessage({
      conversation_id: conversationId,
      content,
      original_content: null,
      raw_email_data: null,
      sender_id: 'admin',
      sender_name: 'Admin',
      sender_avatar: '/Logos/Download.png',
      sent_at: new Date().toISOString(),
      is_own: true,
      external_message_id: null,
    });

    // Update conversation
    await databaseService.updateConversation(conversationId, {
      last_message: content.substring(0, 100),
      action_required: false,
    });

    // Clear pending AI responses for this conversation
    await databaseService.supersedePendingAiResponses(conversationId);

    // Save training example: guest messages this reply addresses + the admin reply
    try {
      const allMsgs = await databaseService.getMessagesByConversation(conversationId);
      const msgsBeforeReply = allMsgs.filter((m) => m.id !== savedMessage.id);
      let lastOwnIdx = -1;
      for (let i = msgsBeforeReply.length - 1; i >= 0; i--) {
        if (msgsBeforeReply[i].is_own) { lastOwnIdx = i; break; }
      }
      const unansweredGuest = msgsBeforeReply
        .slice(lastOwnIdx + 1)
        .filter((m) => !m.is_own);

      if (unansweredGuest.length > 0) {
        const guestBlock = unansweredGuest.map((m) => {
          const text = m.original_content || m.content;
          return `[${new Date(m.sent_at).toLocaleString('de-DE')}] ${text}`;
        }).join('\n');

        await databaseService.saveTrainingExample({
          conversation_id: conversationId,
          platform: conversation.platform,
          guest_name: contact.name,
          guest_messages: guestBlock,
          admin_reply: content,
        });
        console.log(`📚 Training example saved: ${unansweredGuest.length} guest msg(s) → admin reply`);
      }
    } catch (trainErr: any) {
      console.warn('⚠️ Failed to save training example:', trainErr.message);
    }

    res.json({ success: true, messageId: savedMessage.id });
  } catch (error) {
    console.error('❌ Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Translate or re-translate a message
app.post('/api/messages/:id/retry-translation', async (req, res) => {
  try {
    const message = await databaseService.getMessageById(req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const sourceText = message.original_content || message.content;

    console.log(`🌐 Translating message ${req.params.id}...`);
    const translated = await openAIService.translateToGerman(sourceText);

    if (!translated || translated.startsWith('⚠️')) {
      return res.status(502).json({ error: translated || 'Translation failed' });
    }

    await databaseService.updateMessage(req.params.id, {
      content: translated,
      original_content: sourceText,
    });

    console.log(`✅ Translation saved for message ${req.params.id}`);
    res.json({ content: translated, originalContent: sourceText });
  } catch (error: any) {
    console.error('❌ Error retrying translation:', error);
    res.status(500).json({ error: error.message || 'Translation failed' });
  }
});

// Re-parse a message from its stored raw email data
app.post('/api/messages/:id/reparse', async (req, res) => {
  try {
    const message = await databaseService.getMessageById(req.params.id);
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }
    if (!message.raw_email_data) {
      return res.status(400).json({ error: 'No raw email data stored for this message' });
    }

    const rawData = JSON.parse(message.raw_email_data);

    const gmailMessage = {
      id: rawData.gmailId || '',
      threadId: rawData.threadId || '',
      from: rawData.from || '',
      to: rawData.to || '',
      subject: rawData.subject || '',
      body: rawData.body || '',
      timestamp: new Date(),
      platform: rawData.platform as any,
      replyTo: rawData.replyTo || undefined,
    };

    const parsed = emailParserService.parseEmail(gmailMessage);
    console.log(`🔄 Reparsed message ${req.params.id}: "${parsed.message.substring(0, 80)}..."`);

    await databaseService.updateMessage(req.params.id, {
      content: parsed.message,
      original_content: null,
    });

    // Update contact name if parser found a better one
    if (parsed.customerName && parsed.customerName !== 'Airbnb Guest' && parsed.customerName !== 'Booking.com Guest') {
      const conversation = (await databaseService.getConversations()).find(
        (c) => c.id === message.conversation_id
      );
      if (conversation) {
        const contacts = await databaseService.getContacts();
        const contact = contacts.find((c) => c.id === conversation.contact_id);
        if (contact && (contact.name === 'Airbnb Guest' || contact.name === 'Booking.com Guest' || contact.name === 'Expedia Guest' || contact.name === 'Guest')) {
          await databaseService.updateContact(contact.id, { name: parsed.customerName });
          console.log(`👤 Updated contact name: ${contact.name} → ${parsed.customerName}`);
        }
      }
    }

    res.json({ content: parsed.message, originalContent: null });
  } catch (error: any) {
    console.error('❌ Error reparsing message:', error);
    res.status(500).json({ error: error.message || 'Reparse failed' });
  }
});

// Generate AI response for a conversation (re-process as if message just arrived)
app.post('/api/conversations/:id/generate-ai', async (req, res) => {
  try {
    const conversationId = req.params.id;

    const conversations = await databaseService.getConversations();
    const conversation = conversations.find((c) => c.id === conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const contacts = await databaseService.getContacts();
    const contact = contacts.find((c) => c.id === conversation.contact_id);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const allMessages = await databaseService.getMessagesByConversation(conversationId);
    if (allMessages.length === 0) {
      return res.status(400).json({ error: 'No messages in conversation' });
    }

    const lastGuestMsg = [...allMessages].reverse().find((m) => !m.is_own);
    const guestContext: import('./services/openai.service').GuestContext = {
      guestName: contact.name,
      guestPhone: contact.phone_number || '',
      guestEmail: contact.email || '',
      guestLanguage: 'Englisch',
      numberOfGuests: '',
      apartmentName: conversation.property_name || '',
      apartmentAddress: '',
      bookingPlatform: conversation.platform,
      bookingId: '',
      checkinDate: '',
      checkinTime: '15:00',
      checkoutDate: '',
      checkoutTime: '11:00',
      numberOfNights: '',
      stayStatus: 'unknown',
    };

    console.log(`🤖 Manually generating AI response for conversation ${conversationId} (${contact.name})`);
    await databaseService.supersedePendingAiResponses(conversationId);
    const aiResponse = await openAIService.generateResponse(guestContext, allMessages);
    console.log('🤖 AI Response:', aiResponse);

    if (aiResponse && !aiResponse.startsWith('⚠️')) {
      await databaseService.createAiResponse({
        conversation_id: conversationId,
        content: aiResponse,
        source_message_ids: lastGuestMsg ? [lastGuestMsg.id] : [],
        unanswered_message_count: 1,
        model: 'gpt-5-mini-2025-08-07',
      });
    }

    res.json({ aiSuggestion: aiResponse });
  } catch (error: any) {
    console.error('❌ Error generating AI response:', error);
    res.status(500).json({ error: error.message || 'Failed to generate AI response' });
  }
});

// Get pending AI suggestion for a conversation
app.get('/api/conversations/:id/pending-ai', async (req, res) => {
  try {
    const pending = await databaseService.getPendingAiResponse(req.params.id);
    if (!pending) {
      return res.json({ aiSuggestion: null });
    }
    res.json({ aiSuggestion: pending.content, aiResponseId: pending.id });
  } catch (error) {
    console.error('❌ Error fetching pending AI response:', error);
    res.status(500).json({ error: 'Failed to fetch pending AI response' });
  }
});

// Get conversation IDs with pending AI suggestions
app.get('/api/pending-ai-ids', async (req, res) => {
  try {
    const ids = await databaseService.getPendingAiConversationIds();
    res.json(ids);
  } catch (error) {
    console.error('❌ Error fetching pending AI IDs:', error);
    res.status(200).json([]);
  }
});

// Get action required conversation IDs
app.get('/api/action-required', async (req, res) => {
  try {
    const conversations = await databaseService.getConversations();
    const actionRequiredIds = conversations
      .filter((c) => c.action_required)
      .map((c) => c.id);
    
    res.json(actionRequiredIds);
  } catch (error) {
    console.error('❌ Error fetching action required:', error);
    res.status(200).json([]);
  }
});

// WhatsApp webhook verification (GET)
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('📱 WhatsApp webhook verification request');

  if (typeof mode === 'string' && typeof token === 'string' && typeof challenge === 'string') {
    const result = whatsappService.verifyWebhook(mode, token, challenge);
    if (result) {
      return res.status(200).send(result);
    }
  }

  res.sendStatus(403);
});

// WhatsApp webhook for incoming messages (POST)
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    console.log('📱 WhatsApp webhook received');

    // Parse the incoming message
    const parsed = whatsappService.parseWebhookPayload(req.body);

    if (parsed) {
      // Process the message asynchronously
      whatsappMonitorService.processIncomingMessage(
        parsed.from,
        parsed.messageId,
        parsed.messageContent,
        parsed.timestamp
      ).catch(err => {
        console.error('❌ Error processing WhatsApp message:', err);
      });
    }

    // Always respond 200 immediately to WhatsApp
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error in WhatsApp webhook:', error);
    res.sendStatus(500);
  }
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 GQ-AI Backend running on http://localhost:${PORT}`);
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  messageMonitorService.addWebSocketClient(ws);
  whatsappMonitorService.addWebSocketClient(ws);
});

// Startup diagnostics
console.log('┌──────────────────────────────────────');
console.log('│ 🔧 ENVIRONMENT CONFIG');
console.log('├──────────────────────────────────────');
console.log('│ PORT:              ', process.env.PORT || '4000 (default)');
console.log('│ NODE_ENV:          ', process.env.NODE_ENV || 'not set');
console.log('│ FRONTEND_URL:      ', process.env.FRONTEND_URL || 'http://localhost:3000 (default)');
console.log('│ SUPABASE_URL:      ', process.env.SUPABASE_URL ? '✅ set' : '❌ MISSING');
console.log('│ SUPABASE_KEY:      ', process.env.SUPABASE_SERVICE_KEY ? '✅ set' : '❌ MISSING');
console.log('│ OPENAI_API_KEY:    ', process.env.OPENAI_API_KEY ? '✅ set' : '❌ MISSING');
console.log('│ GMAIL_USER:        ', process.env.GMAIL_USER || '❌ MISSING');
console.log('│ GOOGLE_CLIENT_ID:  ', process.env.GOOGLE_CLIENT_ID ? '✅ set' : '⚠️  not set (using credentials.json)');
console.log('│ GOOGLE_REFRESH:    ', process.env.GOOGLE_REFRESH_TOKEN ? '✅ set' : '⚠️  not set (using token.json)');
console.log('└──────────────────────────────────────');

// Start Gmail monitoring
async function startMonitoring() {
  try {
    await gmailService.initialize();
    console.log('✅ Gmail service initialized');
    
    await messageMonitorService.start();
    console.log('✅ Message monitoring started');
  } catch (error: any) {
    console.error('❌ Failed to start Gmail monitoring:', error.message);
    console.log('⚠️  Server is still running — API endpoints work, but email polling is disabled.');
    console.log('   To fix: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN env vars');
    console.log('   Or run `npm run auth` locally to generate token.json\n');
  }
}

startMonitoring();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  messageMonitorService.stop();
  server.close();
  process.exit(0);
});

