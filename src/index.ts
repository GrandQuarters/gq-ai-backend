import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { gmailService } from './services/gmail.service';
import { supabaseDatabaseService as databaseService } from './services/supabase-database.service';
import { messageMonitorService } from './services/message-monitor.service';
import { openAIService } from './services/openai.service';
import { whatsappService } from './services/whatsapp.service';
import { whatsappMonitorService } from './services/whatsapp-monitor.service';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000' }));
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

    const result = conversations.map((conv) => {
      const contact = contacts.find((c) => c.id === conv.contact_id);
      return {
        id: conv.id,
        name: contact?.name || 'Unknown Guest',
        avatar: contact?.avatar || '/Logos/Download.png',
        isGroup: false,
        participants: [],
        lastMessage: conv.last_message || '',
        lastMessageTime: conv.updated_at ? new Date(conv.updated_at) : new Date(),
        unreadCount: conv.unread_count || 0,
        pinned: conv.is_pinned,
        online: false,
        readOnly: false,
      };
    });

    res.json(result);
  } catch (error) {
    console.error('❌ Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// Get messages for a conversation
app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const messages = await databaseService.getMessagesByConversation(req.params.id);
    const result = messages.map((msg) => ({
      id: msg.id,
      content: msg.content,
      senderId: msg.sender_id,
      senderName: msg.sender_name,
      senderAvatar: msg.sender_avatar,
      timestamp: new Date(msg.sent_at),
      isOwn: msg.is_own,
      reactions: [],
      attachments: [],
    }));

    res.json(result);
  } catch (error) {
    console.error('❌ Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
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
        `Re: ${originalGmailMsg.subject}`,
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

    res.json({ success: true, messageId: savedMessage.id });
  } catch (error) {
    console.error('❌ Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
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
    res.status(500).json({ error: 'Failed to fetch action required' });
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

// Start Gmail monitoring
async function startMonitoring() {
  try {
    await gmailService.initialize();
    console.log('✅ Gmail service initialized');
    
    await messageMonitorService.start();
    console.log('✅ Message monitoring started');
  } catch (error) {
    console.error('❌ Failed to start monitoring:', error);
    console.log('\n⚠️  Please run authentication first:');
    console.log('   npm run auth\n');
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

