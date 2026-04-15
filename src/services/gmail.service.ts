import { google, gmail_v1 } from 'googleapis';
import { gmailAuthService } from './gmail-auth.service';
import { Buffer } from 'buffer';

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  timestamp: Date;
  platform: 'airbnb' | 'booking' | 'expedia' | 'fewo' | 'unknown';
  customerName?: string;
  replyTo?: string; // Reply-To header (important for Airbnb)
}

export class GmailService {
  private gmail: gmail_v1.Gmail | null = null;

  async initialize(): Promise<void> {
    const auth = await gmailAuthService.getAuthClient();
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  async listMessages(query: string = '', maxResults: number = 10): Promise<gmail_v1.Schema$Message[]> {
    if (!this.gmail) await this.initialize();

    const response = await this.gmail!.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });

    return response.data.messages || [];
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    if (!this.gmail) await this.initialize();

    const response = await this.gmail!.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const message = response.data;
    const headers = message.payload?.headers || [];

    const getHeader = (name: string) => {
      const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
      return header?.value || '';
    };

    // Decode email body (prefer text/plain, fall back to text/html stripped of tags)
    let body = '';
    if (message.payload?.body?.data) {
      body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
    } else if (message.payload?.parts) {
      let plainText = '';
      let htmlText = '';

      // Recursively collect parts (handles nested multipart structures)
      const collectParts = (parts: gmail_v1.Schema$MessagePart[]) => {
        for (const part of parts) {
          if (part.mimeType === 'text/plain' && part.body?.data) {
            plainText += Buffer.from(part.body.data, 'base64').toString('utf-8');
          } else if (part.mimeType === 'text/html' && part.body?.data) {
            htmlText += Buffer.from(part.body.data, 'base64').toString('utf-8');
          } else if (part.parts) {
            collectParts(part.parts);
          }
        }
      };

      collectParts(message.payload.parts);

      if (plainText) {
        body = plainText;
      } else if (htmlText) {
        // Strip HTML tags to get readable text
        body = this.htmlToText(htmlText);
      }
    }

    // Detect platform from sender
    const from = getHeader('from').toLowerCase();
    let platform: GmailMessage['platform'] = 'unknown';
    if (from.includes('airbnb') || from.includes('express@airbnb.com')) platform = 'airbnb';
    else if (from.includes('@m.expediapartnercentral.com') || from.includes('expedia')) platform = 'expedia';
    else if (from.includes('@guest.booking.com') || from.includes('booking')) platform = 'booking';
    else if (from.includes('@messages.homeaway.com') || from.includes('fewo') || from.includes('homeaway') || from.includes('vrbo')) platform = 'fewo';

    return {
      id: message.id!,
      threadId: message.threadId!,
      from: getHeader('from'),
      to: getHeader('to'),
      subject: getHeader('subject'),
      body,
      timestamp: new Date(parseInt(message.internalDate || '0')),
      platform,
      replyTo: getHeader('reply-to'),
    };
  }

  async sendReply(
    to: string,
    subject: string,
    body: string,
    threadId: string,
    inReplyTo: string,
    platform?: string
  ): Promise<void> {
    if (!this.gmail) await this.initialize();

    console.log(`📧 Email headers - From: ${process.env.GMAIL_USER}, To: ${to}, Platform: ${platform || 'unknown'}`);

    let email: string;

    if (platform === 'fewo') {
      const qpBody = this.encodeQuotedPrintable(body);
      email = [
        `From: ${process.env.GMAIL_USER || 'me'}`,
        `To: ${to}`,
        `In-Reply-To: ${inReplyTo}`,
        `References: ${inReplyTo}`,
        `MIME-Version: 1.0`,
        `Content-Type: text/plain; charset=utf-8`,
        `Content-Transfer-Encoding: quoted-printable`,
        '',
        qpBody,
      ].join('\n');
    } else {
      email = [
        `From: ${process.env.GMAIL_USER || 'me'}`,
        `To: ${to}`,
        `In-Reply-To: ${inReplyTo}`,
        `References: ${inReplyTo}`,
        '',
        body,
      ].join('\n');
    }

    const encodedEmail = Buffer.from(email)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await this.gmail!.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedEmail,
        threadId,
      },
    });
  }

  private encodeQuotedPrintable(text: string): string {
    return text.split('\n').map(line => {
      let encoded = '';
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        const code = char.charCodeAt(0);
        if (code >= 33 && code <= 126 && char !== '=') {
          encoded += char;
        } else if (char === ' ' || char === '\t') {
          encoded += char;
        } else {
          const bytes = Buffer.from(char, 'utf-8');
          for (const byte of bytes) {
            encoded += '=' + byte.toString(16).toUpperCase().padStart(2, '0');
          }
        }
      }
      // Soft-wrap long lines at 75 chars (leaving room for = soft break)
      const wrapped: string[] = [];
      while (encoded.length > 76) {
        let cut = 75;
        // Don't split an encoded sequence (=XX)
        if (encoded[cut - 1] === '=') cut -= 1;
        else if (encoded[cut - 2] === '=') cut -= 2;
        wrapped.push(encoded.substring(0, cut) + '=');
        encoded = encoded.substring(cut);
      }
      wrapped.push(encoded);
      return wrapped.join('\r\n');
    }).join('\r\n');
  }

  async getMessageIdHeader(messageId: string): Promise<string> {
    if (!this.gmail) await this.initialize();

    const response = await this.gmail!.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['Message-ID'],
    });

    const headers = response.data.payload?.headers || [];
    const messageIdHeader = headers.find((h) => h.name?.toLowerCase() === 'message-id');
    return messageIdHeader?.value || '';
  }

  async markAsRead(messageId: string): Promise<void> {
    if (!this.gmail) await this.initialize();

    await this.gmail!.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        removeLabelIds: ['UNREAD'],
      },
    });
  }

  private htmlToText(html: string): string {
    let text = html;
    // Replace <br>, <br/>, <br /> with newlines
    text = text.replace(/<br\s*\/?>/gi, '\n');
    // Replace </p>, </div>, </tr>, </li> with newlines for block-level separation
    text = text.replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n');
    // Replace </td> with tab (table cells)
    text = text.replace(/<\/td>/gi, '\t');
    // Remove <style> and <script> blocks entirely
    text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
    // Remove all remaining HTML tags
    text = text.replace(/<[^>]+>/g, '');
    // Decode common HTML entities
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&auml;/g, 'ä');
    text = text.replace(/&ouml;/g, 'ö');
    text = text.replace(/&uuml;/g, 'ü');
    text = text.replace(/&Auml;/g, 'Ä');
    text = text.replace(/&Ouml;/g, 'Ö');
    text = text.replace(/&Uuml;/g, 'Ü');
    text = text.replace(/&szlig;/g, 'ß');
    text = text.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)));
    // Collapse excessive whitespace
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n[ \t]+/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  async sendNotificationEmail(params: {
    guestName: string;
    platform: string;
    propertyName: string;
    checkinDate: string;
    checkoutDate: string;
    guests: string;
    messageContent: string;
    conversationId: string;
  }): Promise<void> {
    if (!this.gmail) await this.initialize();

    const notificationAddress = 'gq.guestrelations@gmail.com';
    const frontendUrl = (process.env.FRONTEND_URL || 'https://gq-ai.vercel.app').split(',')[0].trim();
    const chatLink = `${frontendUrl}/?conversation=${params.conversationId}`;

    const platformLabel: Record<string, string> = {
      airbnb: 'Airbnb',
      booking: 'Booking.com',
      expedia: 'Expedia',
      fewo: 'FeWo-direkt',
      whatsapp: 'WhatsApp',
      unknown: 'Unbekannt',
    };
    const platformName = platformLabel[params.platform] || params.platform;

    const cleanMessage = params.messageContent
      .replace(/\[BOOKING_INFO\].*?\[\/BOOKING_INFO\]\s*/s, '')
      .trim();

    const bookingLine = [
      params.propertyName && `<strong>Unterkunft:</strong> ${params.propertyName}`,
      params.checkinDate && `<strong>Check-in:</strong> ${params.checkinDate}`,
      params.checkoutDate && `<strong>Check-out:</strong> ${params.checkoutDate}`,
      params.guests && `<strong>Gäste:</strong> ${params.guests}`,
    ].filter(Boolean).join(' &nbsp;|&nbsp; ');

    const subjectProperty = params.propertyName ? ` | ${params.propertyName}` : '';
    const subjectCheckin = params.checkinDate ? ` | CI: ${params.checkinDate}` : '';
    const subject = `💬 ${platformName}: ${params.guestName}${subjectProperty}${subjectCheckin}`;

    const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#D4A574,#8B6635);padding:24px 28px;">
            <p style="margin:0;color:#ffffff;font-size:13px;opacity:0.85;letter-spacing:1px;text-transform:uppercase;">${platformName}</p>
            <h1 style="margin:4px 0 0;color:#ffffff;font-size:22px;font-weight:700;">Neue Nachricht</h1>
          </td>
        </tr>

        <!-- Guest info -->
        <tr>
          <td style="padding:24px 28px 0;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:#fdf6ee;border-left:4px solid #D4A574;border-radius:6px;padding:14px 16px;">
                  <p style="margin:0 0 4px;font-size:11px;color:#999;text-transform:uppercase;letter-spacing:0.8px;">Gast</p>
                  <p style="margin:0;font-size:18px;font-weight:700;color:#1a1a1a;">${params.guestName}</p>
                  ${bookingLine ? `<p style="margin:8px 0 0;font-size:13px;color:#555;">${bookingLine}</p>` : ''}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Message -->
        <tr>
          <td style="padding:20px 28px 0;">
            <p style="margin:0 0 8px;font-size:11px;color:#999;text-transform:uppercase;letter-spacing:0.8px;">Nachricht</p>
            <div style="background:#f9f9f9;border-radius:8px;padding:16px;font-size:15px;color:#333;line-height:1.6;white-space:pre-wrap;">${cleanMessage.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
          </td>
        </tr>

        <!-- CTA Button -->
        <tr>
          <td style="padding:24px 28px 28px;text-align:center;">
            <a href="${chatLink}" style="display:inline-block;background:linear-gradient(135deg,#D4A574,#8B6635);color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;letter-spacing:0.3px;">
              Zum Chat öffnen →
            </a>
            <p style="margin:12px 0 0;font-size:12px;color:#aaa;">Grand Quarters · Gästemanagement</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const emailLines = [
      `From: Grand Quarters <${process.env.GMAIL_USER || 'me'}>`,
      `To: ${notificationAddress}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      Buffer.from(htmlBody).toString('base64'),
    ];

    const raw = emailLines.join('\r\n');
    const encodedEmail = Buffer.from(raw)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await this.gmail!.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedEmail },
    });

    console.log(`📩 Notification email sent to ${notificationAddress} for ${params.guestName}`);
  }

  async getNewMessages(): Promise<GmailMessage[]> {
    const platformQuery = 'is:unread from:(express@airbnb.com OR @m.expediapartnercentral.com OR @guest.booking.com OR sender@messages.homeaway.com)';
    const maxPerRun = 200; // safe cap to avoid overwhelming a single poll run
    const pageSize = 50;

    const allIds: string[] = [];
    let pageToken: string | undefined = undefined;

    // Drain all unread pages up to the per-run cap
    while (true) {
      if (!this.gmail) await this.initialize();
      const listResponse: import('googleapis').gmail_v1.Schema$ListMessagesResponse = (
        await this.gmail!.users.messages.list({
          userId: 'me',
          q: platformQuery,
          maxResults: pageSize,
          ...(pageToken ? { pageToken } : {}),
        })
      ).data;
      const items = listResponse.messages || [];
      for (const msg of items) {
        if (msg.id) allIds.push(msg.id);
      }
      pageToken = listResponse.nextPageToken ?? undefined;
      if (!pageToken || allIds.length >= maxPerRun) break;
    }

    const messages: GmailMessage[] = [];
    for (const id of allIds.slice(0, maxPerRun)) {
      const fullMessage = await this.getMessage(id);
      messages.push(fullMessage);
    }

    return messages;
  }
}

export const gmailService = new GmailService();

