import { GmailMessage } from './gmail.service';

export interface ParsedMessage {
  customerName: string;
  message: string;
  platform: string;
  originalFrom: string;
  originalSubject: string;
  threadId: string;
  messageId: string;
  timestamp: Date;
  platformConversationHash?: string; // Unique hash from platform (e.g., Airbnb)
  replyToEmail?: string; // The exact email to reply to
}

export class EmailParserService {
  parseEmail(gmailMessage: GmailMessage): ParsedMessage {
    const { platform, body, subject, from, threadId, id, timestamp, replyTo } = gmailMessage;

    let customerName = 'Unknown';
    let cleanMessage = body;
    let platformConversationHash: string | undefined = undefined;
    let replyToEmail: string | undefined = undefined;

    switch (platform) {
      case 'airbnb':
        customerName = this.extractAirbnbName(subject, body);
        cleanMessage = this.cleanAirbnbMessage(body);
        // Extract hash from Reply-To header (not From header!)
        const airbnbData = this.extractAirbnbHash(replyTo || from);
        platformConversationHash = airbnbData.hash;
        replyToEmail = airbnbData.email;
        console.log('🔍 Airbnb - Reply-To:', replyTo, '→ Hash:', airbnbData.hash, 'Email:', airbnbData.email);
        break;
      case 'booking':
        customerName = this.extractBookingName(subject, body);
        cleanMessage = this.cleanBookingMessage(body);
        // Extract hash from Reply-To header (Booking.com uses Reply-To)
        const bookingData = this.extractBookingHash(replyTo || from);
        platformConversationHash = bookingData.hash;
        replyToEmail = bookingData.email;
        console.log('🔍 Booking.com - Reply-To:', replyTo, '→ Hash:', bookingData.hash, 'Email:', bookingData.email);
        break;
      case 'expedia':
        customerName = this.extractExpediaName(subject, body);
        cleanMessage = this.cleanExpediaMessage(body);
        // Extract hash from From header (Expedia puts hash in From field)
        const expediaData = this.extractExpediaHash(from);
        platformConversationHash = expediaData.hash;
        replyToEmail = expediaData.email;
        console.log('🔍 Expedia - From:', from, '→ Hash:', expediaData.hash, 'Email:', expediaData.email);
        break;
      case 'fewo':
        customerName = this.extractFewoName(subject, body);
        cleanMessage = this.cleanFewoMessage(body);
        // Extract hash from Reply-To header (FeWo-direkt/HomeAway uses Reply-To)
        const fewoData = this.extractFewoHash(replyTo || from);
        platformConversationHash = fewoData.hash;
        replyToEmail = fewoData.email;
        console.log('🔍 FeWo-direkt - Reply-To:', replyTo, '→ Hash:', fewoData.hash, 'Email:', fewoData.email);
        break;
      default:
        // Generic extraction
        customerName = this.extractGenericName(subject, from);
        cleanMessage = this.cleanGenericMessage(body);
    }

    return {
      customerName,
      message: cleanMessage.trim(),
      platform,
      originalFrom: from,
      originalSubject: subject,
      threadId,
      messageId: id,
      timestamp,
      platformConversationHash,
      replyToEmail,
    };
  }

  private extractAirbnbHash(fromHeader: string): { hash: string; email: string } {
    // Airbnb format: "hash@reply.airbnb.com" or "Name <hash@reply.airbnb.com>"
    const emailMatch = fromHeader.match(/([\w-]+)@reply\.airbnb\.com/);
    if (emailMatch) {
      return {
        hash: emailMatch[1], // The hash before @
        email: emailMatch[0], // Full email: hash@reply.airbnb.com
      };
    }

    return { hash: '', email: '' };
  }

  private extractExpediaHash(fromHeader: string): { hash: string; email: string } {
    // Expedia format: "hash@m.expediapartnercentral.com" or in angle brackets
    const emailMatch = fromHeader.match(/([\w_-]+)@m\.expediapartnercentral\.com/);
    if (emailMatch) {
      return {
        hash: emailMatch[1], // The hash before @
        email: emailMatch[0], // Full email: hash@m.expediapartnercentral.com
      };
    }

    return { hash: '', email: '' };
  }

  private extractBookingHash(fromHeader: string): { hash: string; email: string } {
    // Booking.com format: "hash@guest.booking.com"
    // Example: 697204616-zzcu.4nue.d6wa.5hpk@guest.booking.com
    const emailMatch = fromHeader.match(/([\w.-]+)@guest\.booking\.com/);
    if (emailMatch) {
      return {
        hash: emailMatch[1], // The hash before @
        email: emailMatch[0], // Full email: hash@guest.booking.com
      };
    }

    return { hash: '', email: '' };
  }

  private extractFewoHash(fromHeader: string): { hash: string; email: string } {
    // FeWo-direkt/HomeAway format: "hash@messages.homeaway.com"
    // Example: 478ee2b2-6166-4fca-9263-6a9d13057657@messages.homeaway.com
    const emailMatch = fromHeader.match(/([\w-]+)@messages\.homeaway\.com/);
    if (emailMatch) {
      return {
        hash: emailMatch[1], // The hash before @
        email: emailMatch[0], // Full email: hash@messages.homeaway.com
      };
    }

    return { hash: '', email: '' };
  }

  private extractAirbnbName(subject: string, body: string): string {
    // Airbnb emails have the name right before "Buchende Person" or as first line
    
    // Look for name before "Buchende Person" (German) or "Guest" (English)
    const nameMatch = body.match(/^([A-Za-zÄÖÜäöüß\s]+)[\r\n]+(?:Buchende Person|Guest)/m);
    if (nameMatch) return nameMatch[1].trim();

    // Try subject: "Buchung für ..." or "Reservation for ..."
    const subjectMatch = subject.match(/(?:message|nachricht|booking|buchung) (?:from|von|for|für) (.+?)(?:,|\||$)/i);
    if (subjectMatch) return subjectMatch[1].trim();

    // Try to find name at the start of email body
    const lines = body.split('\n').filter(l => l.trim());
    if (lines[0] && lines[0].length < 50 && lines[0].length > 2) {
      return lines[0].trim();
    }

    return 'Airbnb Guest';
  }

  private extractBookingName(subject: string, body: string): string {
    // Booking.com format varies
    const match = subject.match(/(?:from|von) (.+?)(?:$|\sat\s)/i);
    if (match) return match[1].trim();

    return 'Booking.com Guest';
  }

  private extractExpediaName(subject: string, body: string): string {
    const match = subject.match(/(?:from|von) (.+?)$/i);
    if (match) return match[1].trim();

    return 'Expedia Guest';
  }

  private extractFewoName(subject: string, body: string): string {
    const match = subject.match(/(?:von|from) (.+?)$/i);
    if (match) return match[1].trim();

    return 'FeWo-direkt Guest';
  }

  private extractGenericName(subject: string, from: string): string {
    // Extract name from email format: "Name <email@example.com>"
    const match = from.match(/^"?(.+?)"?\s*</);
    if (match) return match[1].trim();

    return 'Guest';
  }

  private cleanAirbnbMessage(body: string): string {
    // Remove Airbnb boilerplate
    let clean = body;

    // Remove everything before the actual message (name, "Buchende Person", etc.)
    // The message typically starts with "Hi" or a similar greeting
    const messageStart = clean.search(/(?:Hi|Hello|Hallo|Dear|Liebe|Guten)/i);
    if (messageStart !== -1) {
      clean = clean.substring(messageStart);
    } else {
      // If no greeting found, try to remove first few lines (name, label)
      const lines = clean.split('\n');
      // Skip first 2-3 lines (usually name and "Buchende Person")
      if (lines.length > 3) {
        clean = lines.slice(2).join('\n');
      }
    }

    // Remove "View conversation on Airbnb" and similar
    clean = clean.replace(/View (?:full )?conversation on Airbnb.*/gi, '');
    clean = clean.replace(/Unterhaltung auf Airbnb anzeigen.*/gi, '');
    clean = clean.replace(/Antworten.*/gi, '');
    clean = clean.replace(/Kommuniziere.+?Airbnb.*/gi, '');
    clean = clean.replace(/immer über Airbnb.*/gi, '');

    // Remove URLs
    clean = clean.replace(/https?:\/\/\S+/g, '');

    // Remove email footers
    clean = clean.replace(/---+.*/gs, '');
    clean = clean.replace(/Diese E-Mail.*/gi, '');
    clean = clean.replace(/This email.*/gi, '');

    // Remove excessive whitespace
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();

    return clean;
  }

  private cleanBookingMessage(body: string): string {
    let clean = body;
    
    // Remove Booking.com links and boilerplate
    clean = clean.replace(/View message.*/gi, '');
    clean = clean.replace(/https?:\/\/\S+/g, '');
    clean = clean.replace(/Click here.*/gi, '');
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();

    return clean;
  }

  private cleanExpediaMessage(body: string): string {
    let clean = body;

    // Remove Expedia boilerplate
    clean = clean.replace(/View (?:your )?conversation.*/gi, '');
    clean = clean.replace(/https?:\/\/\S+/g, '');
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();

    return clean;
  }

  private cleanFewoMessage(body: string): string {
    let clean = body;

    // Remove FeWo-direkt boilerplate
    clean = clean.replace(/Nachricht anzeigen.*/gi, '');
    clean = clean.replace(/https?:\/\/\S+/g, '');
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();

    return clean;
  }

  private cleanGenericMessage(body: string): string {
    let clean = body;

    // Generic cleanup
    clean = clean.replace(/https?:\/\/\S+/g, '');
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();

    return clean;
  }
}

export const emailParserService = new EmailParserService();

