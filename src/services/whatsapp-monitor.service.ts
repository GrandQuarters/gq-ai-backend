import { whatsappService } from './whatsapp.service';
import { supabaseDatabaseService as databaseService } from './supabase-database.service';
import { openAIService } from './openai.service';
import { WebSocket } from 'ws';

export class WhatsAppMonitorService {
  private wsClients: Set<WebSocket> = new Set();

  addWebSocketClient(ws: WebSocket): void {
    this.wsClients.add(ws);
  }

  private broadcast(data: any): void {
    const message = JSON.stringify(data);
    this.wsClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  /**
   * Process incoming WhatsApp message from webhook
   */
  async processIncomingMessage(
    phoneNumber: string,
    messageId: string,
    messageContent: string,
    timestamp: string
  ): Promise<void> {
    try {
      console.log(`📱 WhatsApp message from ${phoneNumber}:`, messageContent);

      // Check if already processed
      if (await databaseService.isMessageProcessed(messageId)) {
        console.log('⚠️  Message already processed');
        return;
      }

      // Format phone number as contact name (fallback)
      const customerName = this.formatPhoneNumber(phoneNumber);

      // Find or create contact
      let contact = await databaseService.getContactByPhoneNumber(phoneNumber);
      if (!contact) {
        contact = await databaseService.createContact({
          name: customerName,
          platform: 'whatsapp',
          email: null,
          phone_number: phoneNumber,
          avatar: '/Logos/whatsapp-logo.png',
        });
        console.log(`👤 Created new WhatsApp contact: ${contact.name} (${phoneNumber})`);
      }

      // Find or create conversation (match by phone number)
      let conversation = await databaseService.getConversationByPhoneNumber(phoneNumber);
      
      if (!conversation) {
        conversation = await databaseService.createConversation({
          contact_id: contact.id,
          platform: 'whatsapp',
          email_thread_id: null,
          platform_conversation_hash: phoneNumber, // Use phone number as hash
          last_message: messageContent.substring(0, 100),
          unread_count: 1,
          is_pinned: false,
          action_required: openAIService.detectActionRequired(messageContent),
        });
        console.log(`💬 Created new WhatsApp conversation: ${conversation.id}`);
      } else {
        // Update existing conversation
        const actionRequired = openAIService.detectActionRequired(messageContent);
        await databaseService.updateConversation(conversation.id, {
          last_message: messageContent.substring(0, 100),
          unread_count: conversation.unread_count + 1,
          action_required: actionRequired,
        });
      }

      // Save message
      const savedMessage = await databaseService.createMessage({
        conversation_id: conversation.id,
        content: messageContent,
        sender_id: contact.id,
        sender_name: contact.name,
        sender_avatar: contact.avatar,
        sent_at: new Date(parseInt(timestamp) * 1000).toISOString(),
        is_own: false,
        external_message_id: messageId,
      });

      // Update contact last message time
      await databaseService.updateContactLastMessage(contact.id);

      // Generate AI response
      const conversationMessages = await databaseService.getMessagesByConversation(conversation.id);
      const history = conversationMessages.slice(-5).map((msg) => ({
        role: msg.is_own ? ('assistant' as const) : ('user' as const),
        content: msg.content,
      }));

      const aiResponse = await openAIService.generateResponse(messageContent, history);
      console.log('🤖 AI Response:', aiResponse);

      // Mark WhatsApp message as read
      await whatsappService.markAsRead(messageId);

      // Mark as processed
      await databaseService.markMessageAsProcessed(messageId, 'whatsapp');

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
          content: messageContent,
          senderId: contact.id,
          senderName: contact.name,
          senderAvatar: contact.avatar,
          timestamp: new Date(parseInt(timestamp) * 1000).toISOString(),
          isOwn: false,
        },
        aiSuggestion: aiResponse,
      });

      console.log(`✅ Processed WhatsApp message from ${customerName}`);
    } catch (error) {
      console.error('❌ Error processing WhatsApp message:', error);
    }
  }

  /**
   * Format phone number for display
   */
  private formatPhoneNumber(phoneNumber: string): string {
    // Format: +43 123 456789 → +43 123 456789
    if (phoneNumber.startsWith('+')) {
      return phoneNumber;
    }
    return `+${phoneNumber}`;
  }
}

export const whatsappMonitorService = new WhatsAppMonitorService();

