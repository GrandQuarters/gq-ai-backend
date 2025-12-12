import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(__dirname, '../../gq-ai.db');

export interface Contact {
  id: string;
  name: string;
  platform: string;
  email: string;
  phone_number?: string;
  avatar: string;
  created_at: string;
  last_message_at: string;
}

export interface Conversation {
  id: string;
  contact_id: string;
  platform: string;
  email_thread_id: string;
  platform_conversation_hash: string | null; // Unique hash from platform email (e.g., Airbnb)
  last_message: string | null;
  unread_count: number;
  is_pinned: number;
  action_required: number;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  content: string;
  sender_id: string;
  sender_name: string;
  sender_avatar: string;
  timestamp: string;
  is_own: number;
  gmail_message_id: string;
}

export class DatabaseService {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.initialize();
  }

  private initialize(): void {
    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        email TEXT NOT NULL,
        phone_number TEXT,
        avatar TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        email_thread_id TEXT UNIQUE,
        platform_conversation_hash TEXT,
        last_message TEXT,
        unread_count INTEGER DEFAULT 0,
        is_pinned INTEGER DEFAULT 0,
        action_required INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        content TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_avatar TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        is_own INTEGER DEFAULT 0,
        gmail_message_id TEXT UNIQUE,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );

      CREATE TABLE IF NOT EXISTS processed_emails (
        gmail_message_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_thread ON conversations(email_thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_messages_gmail ON messages(gmail_message_id);
    `);

    console.log('✅ Database initialized');
  }

  // Contacts
  getContacts(): Contact[] {
    return this.db.prepare('SELECT * FROM contacts ORDER BY last_message_at DESC').all() as Contact[];
  }

  getContactByNameAndPlatform(name: string, platform: string): Contact | undefined {
    return this.db
      .prepare('SELECT * FROM contacts WHERE name = ? AND platform = ?')
      .get(name, platform) as Contact | undefined;
  }

  getContactByEmail(email: string): Contact | undefined {
    return this.db
      .prepare('SELECT * FROM contacts WHERE email = ?')
      .get(email) as Contact | undefined;
  }

  getContactByPhoneNumber(phoneNumber: string): Contact | undefined {
    return this.db
      .prepare('SELECT * FROM contacts WHERE phone_number = ?')
      .get(phoneNumber) as Contact | undefined;
  }

  createContact(contact: Omit<Contact, 'created_at' | 'last_message_at'>): Contact {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO contacts (id, name, platform, email, phone_number, avatar, created_at, last_message_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      contact.id,
      contact.name,
      contact.platform,
      contact.email,
      contact.phone_number || null,
      contact.avatar,
      now,
      now
    );

    return { ...contact, created_at: now, last_message_at: now };
  }

  updateContactLastMessage(contactId: string): void {
    const stmt = this.db.prepare('UPDATE contacts SET last_message_at = ? WHERE id = ?');
    stmt.run(new Date().toISOString(), contactId);
  }

  // Conversations
  getConversations(): Conversation[] {
    return this.db
      .prepare('SELECT * FROM conversations ORDER BY updated_at DESC')
      .all() as Conversation[];
  }

  getConversationByThreadId(threadId: string): Conversation | undefined {
    return this.db
      .prepare('SELECT * FROM conversations WHERE email_thread_id = ?')
      .get(threadId) as Conversation | undefined;
  }

  getConversationByPlatformHash(hash: string): Conversation | undefined {
    return this.db
      .prepare('SELECT * FROM conversations WHERE platform_conversation_hash = ?')
      .get(hash) as Conversation | undefined;
  }

  getConversationByPhoneNumber(phoneNumber: string): Conversation | undefined {
    return this.db
      .prepare('SELECT * FROM conversations WHERE platform_conversation_hash = ? AND platform = ?')
      .get(phoneNumber, 'whatsapp') as Conversation | undefined;
  }

  createConversation(
    conversation: Omit<Conversation, 'created_at' | 'updated_at'>
  ): Conversation {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO conversations 
      (id, contact_id, platform, email_thread_id, platform_conversation_hash, last_message, unread_count, is_pinned, action_required, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      conversation.id,
      conversation.contact_id,
      conversation.platform,
      conversation.email_thread_id,
      conversation.platform_conversation_hash || null,
      conversation.last_message,
      conversation.unread_count,
      conversation.is_pinned,
      conversation.action_required,
      now,
      now
    );

    return { ...conversation, created_at: now, updated_at: now };
  }

  updateConversation(conversationId: string, updates: Partial<Conversation>): void {
    const fields = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(conversationId);

    const stmt = this.db.prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  // Messages
  getMessagesByConversation(conversationId: string): Message[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC')
      .all(conversationId) as Message[];
  }

  createMessage(message: Message): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages 
      (id, conversation_id, content, sender_id, sender_name, sender_avatar, timestamp, is_own, gmail_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      message.id,
      message.conversation_id,
      message.content,
      message.sender_id,
      message.sender_name,
      message.sender_avatar,
      message.timestamp,
      message.is_own,
      message.gmail_message_id
    );
  }

  isEmailProcessed(gmailMessageId: string): boolean {
    const result = this.db
      .prepare('SELECT 1 FROM processed_emails WHERE gmail_message_id = ?')
      .get(gmailMessageId);
    return !!result;
  }

  markEmailAsProcessed(gmailMessageId: string): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO processed_emails (gmail_message_id, processed_at)
      VALUES (?, ?)
    `);
    stmt.run(gmailMessageId, new Date().toISOString());
  }
}

export const databaseService = new DatabaseService();

