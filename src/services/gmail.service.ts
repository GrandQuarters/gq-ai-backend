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
    inReplyTo: string
  ): Promise<void> {
    if (!this.gmail) await this.initialize();

    const emailLines = [
      `From: ${process.env.GMAIL_USER || 'me'}`,
      `To: ${to}`,
      `In-Reply-To: ${inReplyTo}`,
      `References: ${inReplyTo}`,
      '',
      body,
    ];
    
    console.log(`📧 Email headers - From: ${process.env.GMAIL_USER}, To: ${to}`);

    const email = emailLines.join('\n');
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

  async getNewMessages(): Promise<GmailMessage[]> {
    const platformQuery = 'is:unread from:(express@airbnb.com OR @m.expediapartnercentral.com OR @guest.booking.com OR sender@messages.homeaway.com)';
    const messageList = await this.listMessages(platformQuery, 20);

    const messages: GmailMessage[] = [];
    for (const msg of messageList) {
      if (msg.id) {
        const fullMessage = await this.getMessage(msg.id);
        messages.push(fullMessage);
      }
    }

    return messages;
  }
}

export const gmailService = new GmailService();

