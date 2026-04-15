import { gmailService } from './gmail.service';
import { emailParserService } from './email-parser.service';
import { databaseService } from './database.service';
import { openAIService, GuestContext, deriveStayInfo } from './openai.service';
import { pmsService } from './pms.service';
import { WebSocket } from 'ws';

function stripBookingInfo(text: string): string {
  return text.replace(/\[BOOKING_INFO\].*?\[\/BOOKING_INFO\]\s*/s, '').trim();
}

export class MessageMonitorService {
  private isRunning = false;
  private isChecking = false; // single-flight guard: prevent overlapping poll runs
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
    // Single-flight guard: skip this tick if a previous run is still in progress
    if (this.isChecking) {
      console.log('[POLL_SKIPPED_INFLIGHT] Previous run still in progress, skipping tick.');
      return;
    }
    this.isChecking = true;

    try {
      console.log('[POLL_START] Checking for new messages...');
      const newMessages = await gmailService.getNewMessages();

      if (newMessages.length === 0) {
        console.log('[POLL_DONE] No new messages');
        return;
      }

      for (const gmailMessage of newMessages) {
        // Each message is isolated: an error here does not abort other messages
        try {
          await this.processSingleMessage(gmailMessage);
        } catch (msgErr: any) {
          const errMsg = msgErr?.message || String(msgErr);
          const retryable = this.isRetryableProcessingError(msgErr);
          if (retryable) {
            console.error(
              `[MSG_FAILED_RETRYABLE] gmailId=${gmailMessage.id} threadId=${gmailMessage.threadId} platform=${gmailMessage.platform} subject="${gmailMessage.subject}" error=${errMsg}`
            );
            // Do NOT mark as processed/read. Message will be retried on next poll.
          } else {
            console.error(
              `[MSG_FAILED_TERMINAL] gmailId=${gmailMessage.id} threadId=${gmailMessage.threadId} platform=${gmailMessage.platform} subject="${gmailMessage.subject}" error=${errMsg}`
            );
            // Terminal/unrecoverable path: acknowledge to avoid poison-loop retries.
            try {
              await gmailService.markAsRead(gmailMessage.id);
              await databaseService.markMessageAsProcessed(gmailMessage.id, 'gmail');
            } catch {
              /* best effort */
            }
          }
        }
      }
    } catch (error) {
      console.error('[POLL_FAILED] Error during poll run:', error);
    } finally {
      this.isChecking = false;
    }
  }

  private async processSingleMessage(gmailMessage: import('./gmail.service').GmailMessage): Promise<void> {
        // Skip if already processed
        if (await databaseService.isMessageProcessed(gmailMessage.id)) {
          console.log(`[MSG_DUPLICATE] gmailId=${gmailMessage.id} already processed, skipping.`);
          return;
        }

        console.log(`[MSG_START] gmailId=${gmailMessage.id} platform=${gmailMessage.platform} subject="${gmailMessage.subject}"`);

        // Parse email
        const parsed = emailParserService.parseEmail(gmailMessage);
        
        console.log('👤 Customer:', parsed.customerName);
        console.log('📨 Original From:', parsed.originalFrom);
        console.log('💬 Message:', parsed.message);
        console.log('⏰ Time:', parsed.timestamp);

        // Skip emails with no platform hash -- these can't be matched to a conversation
        if (!parsed.platformConversationHash) {
          console.log(`[MSG_SKIP_NO_HASH] gmailId=${gmailMessage.id} subject="${gmailMessage.subject}"`);
          await gmailService.markAsRead(gmailMessage.id);
          await databaseService.markMessageAsProcessed(gmailMessage.id, 'gmail');
          return;
        }

        // For Expedia: skip non-Latin messages (original language) -- the English translation
        // arrives as a separate email and will be saved instead
        if (parsed.platform === 'expedia' && parsed.message) {
          const latinChars = (parsed.message.match(/[\p{Script=Latin}\s\d.,!?'"()\-:;]/gu) || []).length;
          const totalChars = parsed.message.replace(/\s/g, '').length;
          if (totalChars > 0 && latinChars / totalChars < 0.5) {
            console.log(`[MSG_SKIP_NOLATIN] gmailId=${gmailMessage.id} preview="${parsed.message.substring(0, 60)}"`);
            await gmailService.markAsRead(gmailMessage.id);
            await databaseService.markMessageAsProcessed(gmailMessage.id, 'gmail');
            return;
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

        // Use the specific reply-to email with hash when available
        const emailToUse = parsed.replyToEmail || extractEmail(parsed.originalFrom);
        console.log('📧 Email to use for contact:', emailToUse);
        
        if (parsed.platformConversationHash) {
          console.log(`🔑 Platform conversation hash (${parsed.platform}):`, parsed.platformConversationHash);
        }

        // Find or create contact (match by email first, then by name+platform)
        let contact = await databaseService.getContactByEmail(emailToUse);
        if (!contact) {
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

        // ── Airbnb Booking URL merge ─────────────────────────────────────────────
        if (parsed.platform === 'airbnb' && parsed.bookingUrl) {
          const incomingBookingUrl = parsed.bookingUrl.trim();
          const existingBookingUrl = (contact.booking_url || '').trim();

          if (!existingBookingUrl) {
            await databaseService.updateContact(contact.id, { booking_url: incomingBookingUrl });
            contact.booking_url = incomingBookingUrl;
            console.log(`📈 Airbnb booking_url event [POPULATED]: contact=${contact.id} old=<empty> new=${incomingBookingUrl}`);
          } else if (existingBookingUrl !== incomingBookingUrl) {
            await databaseService.updateContact(contact.id, { booking_url: incomingBookingUrl });
            contact.booking_url = incomingBookingUrl;
            console.log(`📈 Airbnb booking_url event [CHANGED]: contact=${contact.id} old=${existingBookingUrl} new=${incomingBookingUrl}`);
          } else {
            console.log(`📉 Airbnb booking_url event [UNCHANGED]: contact=${contact.id} value=${existingBookingUrl}`);
          }

          const canonicalContact = await databaseService.getContactByPlatformAndBookingUrl(
            'airbnb',
            incomingBookingUrl,
            contact.id
          );

          if (canonicalContact) {
            console.log(`🔀 Airbnb booking_url match: merging contact ${contact.id} (${contact.name}) → canonical ${canonicalContact.id} (${canonicalContact.name}) via ${incomingBookingUrl}`);
            contact = canonicalContact;
          }
        }
        // ────────────────────────────────────────────────────────────────────────

        // Find or create conversation
        // #region agent log
        if (parsed.platform === 'airbnb') { fetch('http://127.0.0.1:7244/ingest/680b2461-0ef0-449d-bad7-729c1a1ce6e7',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'message-monitor.service.ts:CONV_MATCH',message:'Airbnb conversation matching START',data:{name:parsed.customerName,hash:parsed.platformConversationHash,threadId:parsed.threadId,subject:gmailMessage.subject,gmailId:gmailMessage.id,msgPreview:parsed.message.substring(0,150),replyToEmail:parsed.replyToEmail||'none'},timestamp:Date.now(),hypothesisId:'H_CONFIRM'})}).catch(()=>{}); }
        // #endregion
        let conversation = parsed.platformConversationHash 
          ? await databaseService.getConversationByPlatformHash(parsed.platformConversationHash)
          : null;
        
        // #region agent log
        if (parsed.platform === 'airbnb') { fetch('http://127.0.0.1:7244/ingest/680b2461-0ef0-449d-bad7-729c1a1ce6e7',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'message-monitor.service.ts:HASH_RESULT',message:'Hash lookup result',data:{hash:parsed.platformConversationHash,foundByHash:!!conversation,conversationId:conversation?.id||null},timestamp:Date.now(),hypothesisId:'H_CONFIRM'})}).catch(()=>{}); }
        // #endregion

        if (conversation && conversation.contact_id !== contact.id) {
          console.log(`⚠️ Hash matched conversation ${conversation.id} but belongs to different contact (${conversation.contact_id} vs ${contact.id}). Skipping.`);
          conversation = null;
        }

        if (!conversation) {
          conversation = await databaseService.getConversationByThreadId(parsed.threadId);
          // #region agent log
          if (parsed.platform === 'airbnb') { fetch('http://127.0.0.1:7244/ingest/680b2461-0ef0-449d-bad7-729c1a1ce6e7',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'message-monitor.service.ts:THREAD_RESULT',message:'ThreadId lookup result',data:{threadId:parsed.threadId,foundByThread:!!conversation,conversationId:conversation?.id||null},timestamp:Date.now(),hypothesisId:'H_CONFIRM'})}).catch(()=>{}); }
          // #endregion
          if (conversation && conversation.contact_id !== contact.id) {
            console.log(`⚠️ ThreadId matched conversation ${conversation.id} but belongs to different contact (${conversation.contact_id} vs ${contact.id}). Creating separate conversation.`);
            conversation = null;
          }
        }

        // Fallback: match by same contact + same property name (safe merge for booking modifications)
        if (!conversation && parsed.propertyName && contact) {
          conversation = await databaseService.getConversationByContactAndProperty(contact.id, parsed.propertyName);
          // #region agent log
          if (parsed.platform === 'airbnb') { fetch('http://127.0.0.1:7244/ingest/680b2461-0ef0-449d-bad7-729c1a1ce6e7',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'message-monitor.service.ts:PROPERTY_RESULT',message:'Property+Contact fallback result',data:{contactId:contact.id,propertyName:parsed.propertyName,foundByProperty:!!conversation,conversationId:conversation?.id||null},timestamp:Date.now(),hypothesisId:'H_PROPERTY'})}).catch(()=>{}); }
          // #endregion
          if (conversation) {
            await databaseService.updateConversation(conversation.id, {
              email_thread_id: parsed.threadId,
            });
            console.log(`🔗 Merged conversation by property: "${parsed.propertyName}" → ${conversation.id}`);
          }
        }
        
        let matchedExistingConversation = false;

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
          matchedExistingConversation = true;
          // #region agent log
          if (parsed.platform === 'airbnb') { fetch('http://127.0.0.1:7244/ingest/680b2461-0ef0-449d-bad7-729c1a1ce6e7',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'message-monitor.service.ts:EXISTING_CONV',message:'MATCHED existing conversation',data:{conversationId:conversation.id,hash:parsed.platformConversationHash,threadId:parsed.threadId,name:parsed.customerName,msgPreview:parsed.message.substring(0,150)},timestamp:Date.now(),hypothesisId:'H_CONFIRM'})}).catch(()=>{}); }
          // #endregion
        }

        // Translate non-German/English messages
        let messageContent = parsed.message;
        let originalContent: string | null = null;

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

        // Save message — duplicate-safe: returns null if already saved by a concurrent run
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

        if (!savedMessage) {
          // Message was already persisted by a concurrent run; treat as success and finalise
          console.log(
            `[MSG_DUPLICATE] gmailId=${gmailMessage.id} threadId=${gmailMessage.threadId} conversationId=${conversation.id} message already in DB, skipping AI and marking done.`
          );
          await gmailService.markAsRead(gmailMessage.id);
          await databaseService.markMessageAsProcessed(gmailMessage.id, 'gmail');
          return;
        }

        // Message insert succeeded; now safely update existing conversation counters exactly once.
        if (matchedExistingConversation) {
          await databaseService.updateConversation(conversation.id, {
            last_message: stripBookingInfo(messageContent).substring(0, 100),
            unread_count: conversation.unread_count + 1,
            action_required: false,
          });
        }

        // Update contact last message time
        await databaseService.updateContactLastMessage(contact.id);

        // Build guest context from parsed data and booking info
        const bookingInfo = this.extractBookingInfoFromMessage(messageContent);

        // Persist FeWo check-in/out to conversation DB fields when parsed from message/subject
        if (parsed.platform === 'fewo') {
          const fewoUpdates: Record<string, any> = {};

          if (bookingInfo.checkinDate) {
            const existing = (conversation.checkin_date || '').trim();
            const incoming = bookingInfo.checkinDate.trim();
            if (!existing) {
              fewoUpdates.checkin_date = incoming;
              console.log(`📅 FeWo checkin_date [POPULATED]: conversation=${conversation.id} new=${incoming}`);
            } else if (existing !== incoming) {
              fewoUpdates.checkin_date = incoming;
              console.log(`📅 FeWo checkin_date [CHANGED]: conversation=${conversation.id} old=${existing} new=${incoming}`);
            } else {
              console.log(`📅 FeWo checkin_date [UNCHANGED]: conversation=${conversation.id} value=${existing}`);
            }
          }

          if (bookingInfo.checkoutDate) {
            const existing = (conversation.checkout_date || '').trim();
            const incoming = bookingInfo.checkoutDate.trim();
            if (!existing) {
              fewoUpdates.checkout_date = incoming;
              console.log(`📅 FeWo checkout_date [POPULATED]: conversation=${conversation.id} new=${incoming}`);
            } else if (existing !== incoming) {
              fewoUpdates.checkout_date = incoming;
              console.log(`📅 FeWo checkout_date [CHANGED]: conversation=${conversation.id} old=${existing} new=${incoming}`);
            } else {
              console.log(`📅 FeWo checkout_date [UNCHANGED]: conversation=${conversation.id} value=${existing}`);
            }
          }

          if (bookingInfo.bookingId && !conversation.booking_number) {
            fewoUpdates.booking_number = bookingInfo.bookingId;
            console.log(`📅 FeWo booking_number [POPULATED]: conversation=${conversation.id} new=${bookingInfo.bookingId}`);
          }

          if (Object.keys(fewoUpdates).length > 0) {
            await databaseService.updateConversation(conversation.id, fewoUpdates);
            console.log(`📅 FeWo: Persisted booking fields for conversation ${conversation.id}:`, JSON.stringify(fewoUpdates));
          }
        }

        // Fetch PMS data for Booking.com messages using the external booking number
        if (parsed.platform === 'booking' && bookingInfo.bookingId) {
          const incomingBookingId = bookingInfo.bookingId.trim();
          const existingBookingId = (conversation.booking_number || '').trim();

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

          const pmsData = await pmsService.syncConversationFromPms(
            conversation.id,
            incomingBookingId,
            databaseService
          );

          if (pmsData) {
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
          numberOfGuests: bookingInfo.guests || (conversation.adults ? String(conversation.adults + (conversation.children || 0)) : ''),
          apartmentName: parsed.propertyName || bookingInfo.apartment || conversation.property_name || '',
          apartmentAddress: conversation.object_name_internal || '',
          bookingPlatform: parsed.platform,
          bookingId: bookingInfo.bookingId || conversation.booking_number || '',
          checkinDate: bookingInfo.checkinDate || conversation.checkin_date || '',
          checkinTime: conversation.checkin_time || '15:00',
          checkoutDate: bookingInfo.checkoutDate || conversation.checkout_date || '',
          checkoutTime: conversation.checkout_time || '11:00',
          ...(() => {
            const resolved = deriveStayInfo(
              bookingInfo.checkinDate || conversation.checkin_date,
              bookingInfo.checkoutDate || conversation.checkout_date
            );
            return {
              numberOfNights: resolved.numberOfNights || bookingInfo.nights || '',
              stayStatus: resolved.stayStatus,
            };
          })(),
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

        // Mark as read and processed
        await gmailService.markAsRead(gmailMessage.id);
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

        console.log(
          `[MSG_DONE] gmailId=${gmailMessage.id} threadId=${gmailMessage.threadId} contact="${parsed.customerName}" conversationId=${conversation.id}`
        );
  }

  private isRetryableProcessingError(err: unknown): boolean {
    const anyErr = err as any;
    const message = String(anyErr?.message || err || '').toLowerCase();
    const code = String(anyErr?.code || '').toUpperCase();
    const status = Number(anyErr?.status || anyErr?.statusCode || 0);

    // Explicit transient classes
    if (status === 429 || status >= 500) return true;
    if (['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) return true;
    if (
      message.includes('timeout') ||
      message.includes('rate limit') ||
      message.includes('temporarily unavailable') ||
      message.includes('network') ||
      message.includes('connection reset')
    ) {
      return true;
    }

    // Explicit terminal classes
    if (
      message.includes('invalid input syntax') ||
      message.includes('permission denied') ||
      message.includes('row level security') ||
      message.includes('column') ||
      message.includes('schema')
    ) {
      return false;
    }

    // Prefer retry for unknown errors to avoid silent message loss.
    return true;
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
        const parts = zeitraum.split(/\s*[-–—]\s*/);
        if (parts.length >= 2) {
          result.checkinDate = parts[0].trim();
          result.checkoutDate = parts[1].replace(/,.*/, '').trim();
        }
      }
      result.checkinDate = result.checkinDate || info['Check-in'] || '';
      result.checkoutDate = result.checkoutDate || info['Check-out'] || '';

      // FeWo body parser stores date range under 'dates' key — split as last fallback
      if (!result.checkinDate && !result.checkoutDate && info['dates']) {
        const dateParts = info['dates'].split(/\s*[-–—]\s*/);
        if (dateParts.length >= 2) {
          result.checkinDate = dateParts[0].trim();
          result.checkoutDate = dateParts[1].replace(/,.*/, '').trim();
        }
      }
    } catch {
      // ignore parse errors
    }

    return result;
  }
}

export const messageMonitorService = new MessageMonitorService();

