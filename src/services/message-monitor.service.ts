import { gmailService } from './gmail.service';
import { emailParserService } from './email-parser.service';
import { databaseService } from './database.service';
import { openAIService, GuestContext } from './openai.service';
import { WebSocket } from 'ws';

function stripBookingInfo(text: string): string {
  return text.replace(/\[BOOKING_INFO\].*?\[\/BOOKING_INFO\]\s*/s, '').trim();
}

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

    // Poll every 15 seconds
    this.pollInterval = setInterval(() => {
      this.checkForNewMessages();
    }, 15000);

    console.log('✅ Email monitor started (polling every 15 seconds)');
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

        // Skip emails with no platform hash -- these can't be matched to a conversation
        if (!parsed.platformConversationHash) {
          console.log('⏭️  Skipping email (no platform hash found):', gmailMessage.subject);
          await gmailService.markAsRead(gmailMessage.id);
          await databaseService.markMessageAsProcessed(gmailMessage.id, 'gmail');
          continue;
        }

        // For Expedia: skip non-Latin messages (original language) -- the English translation
        // arrives as a separate email and will be saved instead
        if (parsed.platform === 'expedia' && parsed.message) {
          const latinChars = (parsed.message.match(/[\p{Script=Latin}\s\d.,!?'"()\-:;]/gu) || []).length;
          const totalChars = parsed.message.replace(/\s/g, '').length;
          if (totalChars > 0 && latinChars / totalChars < 0.5) {
            console.log('⏭️  Skipping Expedia non-Latin message (translation will arrive separately):', parsed.message.substring(0, 60));
            await gmailService.markAsRead(gmailMessage.id);
            await databaseService.markMessageAsProcessed(gmailMessage.id, 'gmail');
            continue;
          }
        }
        
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
        // #region agent log
        if (parsed.platform === 'airbnb') { fetch('http://127.0.0.1:7244/ingest/680b2461-0ef0-449d-bad7-729c1a1ce6e7',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'message-monitor.service.ts:CONV_MATCH',message:'Airbnb conversation matching START',data:{name:parsed.customerName,hash:parsed.platformConversationHash,threadId:parsed.threadId,subject:gmailMessage.subject,gmailId:gmailMessage.id,msgPreview:parsed.message.substring(0,150),replyToEmail:parsed.replyToEmail||'none'},timestamp:Date.now(),hypothesisId:'H_CONFIRM'})}).catch(()=>{}); }
        // #endregion
        let conversation = parsed.platformConversationHash 
          ? await databaseService.getConversationByPlatformHash(parsed.platformConversationHash)
          : null;
        
        // #region agent log
        if (parsed.platform === 'airbnb') { fetch('http://127.0.0.1:7244/ingest/680b2461-0ef0-449d-bad7-729c1a1ce6e7',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'message-monitor.service.ts:HASH_RESULT',message:'Hash lookup result',data:{hash:parsed.platformConversationHash,foundByHash:!!conversation,conversationId:conversation?.id||null},timestamp:Date.now(),hypothesisId:'H_CONFIRM'})}).catch(()=>{}); }
        // #endregion

        if (!conversation) {
          conversation = await databaseService.getConversationByThreadId(parsed.threadId);
          // #region agent log
          if (parsed.platform === 'airbnb') { fetch('http://127.0.0.1:7244/ingest/680b2461-0ef0-449d-bad7-729c1a1ce6e7',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'message-monitor.service.ts:THREAD_RESULT',message:'ThreadId lookup result',data:{threadId:parsed.threadId,foundByThread:!!conversation,conversationId:conversation?.id||null},timestamp:Date.now(),hypothesisId:'H_CONFIRM'})}).catch(()=>{}); }
          // #endregion
        }

        // Fallback: match by same contact + same property name (safe merge for booking modifications)
        if (!conversation && parsed.propertyName && contact) {
          conversation = await databaseService.getConversationByContactAndProperty(contact.id, parsed.propertyName);
          // #region agent log
          if (parsed.platform === 'airbnb') { fetch('http://127.0.0.1:7244/ingest/680b2461-0ef0-449d-bad7-729c1a1ce6e7',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'message-monitor.service.ts:PROPERTY_RESULT',message:'Property+Contact fallback result',data:{contactId:contact.id,propertyName:parsed.propertyName,foundByProperty:!!conversation,conversationId:conversation?.id||null},timestamp:Date.now(),hypothesisId:'H_PROPERTY'})}).catch(()=>{}); }
          // #endregion
          if (conversation) {
            // Update the thread ID so future messages in this new thread also match
            await databaseService.updateConversation(conversation.id, {
              email_thread_id: parsed.threadId,
            });
            console.log(`🔗 Merged conversation by property: "${parsed.propertyName}" → ${conversation.id}`);
          }
        }
        
        if (!conversation) {
          conversation = await databaseService.createConversation({
            contact_id: contact.id,
            platform: parsed.platform,
            email_thread_id: parsed.threadId,
            platform_conversation_hash: parsed.platformConversationHash || null,
            property_name: parsed.propertyName || null,
            last_message: stripBookingInfo(parsed.message).substring(0, 100),
            unread_count: 1,
            is_pinned: false,
            action_required: false,
          });
          console.log(`💬 Created new conversation: ${conversation.id}${parsed.platformConversationHash ? ' with hash: ' + parsed.platformConversationHash : ''}`);
          // #region agent log
          if (parsed.platform === 'airbnb') { fetch('http://127.0.0.1:7244/ingest/680b2461-0ef0-449d-bad7-729c1a1ce6e7',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'message-monitor.service.ts:NEW_CONV',message:'CREATED new conversation',data:{conversationId:conversation.id,hash:parsed.platformConversationHash,threadId:parsed.threadId,name:parsed.customerName,subject:gmailMessage.subject,msgPreview:parsed.message.substring(0,150)},timestamp:Date.now(),hypothesisId:'H_CONFIRM'})}).catch(()=>{}); }
          // #endregion
        } else {
          // Update existing conversation
          await databaseService.updateConversation(conversation.id, {
            last_message: stripBookingInfo(parsed.message).substring(0, 100),
            unread_count: conversation.unread_count + 1,
            action_required: false,
          });
          // #region agent log
          if (parsed.platform === 'airbnb') { fetch('http://127.0.0.1:7244/ingest/680b2461-0ef0-449d-bad7-729c1a1ce6e7',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'message-monitor.service.ts:EXISTING_CONV',message:'MATCHED existing conversation',data:{conversationId:conversation.id,hash:parsed.platformConversationHash,threadId:parsed.threadId,name:parsed.customerName,msgPreview:parsed.message.substring(0,150)},timestamp:Date.now(),hypothesisId:'H_CONFIRM'})}).catch(()=>{}); }
          // #endregion
        }

        // Translate non-German/English messages
        let messageContent = parsed.message;
        let originalContent: string | null = null;
        if (openAIService.needsTranslation(parsed.message)) {
          console.log('🌐 Translating message to German...');
          const translated = await openAIService.translateToGerman(parsed.message);
          if (translated && !translated.startsWith('⚠️')) {
            originalContent = parsed.message;
            messageContent = translated;
            console.log('✅ Translation result:', translated.substring(0, 80));
          } else {
            console.log('⚠️ Translation failed, keeping original message');
            originalContent = null;
          }
        }

        // Build raw email data for debugging
        const rawEmailData = JSON.stringify({
          gmailId: gmailMessage.id,
          threadId: gmailMessage.threadId,
          from: gmailMessage.from,
          to: gmailMessage.to,
          replyTo: gmailMessage.replyTo || null,
          subject: gmailMessage.subject,
          platform: gmailMessage.platform,
          platformHash: parsed.platformConversationHash || null,
          replyToEmail: parsed.replyToEmail || null,
          propertyName: parsed.propertyName || null,
          extractedName: parsed.customerName,
          body: gmailMessage.body,
        });

        // Save message
        const savedMessage = await databaseService.createMessage({
          conversation_id: conversation.id,
          content: messageContent,
          original_content: originalContent,
          raw_email_data: rawEmailData,
          sender_id: contact.id,
          sender_name: contact.name,
          sender_avatar: contact.avatar,
          sent_at: parsed.timestamp.toISOString(),
          is_own: false,
          external_message_id: parsed.messageId,
        });

        // Update contact last message time
        await databaseService.updateContactLastMessage(contact.id);

        // Build guest context from parsed data and booking info
        const bookingInfo = this.extractBookingInfoFromMessage(messageContent);
        const guestContext: GuestContext = {
          guestName: contact.name,
          guestPhone: contact.phone_number || '',
          guestEmail: contact.email || '',
          guestLanguage: this.detectLanguage(parsed.message),
          numberOfGuests: bookingInfo.guests || '',
          apartmentName: parsed.propertyName || bookingInfo.apartment || '',
          apartmentAddress: '',
          bookingPlatform: parsed.platform,
          bookingId: bookingInfo.bookingId || '',
          checkinDate: bookingInfo.checkinDate || '',
          checkinTime: '15:00',
          checkoutDate: bookingInfo.checkoutDate || '',
          checkoutTime: '11:00',
          numberOfNights: bookingInfo.nights || '',
          stayStatus: 'unknown',
        };

        // Generate AI response with full conversation context
        const conversationMessages = await databaseService.getMessagesByConversation(conversation.id);
        await databaseService.supersedePendingAiResponses(conversation.id);
        const aiResponse = await openAIService.generateResponse(guestContext, conversationMessages);
        console.log('🤖 AI Response:', aiResponse);

        if (aiResponse && !aiResponse.startsWith('⚠️')) {
          await databaseService.createAiResponse({
            conversation_id: conversation.id,
            content: aiResponse,
            source_message_ids: [savedMessage.id],
            unanswered_message_count: 1,
            model: 'gpt-5-mini-2025-08-07',
          });
          console.log('💾 AI response saved to DB');
        }

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
            content: messageContent,
            originalContent: originalContent,
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

  private detectLanguage(text: string): string {
    const germanWords = ['und', 'ist', 'der', 'die', 'das', 'ich', 'wir', 'ein', 'für', 'nicht', 'hallo', 'danke', 'bitte', 'guten'];
    const lower = text.toLowerCase();
    const germanHits = germanWords.filter((w) => lower.includes(w)).length;
    if (germanHits >= 2) return 'Deutsch';

    const latinChars = (text.match(/[\p{Script=Latin}]/gu) || []).length;
    const totalAlpha = (text.match(/\p{L}/gu) || []).length;
    if (totalAlpha > 0 && latinChars / totalAlpha < 0.5) return 'Andere';

    return 'Englisch';
  }

  private extractBookingInfoFromMessage(content: string): {
    guests?: string;
    apartment?: string;
    bookingId?: string;
    checkinDate?: string;
    checkoutDate?: string;
    nights?: string;
  } {
    const result: Record<string, string> = {};
    const bookingMatch = content.match(/\[BOOKING_INFO\](.*?)\[\/BOOKING_INFO\]/s);
    if (!bookingMatch) return result;

    try {
      const info = JSON.parse(bookingMatch[1]);
      result.guests = info['Gäste'] || info['Gesamtzahl der Gäste'] || '';
      result.apartment = info['Unterkunftsname'] || info['Objekt'] || '';
      result.bookingId = info['Buchungsnummer'] || info['Reservierungsnr.'] || '';
      result.nights = info['Nächte'] || '';

      const zeitraum = info['Zeitraum'] || '';
      if (zeitraum) {
        const parts = zeitraum.split(' - ');
        if (parts.length === 2) {
          result.checkinDate = parts[0].trim();
          result.checkoutDate = parts[1].replace(/,.*/, '').trim();
        }
      }
      result.checkinDate = result.checkinDate || info['Check-in'] || '';
      result.checkoutDate = result.checkoutDate || info['Check-out'] || '';
    } catch {
      // ignore parse errors
    }

    return result;
  }
}

export const messageMonitorService = new MessageMonitorService();

