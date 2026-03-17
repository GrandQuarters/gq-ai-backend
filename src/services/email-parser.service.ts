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
  propertyName?: string; // Property name extracted from subject (for safe conversation merging)
}

export class EmailParserService {
  parseEmail(gmailMessage: GmailMessage): ParsedMessage {
    const { platform, body, subject, from, threadId, id, timestamp, replyTo } = gmailMessage;

    let customerName = 'Unknown';
    let cleanMessage = body;
    let platformConversationHash: string | undefined = undefined;
    let replyToEmail: string | undefined = undefined;
    let propertyName: string | undefined = undefined;

    switch (platform) {
      case 'airbnb':
        customerName = this.extractAirbnbName(subject, body);
        cleanMessage = this.cleanAirbnbMessage(body);
        propertyName = this.extractPropertyName(subject);
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
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/680b2461-0ef0-449d-bad7-729c1a1ce6e7',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'email-parser.service.ts:BOOKING_PARSE',message:'Booking.com parsing details',data:{subject,from,replyTo,extractedName:customerName,extractedMsg:cleanMessage.substring(0,300),rawBodyFirst500:body.substring(0,500),rawBodyLast300:body.substring(Math.max(0,body.length-300))},timestamp:Date.now(),hypothesisId:'BOOKING'})}).catch(()=>{});
        // #endregion
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

    cleanMessage = cleanMessage.replace(/^(?:Re|AW|Fwd|WG):\s*.+\n*/gim, '').trim();

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
      propertyName,
    };
  }

  // Extract property name from Airbnb subject line
  // Subject format: "RE: Buchung für „Elegant & Lebhaft | Erlebe urbanes Stadtflair", 18. Okt. – 11. Jän."
  private extractPropertyName(subject: string): string | undefined {
    // Match text between „ and " (German-style quotes used by Airbnb)
    const match = subject.match(/\u201E(.+?)\u201C/);
    if (match) return match[1].trim();
    // Fallback: match text between regular quotes
    const fallback = subject.match(/[""„](.+?)[""]/);
    if (fallback) return fallback[1].trim();
    return undefined;
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
    // Airbnb email body format (plain text):
    //    GRAHAM            <-- name (indented, often ALL CAPS)
    //    (blank line)
    //    Buchende Person   <-- anchor (indented)
    //    (blank line)
    //    message text...
    //
    // The name line and "Buchende Person" are separated by whitespace-only lines.
    // We need to find the line just before "Buchende Person" that contains actual text.

    // Strategy: find first "Buchende Person" or "Guest" marker, then look backwards for the name
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(?:Buchende Person|Guest)\s*$/i.test(lines[i])) {
        // Walk backwards from this line to find the name (skip blank/whitespace-only lines)
        for (let j = i - 1; j >= 0; j--) {
          const candidate = lines[j].trim();
          if (candidate.length > 0 && candidate.length < 60) {
            // Skip lines that are clearly not names (URLs, tracking, boilerplate)
            if (candidate.startsWith('http') || candidate.startsWith('%') || candidate.startsWith('[')) continue;
            if (/kommuniziere|always communicate|buchung für|reservation for/i.test(candidate)) continue;
            return candidate;
          }
        }
        break;
      }
    }

    // Fallback: try subject for messages/inquiries (NOT "Buchung für" which is the property name)
    const subjectMatch = subject.match(/(?:message|nachricht)\s+(?:from|von)\s+(.+?)(?:,|\||$)/i);
    if (subjectMatch) return subjectMatch[1].trim();

    return 'Airbnb Guest';
  }

  private extractBookingName(subject: string, body: string): string {
    // Best: extract from body "Nachricht von NAME:" or "Message from NAME:"
    const bodyMatch = body.match(/(?:Nachricht von|Message from)\s+(.+?):/i);
    if (bodyMatch) return bodyMatch[1].trim();

    // Good: extract from body "Name des Gastes:\n  NAME"
    const guestNameMatch = body.match(/(?:Name des Gastes|Guest name)[:\s]*\n\s*(.+)/i);
    if (guestNameMatch) return guestNameMatch[1].trim();

    // Fallback: extract from subject "von NAME erhalten" or "from NAME"
    const subjectMatch = subject.match(/(?:von|from)\s+(.+?)(?:\s+erhalten|\s+received|$)/i);
    if (subjectMatch) return subjectMatch[1].trim();

    return 'Booking.com Guest';
  }

  private extractExpediaName(subject: string, body: string): string {
    // Subject formats:
    //   "Expedia guest message from ZILONG WANG"
    //   "Nachricht von Expedia-Gast Inna Babitskaya"
    //   "Antwort vom Hotels.com-Gast Frank Bernd Schreiber"
    //   "Antwort vom Expedia-Gast Denis Snegovskikh"
    //   "Hotels.com guest message from Heejung Lee"

    // Match "message from NAME" or "Nachricht von ...Gast NAME" or "Antwort vom ...Gast NAME"
    const subjectPatterns = [
      /(?:message from|Nachricht von)\s+(?:Expedia-Gast\s+|Hotels\.com-Gast\s+|Expedia guest\s+|Hotels\.com guest\s+)?(.+?)$/i,
      /(?:Antwort vom|Reply from)\s+(?:Expedia-Gast\s+|Hotels\.com-Gast\s+|Expedia guest\s+|Hotels\.com guest\s+)?(.+?)$/i,
    ];

    for (const pattern of subjectPatterns) {
      const match = subject.match(pattern);
      if (match) return match[1].trim();
    }

    // Body: "ZILONG WANG sent you a message" or "Inna Babitskaya hat Ihnen eine Nachricht gesendet"
    const bodyMatch = body.match(/([\p{L}\s'.,\-]+?)\s+(?:hat Ihnen eine Nachricht gesendet|sent you a message)/mu);
    if (bodyMatch) return bodyMatch[1].trim();

    return 'Expedia Guest';
  }

  private extractFewoName(subject: string, body: string): string {
    // Best: extract from body "Name Urlauber:\n        Nicky Bonnor" or "Guest name:"
    const bodyNameMatch = body.match(/(?:Name Urlauber|Guest name)[:\s]*\n\s*(.+)/i);
    if (bodyNameMatch) return bodyNameMatch[1].trim();

    // Subject: "FeWo-direkt.de: NAME Antwort auf Ihre Nachricht"
    const replyMatch = subject.match(/FeWo-direkt\.de:\s+(.+?)\s+Antwort auf/i);
    if (replyMatch) return replyMatch[1].trim();

    // Subject: "von NAME:" or "from NAME:"
    const subjectMatch = subject.match(/(?:von|from)\s+(.+?)(?:\s*:|$)/i);
    if (subjectMatch) return subjectMatch[1].trim();

    return 'FeWo-direkt Guest';
  }

  private extractGenericName(subject: string, from: string): string {
    // Extract name from email format: "Name <email@example.com>"
    const match = from.match(/^"?(.+?)"?\s*</);
    if (match) return match[1].trim();

    return 'Guest';
  }

  private cleanAirbnbMessage(body: string): string {
    // Airbnb email body contains the full conversation thread:
    //    NAME
    //    Buchende Person
    //    newest message text...
    //
    //    NAME
    //    Buchende Person
    //    older message text...
    //
    // We need ONLY the first message (newest) after the first "Buchende Person" / "Guest",
    // and stop before the NEXT "Buchende Person" / "Guest" block or boilerplate.

    const lines = body.split('\n');

    // Find the first "Buchende Person" / "Guest" line
    let startLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(?:Buchende Person|Guest)\s*$/i.test(lines[i])) {
        startLine = i + 1; // message starts after this line
        break;
      }
    }

    if (startLine === -1) {
      // Fallback: try to find a greeting
      const greetingStart = body.search(/(?:Hi|Hello|Hallo|Dear|Liebe|Guten)/i);
      if (greetingStart !== -1) {
        return body.substring(greetingStart).split('\n').slice(0, 10).join('\n').trim();
      }
      return '';
    }

    // Collect lines until we hit the NEXT "Buchende Person" / "Guest" block,
    // a "You:" line (admin reply in thread), or boilerplate
    const messageLines: string[] = [];
    for (let i = startLine; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      // Stop if we hit another "Buchende Person" / "Guest" marker (next message in thread)
      if (/^(?:Buchende Person|Guest)$/i.test(trimmed)) break;

      // Stop if we hit a "You:" line (admin reply in the thread)
      if (/^\s*You:/i.test(lines[i])) break;

      // Stop at boilerplate
      if (/^Antworten$/i.test(trimmed)) break;
      if (/^Reply$/i.test(trimmed)) break;
      if (/^View (?:full )?conversation/i.test(trimmed)) break;
      if (/^Unterhaltung auf Airbnb anzeigen/i.test(trimmed)) break;
      if (/^Du kannst auch direkt/i.test(trimmed)) break;
      if (/^You can also reply directly/i.test(trimmed)) break;
      if (/^Kommuniziere zu deinem Schutz/i.test(trimmed)) break;
      if (/^immer über Airbnb/i.test(trimmed)) break;
      if (/^---+$/.test(trimmed)) break;
      if (/^_{3,}$/.test(trimmed)) break;
      if (/^Diese E-Mail/i.test(trimmed)) break;
      if (/^This email/i.test(trimmed)) break;
      if (/^Airbnb, Inc\./i.test(trimmed)) break;
      if (/^©\s*\d{4}\s*Airbnb/i.test(trimmed)) break;
      if (/^https?:\/\//.test(trimmed)) break;
      if (/^\[https?:\/\//.test(trimmed)) break;

      // Check if this line is likely a NAME line right before the next "Buchende Person"
      // (i.e., next non-blank line is "Buchende Person")
      if (trimmed.length > 0 && trimmed.length < 60 && !/\s{2}/.test(trimmed)) {
        // Look ahead: skip blank lines and check if "Buchende Person" follows
        let nextNonBlank = '';
        for (let k = i + 1; k < lines.length && k <= i + 3; k++) {
          if (lines[k].trim().length > 0) {
            nextNonBlank = lines[k].trim();
            break;
          }
        }
        if (/^(?:Buchende Person|Guest)$/i.test(nextNonBlank)) {
          break; // This is a name line for the next message block
        }
      }

      messageLines.push(lines[i]);
    }

    let clean = messageLines.join('\n');
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();

    return clean;
  }

  private extractBookingDetails(body: string): Record<string, string> | null {
    const details: Record<string, string> = {};
    const fields: [RegExp, string][] = [
      [/Buchungsnummer:\s*(\d+)/i, 'reservation'],
      [/Check-in:\s*(.+)/i, 'checkIn'],
      [/Check-out:\s*(.+)/i, 'checkOut'],
      [/Unterkunftsname:\s*(.+)/i, 'property'],
      [/Gesamtzahl der G(?:ä|ae?)ste:\s*(\d+)/i, 'guests'],
      [/Gesamtzahl der Zimmer:\s*(\d+)/i, 'rooms'],
    ];

    for (const [regex, key] of fields) {
      const match = body.match(regex);
      if (match) details[key] = match[1].trim();
    }

    if (details.checkIn && details.checkOut) {
      details.dates = `${details.checkIn} – ${details.checkOut}`;
      delete details.checkIn;
      delete details.checkOut;
    }

    return Object.keys(details).length > 0 ? details : null;
  }

  private cleanBookingMessage(body: string): string {
    const bookingDetails = this.extractBookingDetails(body);

    // Extract guest message between "Nachricht von NAME:" / "Message from NAME:" 
    // and "Antworten" / "Reply" (the reply button)
    const msgStart = body.match(/(?:Nachricht von|Message from)\s+.+?:\s*\n/i);
    const msgEnd = body.match(/\n\s*Antworten\s*\n|\n\s*Reply\s*\n/i);

    let guestMessage = '';
    if (msgStart && msgEnd && msgStart.index !== undefined && msgEnd.index !== undefined) {
      const startIdx = msgStart.index + msgStart[0].length;
      const endIdx = msgEnd.index;
      if (startIdx < endIdx) {
        guestMessage = body.substring(startIdx, endIdx).trim();
        guestMessage = guestMessage.replace(/https?:\/\/\S+/g, '');
        guestMessage = guestMessage.replace(/^ +/gm, '');
        guestMessage = guestMessage.replace(/\n{3,}/g, '\n\n').trim();
      }
    }

    if (!guestMessage) {
      let clean = body;
      clean = clean.replace(/##-.*-##/g, '');
      clean = clean.replace(/View message.*/gi, '');
      clean = clean.replace(/https?:\/\/\S+/g, '');
      clean = clean.replace(/Click here.*/gi, '');
      clean = clean.replace(/Buchungsangaben[\s\S]*/gi, '');
      clean = clean.replace(/© Copyright Booking\.com[\s\S]*/gi, '');
      clean = clean.replace(/\n{3,}/g, '\n\n').trim();
      guestMessage = clean;
    }

    guestMessage = guestMessage.replace(/^(?:Wir haben diese Nachricht von|We received this message from)\s+.+(?:erhalten|received)\.?\s*\n*/gim, '').trim();

    if (bookingDetails) {
      return `[BOOKING_INFO]${JSON.stringify(bookingDetails)}[/BOOKING_INFO]\n${guestMessage}`;
    }

    return guestMessage;
  }

  private cleanExpediaMessage(body: string): string {
    // Expedia wraps the guest message in quotes: "Sorry I just found it in my bag, thanks a lot"
    // Strategy 1: Extract the quoted message directly (most reliable)
    // Look for quoted text after the "sent you a message" / "hat Ihnen eine Nachricht gesendet" anchor
    const anchorMatch = body.match(/(?:sent you a message|hat Ihnen eine Nachricht gesendet)/i);
    
    if (anchorMatch && anchorMatch.index !== undefined) {
      const afterAnchor = body.substring(anchorMatch.index + anchorMatch[0].length);
      
      // Extract text between quotes (the actual guest message)
      // Supports regular quotes "..." and typographic quotes \u201C...\u201D
      const quotedMatch = afterAnchor.match(/["\u201C]([^"\u201D]+)["\u201D]/);
      if (quotedMatch) {
        return quotedMatch[1].trim();
      }
    }

    // Strategy 2: Try to find any quoted message in the body
    const anyQuoted = body.match(/["\u201C]([^"\u201D]{10,})["\u201D]/);
    if (anyQuoted) {
      return anyQuoted[1].trim();
    }

    // Strategy 3: Fallback -- extract between anchor and boilerplate
    let messageBody: string;
    if (anchorMatch && anchorMatch.index !== undefined) {
      messageBody = body.substring(anchorMatch.index + anchorMatch[0].length);
    } else {
      messageBody = body;
    }

    const endMarkers = [
      /^Antworten\s*$/m,
      /^Reply\s*$/m,
      /^Vorherige Nachrichten/mi,
      /^Previous messages/mi,
      /^View (?:your )?conversation/mi,
      /^Unterhaltung anzeigen/mi,
      /^---+/m,
      /^_{3,}/m,
      /https?:\/\/\S+/,
      /^©\s*\d{4}/mi,
      /^Expedia Group/mi,
    ];

    let cutIndex = messageBody.length;
    for (const marker of endMarkers) {
      const match = messageBody.match(marker);
      if (match && match.index !== undefined && match.index < cutIndex) {
        cutIndex = match.index;
      }
    }

    let clean = messageBody.substring(0, cutIndex);
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();

    return clean;
  }

  private extractFewoBookingDetails(body: string): Record<string, string> | null {
    const details: Record<string, string> = {};
    const fields: [RegExp, string][] = [
      [/Objekt:\s*\n\s*#?(\S+)/i, 'property'],
      [/Wohneinheit:\s*\n\s*(\S+)/i, 'unit'],
      [/Reservierungsnr\.?:\s*\n\s*(\S+)/i, 'reservation'],
      [/Zeitraum:\s*\n\s*(.+)/i, 'dates'],
      [/G(?:ä|ae?)ste:\s*\n\s*(.+)/i, 'guests'],
      [/Anfrage von:\s*\n\s*(.+)/i, 'source'],
      [/Zahlungsmethode:\s*\n\s*(.+)/i, 'payment'],
    ];

    for (const [regex, key] of fields) {
      const match = body.match(regex);
      if (match) details[key] = match[1].trim();
    }

    return Object.keys(details).length > 0 ? details : null;
  }

  private cleanFewoMessage(body: string): string {
    const bookingDetails = this.extractFewoBookingDetails(body);
    let guestMessage = '';

    // Format 1: Buchungsanfrage with "Nachricht des Urlaubers" / "Traveler's message"
    const msgStart = body.match(/(?:Nachricht des Urlaubers|Traveler'?s? message)\s*\n/i);
    const msgEnd = body.match(/(?:Zahlung des Reisenden|Traveler'?s? payment)/i);

    if (msgStart && msgEnd && msgStart.index !== undefined && msgEnd.index !== undefined) {
      const startIdx = msgStart.index + msgStart[0].length;
      const endIdx = msgEnd.index;
      if (startIdx < endIdx) {
        guestMessage = body.substring(startIdx, endIdx).trim();
        guestMessage = guestMessage.replace(/https?:\/\/\S+/g, '').replace(/\n{3,}/g, '\n\n').trim();
      }
    }

    // Format 2: Anfrage/inquiry with message between "Weitere Informationen" and "Anfrage beantworten"
    if (!guestMessage) {
      const inqStart = body.match(/Weitere Informationen\s*\n/i);
      const inqEnd = body.match(/\n\s*Anfrage beantworten\s*\n/i);
      if (inqStart && inqEnd && inqStart.index !== undefined && inqEnd.index !== undefined) {
        const startIdx = inqStart.index + inqStart[0].length;
        const endIdx = inqEnd.index;
        if (startIdx < endIdx) {
          guestMessage = body.substring(startIdx, endIdx).trim();
          guestMessage = guestMessage.replace(/https?:\/\/\S+/g, '').replace(/\n{3,}/g, '\n\n').trim();
        }
      }
    }

    // Format 3: no guest message (booking request only)
    if (!guestMessage && body.match(/(?:Neue Buchungsanfrage|Reservierungsanfrage)/i)) {
      guestMessage = '';
    }

    // Format 4: plain reply -- message text before the "-------" Vrbo footer
    if (!guestMessage && !bookingDetails) {
      const footerIdx = body.indexOf('-------');
      if (footerIdx > 0) {
        guestMessage = body.substring(0, footerIdx).trim();
        guestMessage = guestMessage.replace(/https?:\/\/\S+/g, '').replace(/\n{3,}/g, '\n\n').trim();
      }
    }

    // Fallback
    if (!guestMessage && !bookingDetails) {
      let clean = body;
      clean = clean.replace(/Nachricht anzeigen.*/gi, '');
      clean = clean.replace(/https?:\/\/\S+/g, '');
      clean = clean.replace(/\n{3,}/g, '\n\n').trim();
      return clean;
    }

    if (bookingDetails) {
      return `[BOOKING_INFO]${JSON.stringify(bookingDetails)}[/BOOKING_INFO]\n${guestMessage}`;
    }

    return guestMessage;
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

