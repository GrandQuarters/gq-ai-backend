import { gmailService } from './gmail.service';
import { emailParserService } from './email-parser.service';
import { supabaseDatabaseService as databaseService } from './supabase-database.service';
import { openAIService } from './openai.service';
import { WebSocket } from 'ws';

export class MessageMonitorService {
  private isRunning = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private wsClients: Set<WebSocket> = new Set();

  addWebSocketClient(ws: WebSocket): void {
    this.wsClients.add(ws);
    console.log(`📱 WebSocket client connected. Total clients: ${this.wsClients.size}`);

    ws.on('close', () => {
      this.wsClients.delete(ws);
      console.log(`📱 WebSocket client disconnected. Total clients: ${this.wsClients.size}`);
    });
  }

  private broadcast(data: any): void {
    const message = JSON.stringify(data);
    this.wsClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('⚠️  Monitor already running');
      return;
    }

    this.isRunning = true;
    console.log('🚀 Starting email monitor...');

    // Initial check
    await this.checkForNewMessages();

    // Poll every 30 seconds
    this.pollInterval = setInterval(() => {
      this.checkForNewMessages();
    }, 30000);

    console.log('✅ Email monitor started (polling every 30 seconds)');
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.isRunning = false;
    console.log('🛑 Email monitor stopped');
  }

  private async checkForNewMessages(): Promise<void> {
    try {
      console.log('📬 Checking for new messages...');
      const newMessages = await gmailService.getNewMessages();

      for (const gmailMessage of newMessages) {
        // Skip if already processed
        if (await databaseService.isMessageProcessed(gmailMessage.id)) {
          continue;
        }

        console.log(`📨 New message from ${gmailMessage.platform}:`, gmailMessage.subject);

        // Parse email
        const parsed = emailParserService.parseEmail(gmailMessage);
        
        console.log('👤 Customer:', parsed.customerName);
        console.log('📨 Original From:', parsed.originalFrom);
        console.log('💬 Message:', parsed.message);
        console.log('⏰ Time:', parsed.timestamp);
        
        // Get platform logo
        const platformLogos: Record<string, string> = {
          airbnb: '/Logos/airbnb-logo.png',
          booking: '/Logos/png-clipart-computer-icons-booking-com-hotel-accommodation-veyli-residence-others-miscellaneous-blue-thumbnail.png',
          expedia: '/Logos/png-clipart-logo-expedia-hotel-travel-discounts-and-allowances-hotel-blue-text.png',
          fewo: '/Logos/Download.png',
          whatsapp: '/Logos/whatsapp-logo.png',
          unknown: '/Logos/Download.png',
        };

        // Extract clean email address from "From" header
        const extractEmail = (fromHeader: string): string => {
          // Handle formats like: "Name <email@domain.com>" or just "email@domain.com"
          const match = fromHeader.match(/<([^>]+)>/);
          if (match) return match[1];
          
          // If no angle brackets, assume it's just the email
          const emailMatch = fromHeader.match(/[\w.-]+@[\w.-]+\.\w+/);
          return emailMatch ? emailMatch[0] : fromHeader;
        };

        // For Airbnb, use the specific reply-to email with hash
        const emailToUse = parsed.replyToEmail || extractEmail(parsed.originalFrom);
        console.log('📧 Email to use for contact:', emailToUse);
        
        // For Airbnb with hash, log the hash
        if (parsed.platformConversationHash) {
          console.log('🔑 Airbnb conversation hash:', parsed.platformConversationHash);
        }

        // Find or create contact (match by email first, then by name+platform)
        let contact = await databaseService.getContactByEmail(emailToUse);
        if (!contact) {
          contact = await databaseService.getContactByNameAndPlatform(parsed.customerName, parsed.platform);
        }
        if (!contact) {
          contact = await databaseService.createContact({
            name: parsed.customerName,
            platform: parsed.platform,
            email: emailToUse,
            phone_number: null,
            avatar: platformLogos[parsed.platform] || platformLogos.unknown,
          });
          console.log(`👤 Created new contact: ${contact.name} (${emailToUse})`);
        }

        // Find or create conversation
        // For Airbnb, match by hash first, then by thread ID
        let conversation = parsed.platformConversationHash 
          ? await databaseService.getConversationByPlatformHash(parsed.platformConversationHash)
          : null;
        
        if (!conversation) {
          conversation = await databaseService.getConversationByThreadId(parsed.threadId);
        }
        
        if (!conversation) {
          conversation = await databaseService.createConversation({
            contact_id: contact.id,
            platform: parsed.platform,
            email_thread_id: parsed.threadId,
            platform_conversation_hash: parsed.platformConversationHash || null,
            last_message: parsed.message.substring(0, 100),
            unread_count: 1,
            is_pinned: false,
            action_required: openAIService.detectActionRequired(parsed.message),
          });
          console.log(`💬 Created new conversation: ${conversation.id}${parsed.platformConversationHash ? ' with hash: ' + parsed.platformConversationHash : ''}`);
        } else {
          // Update existing conversation
          const actionRequired = openAIService.detectActionRequired(parsed.message);
          await databaseService.updateConversation(conversation.id, {
            last_message: parsed.message.substring(0, 100),
            unread_count: conversation.unread_count + 1,
            action_required: actionRequired,
          });
        }

        // Save message
        const savedMessage = await databaseService.createMessage({
          conversation_id: conversation.id,
          content: parsed.message,
          sender_id: contact.id,
          sender_name: contact.name,
          sender_avatar: contact.avatar,
          sent_at: parsed.timestamp.toISOString(),
          is_own: false,
          external_message_id: parsed.messageId,
        });

        // Update contact last message time
        await databaseService.updateContactLastMessage(contact.id);

        // Generate AI response
        const conversationMessages = await databaseService.getMessagesByConversation(conversation.id);
        const history = conversationMessages.slice(-5).map((msg) => ({
          role: msg.is_own ? ('assistant' as const) : ('user' as const),
          content: msg.content,
        }));

        const aiResponse = await openAIService.generateResponse(parsed.message, history);
        console.log('🤖 AI Response:', aiResponse);

        // Mark as read
        await gmailService.markAsRead(gmailMessage.id);

        // Mark as processed
        await databaseService.markMessageAsProcessed(gmailMessage.id, 'gmail');

        // Broadcast to connected clients
        this.broadcast({
          type: 'new_message',
          conversation: {
            id: conversation.id,
            action_required: conversation.action_required,
          },
          contact: {
            name: contact.name,
            avatar: contact.avatar,
          },
          message: {
            id: savedMessage.id,
            conversationId: conversation.id,
            content: parsed.message,
            senderId: contact.id,
            senderName: contact.name,
            senderAvatar: contact.avatar,
            timestamp: parsed.timestamp.toISOString(),
            isOwn: false,
          },
          aiSuggestion: aiResponse,
        });

        console.log(`✅ Processed message from ${parsed.customerName}`);
      }

      if (newMessages.length === 0) {
        console.log('📭 No new messages');
      }
    } catch (error) {
      console.error('❌ Error checking messages:', error);
    }
  }
}

export const messageMonitorService = new MessageMonitorService();

