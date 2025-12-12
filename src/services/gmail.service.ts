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

    // Decode email body
    let body = '';
    if (message.payload?.body?.data) {
      body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
    } else if (message.payload?.parts) {
      // Multipart email
      for (const part of message.payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          body += Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
    }

    // Detect platform from sender
    const from = getHeader('from').toLowerCase();
    let platform: GmailMessage['platform'] = 'unknown';
    if (from.includes('airbnb') || from.includes('express@airbnb.com')) platform = 'airbnb';
    else if (from.includes('@m.expediapartnercentral.com') || from.includes('expedia')) platform = 'expedia';
    else if (from.includes('@guest.booking.com') || from.includes('booking')) platform = 'booking';
    else if (from.includes('@messages.homeaway.com') || from.includes('fewo') || from.includes('homeaway')) platform = 'fewo';

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
      `Subject: ${subject}`,
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

  async getNewMessages(): Promise<GmailMessage[]> {
    // Fetch from booking platforms + test email
    const platformQuery = 'from:(express@airbnb.com OR @m.expediapartnercentral.com OR @guest.booking.com OR sender@messages.homeaway.com OR @salescrew.at) is:unread';
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

