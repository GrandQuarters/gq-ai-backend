import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ==========================================
// Type definitions
// ==========================================

export interface Contact {
  id: string;
  name: string;
  platform: string;
  email: string | null;
  phone_number: string | null;
  avatar: string;
  created_at: string;
  last_message_at: string;
}

export interface Conversation {
  id: string;
  contact_id: string;
  platform: string;
  email_thread_id: string | null;
  platform_conversation_hash: string | null;
  property_name: string | null;
  last_message: string | null;
  unread_count: number;
  is_pinned: boolean;
  action_required: boolean;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  content: string;
  original_content: string | null;
  raw_email_data: string | null;
  sender_id: string;
  sender_name: string;
  sender_avatar: string;
  sent_at: string;
  is_own: boolean;
  external_message_id: string | null;
  read_at: string | null;
  delivered_at: string | null;
}

export class DatabaseService {
  private supabase: SupabaseClient | null = null;

  private getClient(): SupabaseClient {
    if (this.supabase) return this.supabase;

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_KEY are not set!');
      console.error('   Set these environment variables on Railway or in your .env file.');
      throw new Error('Supabase not configured');
    }

    this.supabase = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase client initialized');
    return this.supabase;
  }

  // ==========================================
  // CONTACTS
  // ==========================================

  async getContacts(): Promise<Contact[]> {
    const { data, error } = await this.getClient()
      .from('contacts')
      .select('*')
      .order('last_message_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async getContactByEmail(email: string): Promise<Contact | null> {
    const { data, error } = await this.getClient()
      .from('contacts')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async getContactByPhoneNumber(phoneNumber: string): Promise<Contact | null> {
    const { data, error } = await this.getClient()
      .from('contacts')
      .select('*')
      .eq('phone_number', phoneNumber)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async getContactByNameAndPlatform(name: string, platform: string): Promise<Contact | null> {
    const { data, error } = await this.getClient()
      .from('contacts')
      .select('*')
      .eq('name', name)
      .eq('platform', platform)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async createContact(contact: Omit<Contact, 'id' | 'created_at' | 'last_message_at'>): Promise<Contact> {
    const { data, error } = await this.getClient()
      .from('contacts')
      .insert({
        name: contact.name,
        platform: contact.platform,
        email: contact.email || null,
        phone_number: contact.phone_number || null,
        avatar: contact.avatar,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateContactLastMessage(contactId: string): Promise<void> {
    const { error } = await this.getClient()
      .from('contacts')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', contactId);

    if (error) throw error;
  }

  // ==========================================
  // CONVERSATIONS
  // ==========================================

  async getConversations(): Promise<Conversation[]> {
    const { data, error } = await this.getClient()
      .from('conversations')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async getConversationByThreadId(threadId: string): Promise<Conversation | null> {
    const { data, error } = await this.getClient()
      .from('conversations')
      .select('*')
      .eq('email_thread_id', threadId)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async getConversationByPlatformHash(hash: string): Promise<Conversation | null> {
    const { data, error } = await this.getClient()
      .from('conversations')
      .select('*')
      .eq('platform_conversation_hash', hash)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async getConversationByContactAndProperty(contactId: string, propertyName: string): Promise<Conversation | null> {
    const { data, error } = await this.getClient()
      .from('conversations')
      .select('*')
      .eq('contact_id', contactId)
      .eq('property_name', propertyName)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async getConversationByPhoneNumber(phoneNumber: string): Promise<Conversation | null> {
    const { data, error } = await this.getClient()
      .from('conversations')
      .select('*')
      .eq('platform_conversation_hash', phoneNumber)
      .eq('platform', 'whatsapp')
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async createConversation(conversation: Omit<Conversation, 'id' | 'created_at' | 'updated_at'>): Promise<Conversation> {
    const { data, error } = await this.getClient()
      .from('conversations')
      .insert({
        contact_id: conversation.contact_id,
        platform: conversation.platform,
        email_thread_id: conversation.email_thread_id || null,
        platform_conversation_hash: conversation.platform_conversation_hash || null,
        property_name: conversation.property_name || null,
        last_message: conversation.last_message,
        unread_count: conversation.unread_count,
        is_pinned: conversation.is_pinned,
        action_required: conversation.action_required,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateConversation(conversationId: string, updates: Partial<Conversation>): Promise<void> {
    const { id, created_at, ...safeUpdates } = updates as any;

    const { error } = await this.getClient()
      .from('conversations')
      .update(safeUpdates)
      .eq('id', conversationId);

    if (error) throw error;
  }

  // ==========================================
  // MESSAGES
  // ==========================================

  async getMessagesByConversation(conversationId: string): Promise<Message[]> {
    const { data, error } = await this.getClient()
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: true });

    if (error) throw error;
    return (data || []).map((row) => ({
      ...row,
      original_content: row.original_content || null,
      raw_email_data: row.raw_email_data || null,
      read_at: row.read_at || null,
      delivered_at: row.delivered_at || null,
    }));
  }

  async createMessage(message: Omit<Message, 'id' | 'read_at' | 'delivered_at'>): Promise<Message> {
    const { data, error } = await this.getClient()
      .from('messages')
      .upsert(
        {
          conversation_id: message.conversation_id,
          content: message.content,
          original_content: message.original_content || null,
          raw_email_data: message.raw_email_data || null,
          sender_id: message.sender_id,
          sender_name: message.sender_name,
          sender_avatar: message.sender_avatar,
          sent_at: message.sent_at,
          is_own: message.is_own,
          external_message_id: message.external_message_id || null,
        },
        { onConflict: 'external_message_id', ignoreDuplicates: true }
      )
      .select()
      .single();

    if (error) throw error;
    return {
      ...data,
      original_content: data.original_content || null,
      raw_email_data: data.raw_email_data || null,
      read_at: data.read_at || null,
      delivered_at: data.delivered_at || null,
    };
  }

  async getMessageById(messageId: string): Promise<Message | null> {
    const { data, error } = await this.getClient()
      .from('messages')
      .select('*')
      .eq('id', messageId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;
    return {
      ...data,
      original_content: data.original_content || null,
      raw_email_data: data.raw_email_data || null,
      read_at: data.read_at || null,
      delivered_at: data.delivered_at || null,
    };
  }

  // ==========================================
  // PROCESSED MESSAGES
  // ==========================================

  async isMessageProcessed(externalMessageId: string): Promise<boolean> {
    const { data, error } = await this.getClient()
      .from('processed_messages')
      .select('external_message_id')
      .eq('external_message_id', externalMessageId)
      .maybeSingle();

    if (error) throw error;
    return !!data;
  }

  async markMessageAsProcessed(externalMessageId: string, platform: 'gmail' | 'whatsapp'): Promise<void> {
    const { error } = await this.getClient()
      .from('processed_messages')
      .upsert(
        {
          external_message_id: externalMessageId,
          platform,
        },
        { onConflict: 'external_message_id', ignoreDuplicates: true }
      );

    if (error) throw error;
  }

  // ==========================================
  // AI RESPONSES
  // ==========================================

  async createAiResponse(params: {
    conversation_id: string;
    content: string;
    source_message_ids: string[];
    unanswered_message_count: number;
    model: string;
    tokens_used?: number;
    generation_time_ms?: number;
  }): Promise<{ id: string }> {
    const { data, error } = await this.getClient()
      .from('ai_responses')
      .insert({
        conversation_id: params.conversation_id,
        content: params.content,
        status: 'pending',
        source_message_ids: params.source_message_ids,
        unanswered_message_count: params.unanswered_message_count,
        model: params.model,
        tokens_used: params.tokens_used || null,
        generation_time_ms: params.generation_time_ms || null,
      })
      .select('id')
      .single();

    if (error) throw error;
    return data;
  }

  async supersedePendingAiResponses(conversationId: string): Promise<void> {
    const { error } = await this.getClient()
      .from('ai_responses')
      .update({ status: 'superseded', superseded_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('status', 'pending');

    if (error) throw error;
  }

  async markAiResponseSent(aiResponseId: string): Promise<void> {
    const { error } = await this.getClient()
      .from('ai_responses')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', aiResponseId);

    if (error) throw error;
  }

  async getPendingAiResponse(conversationId: string): Promise<{ id: string; content: string } | null> {
    const { data, error } = await this.getClient()
      .from('ai_responses')
      .select('id, content')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data;
  }
}

export const databaseService = new DatabaseService();
