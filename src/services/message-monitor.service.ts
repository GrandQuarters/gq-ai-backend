import { gmailService } from './gmail.service';
import { emailParserService } from './email-parser.service';
import { databaseService } from './database.service';
import { openAIService, GuestContext } from './openai.service';
import { pmsService } from './pms.service';
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

        // ── Contact resolution ─────────────────────────────────────────────────
        // For Airbnb: only match by exact email. Never fall back to name+platform
        // because Airbnb issues a new reply hash per message, so a hash change
        // must create a fresh contact (and later the conversation will be moved to it).
        // For all other platforms: email first, then name+platform as before.
        let contact = await databaseService.getContactByEmail(emailToUse);
        if (!contact && parsed.platform !== 'airbnb') {
          contact = await databaseService.getContactByNameAndPlatform(parsed.customerName, parsed.platform);
          if (contact && emailToUse && contact.email !== emailToUse) {
            console.log(`🔄 Contact "${contact.name}" matched by name but hash changed: "${contact.email}" → "${emailToUse}". Updating.`);
            await databaseService.updateContact(contact.id, { email: emailToUse });
            contact.email = emailToUse;
          }
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

        // ── Conversation matching ──────────────────────────────────────────────
        // Airbnb: ONLY match by booking_url. Never use hash, thread ID, or property.
        // Other platforms: keep the original hash → thread → property chain.
        let conversation: typeof contact extends null ? null : Awaited<ReturnType<typeof databaseService.getConversationByPlatformHash>> = null;

        if (parsed.platform === 'airbnb') {
          // Booking-URL matcher (primary and only)
          if (parsed.bookingUrl) {
            conversation = await databaseService.getConversationByBookingUrl(parsed.bookingUrl);
            if (conversation) {
              console.log(`🔗 [Airbnb] Matched conversation ${conversation.id} by booking_url: ${parsed.bookingUrl}`);
              // Move conversation to the newest contact so replies use the current hash
              if (conversation.contact_id !== contact.id) {
                await databaseService.updateConversation(conversation.id, { contact_id: contact.id });
                conversation.contact_id = contact.id;
                console.log(`🔀 [Airbnb] Reassigned conversation ${conversation.id} to new contact ${contact.id} (${contact.name})`);
              }
            } else {
              console.log(`🆕 [Airbnb] No conversation found for booking_url: ${parsed.bookingUrl} — will create new`);
            }
          } else {
            console.log(`⚠️ [Airbnb] No booking_url extracted from email — creating new conversation`);
          }
        } else {
          // Non-Airbnb: original hash → thread → property chain
          conversation = parsed.platformConversationHash
            ? await databaseService.getConversationByPlatformHash(parsed.platformConversationHash)
            : null;

          if (conversation && conversation.contact_id !== contact.id) {
            console.log(`⚠️ Hash matched conversation ${conversation.id} but belongs to different contact. Skipping.`);
            conversation = null;
          }

          if (!conversation) {
            conversation = await databaseService.getConversationByThreadId(parsed.threadId);
            if (conversation && conversation.contact_id !== contact.id) {
              console.log(`⚠️ ThreadId matched conversation ${conversation.id} but belongs to different contact. Creating separate.`);
              conversation = null;
            }
          }

          // Fallback: match by same contact + same property name (safe merge for booking modifications)
          if (!conversation && parsed.propertyName && contact) {
            conversation = await databaseService.getConversationByContactAndProperty(contact.id, parsed.propertyName);
            if (conversation) {
              await databaseService.updateConversation(conversation.id, {
                email_thread_id: parsed.threadId,
              });
              console.log(`🔗 Merged conversation by property: "${parsed.propertyName}" → ${conversation.id}`);
            }
          }
        }
        
        if (!conversation) {
          const newConvData: any = {
            contact_id: contact.id,
            platform: parsed.platform,
            email_thread_id: parsed.threadId,
            platform_conversation_hash: parsed.platformConversationHash || null,
            property_name: parsed.propertyName || null,
            last_message: stripBookingInfo(parsed.message).substring(0, 100),
            unread_count: 1,
            is_pinned: false,
            action_required: false,
          };
          // Persist booking_url on new Airbnb conversations
          if (parsed.platform === 'airbnb' && parsed.bookingUrl) {
            newConvData.booking_url = parsed.bookingUrl;
          }
          conversation = await databaseService.createConversation(newConvData);
          console.log(`💬 Created new conversation: ${conversation.id}${parsed.bookingUrl ? ' booking_url: ' + parsed.bookingUrl : (parsed.platformConversationHash ? ' hash: ' + parsed.platformConversationHash : '')}`);
        } else {
          // Update existing conversation
          const updateData: any = {
            last_message: stripBookingInfo(parsed.message).substring(0, 100),
            unread_count: conversation.unread_count + 1,
            action_required: false,
          };
          // Keep booking_url up-to-date if newly extracted
          if (parsed.platform === 'airbnb' && parsed.bookingUrl && !conversation.booking_url) {
            updateData.booking_url = parsed.bookingUrl;
          }
          await databaseService.updateConversation(conversation.id, updateData);
          console.log(`✅ [Airbnb] Appended message to conversation ${conversation.id} (${contact.name})`);
        }

        // Translate non-German/English messages
        let messageContent = parsed.message;
        let originalContent: string | null = null;

        // Strip [BOOKING_INFO] before translation so AI doesn't mangle it
        const bookingInfoMatch = parsed.message.match(/^(\[BOOKING_INFO\].*?\[\/BOOKING_INFO\]\n?)([\s\S]*)$/);
        const bookingInfoPrefix = bookingInfoMatch ? bookingInfoMatch[1] : '';
        const textToTranslate = bookingInfoMatch ? bookingInfoMatch[2] : parsed.message;

        if (openAIService.needsTranslation(textToTranslate)) {
          console.log('🌐 Translating message to German...');
          const translated = await openAIService.translateToGerman(textToTranslate);
          if (translated && !translated.startsWith('⚠️')) {
            originalContent = parsed.message;
            messageContent = bookingInfoPrefix + translated;
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

        // Fetch PMS data for Booking.com messages using the external booking number
        if (parsed.platform === 'booking' && bookingInfo.bookingId) {
          const incomingBookingId = bookingInfo.bookingId.trim();
          const existingBookingId = (conversation.booking_number || '').trim();

          // Idempotent booking_number write + explicit change metrics in logs
          if (!existingBookingId) {
            await databaseService.updateConversation(conversation.id, {
              booking_number: incomingBookingId,
            });
            console.log(
              `📈 PMS booking_number event [POPULATED]: conversation=${conversation.id} old=<empty> new=${incomingBookingId}`
            );
          } else if (existingBookingId !== incomingBookingId) {
            await databaseService.updateConversation(conversation.id, {
              booking_number: incomingBookingId,
            });
            console.log(
              `📈 PMS booking_number event [CHANGED]: conversation=${conversation.id} old=${existingBookingId} new=${incomingBookingId}`
            );
          } else {
            console.log(
              `📉 PMS booking_number event [UNCHANGED]: conversation=${conversation.id} value=${existingBookingId}`
            );
          }

          // Use the centralized PMS sync helper — overwrites all booking detail fields
          const pmsData = await pmsService.syncConversationFromPms(
            conversation.id,
            incomingBookingId,
            databaseService
          );

          if (pmsData) {
            // Enrich booking info for AI context with PMS data
            if (pmsData.checkin_date) bookingInfo.checkinDate = pmsData.checkin_date;
            if (pmsData.checkout_date) bookingInfo.checkoutDate = pmsData.checkout_date;
            if (pmsData.object_name) bookingInfo.apartment = pmsData.object_name;
            if (pmsData.adults) bookingInfo.guests = String(pmsData.adults + (pmsData.children || 0));
          }
        }

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

        // Send notification email
        try {
          await gmailService.sendNotificationEmail({
            guestName: contact.name,
            platform: parsed.platform,
            propertyName: parsed.propertyName || bookingInfo.apartment || '',
            checkinDate: bookingInfo.checkinDate || '',
            checkoutDate: bookingInfo.checkoutDate || '',
            guests: bookingInfo.guests || '',
            messageContent: messageContent,
            conversationId: conversation.id,
          });
        } catch (notifErr) {
          console.error('⚠️ Failed to send notification email:', notifErr);
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
      // Accept all key shapes: parser stores 'reservation', legacy used German keys
      result.bookingId = info['reservation'] || info['Buchungsnummer'] || info['Reservierungsnr.'] || '';
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

