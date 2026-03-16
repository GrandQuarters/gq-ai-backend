import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Type definitions
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
  sender_id: string;
  sender_name: string;
  sender_avatar: string;
  sent_at: string;
  is_own: boolean;
  external_message_id: string | null;
  read_at: string | null;
  delivered_at: string | null;
}

export interface AIResponse {
  id: string;
  conversation_id: string;
  content: string;
  status: 'pending' | 'sent' | 'superseded' | 'discarded';
  source_message_ids: string[];
  unanswered_message_count: number;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  superseded_at: string | null;
  model: string | null;
  tokens_used: number | null;
  generation_time_ms: number | null;
}

export class SupabaseDatabaseService {
  private supabase: SupabaseClient;
  private isConnected: boolean = false;

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error('⚠️  Supabase credentials not configured! Add SUPABASE_URL and SUPABASE_SERVICE_KEY to .env');
      console.error('⚠️  Backend will run but database operations will fail.');
      // Create a dummy client to avoid null errors -- operations will fail gracefully
      this.supabase = createClient('https://placeholder.supabase.co', 'placeholder');
      return;
    }

    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.isConnected = true;
    console.log('✅ Supabase client initialized');
  }

  // ==========================================
  // CONTACTS
  // ==========================================

  async getContacts(): Promise<Contact[]> {
    const { data, error } = await this.supabase
      .from('contacts')
      .select('*')
      .order('last_message_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async getContactByEmail(email: string): Promise<Contact | null> {
    const { data, error } = await this.supabase
      .from('contacts')
      .select('*')
      .eq('email', email)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  async getContactByPhoneNumber(phoneNumber: string): Promise<Contact | null> {
    const { data, error} = await this.supabase
      .from('contacts')
      .select('*')
      .eq('phone_number', phoneNumber)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  async getContactByNameAndPlatform(name: string, platform: string): Promise<Contact | null> {
    const { data, error } = await this.supabase
      .from('contacts')
      .select('*')
      .eq('name', name)
      .eq('platform', platform)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  async createContact(contact: Omit<Contact, 'id' | 'created_at' | 'last_message_at'>): Promise<Contact> {
    const { data, error } = await this.supabase
      .from('contacts')
      .insert({
        name: contact.name,
        platform: contact.platform,
        email: contact.email,
        phone_number: contact.phone_number,
        avatar: contact.avatar,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateContactLastMessage(contactId: string): Promise<void> {
    const { error } = await this.supabase
      .from('contacts')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', contactId);

    if (error) throw error;
  }

  // ==========================================
  // CONVERSATIONS
  // ==========================================

  async getConversations(): Promise<Conversation[]> {
    const { data, error } = await this.supabase
      .from('conversations')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async getConversationByThreadId(threadId: string): Promise<Conversation | null> {
    const { data, error } = await this.supabase
      .from('conversations')
      .select('*')
      .eq('email_thread_id', threadId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  async getConversationByPlatformHash(hash: string): Promise<Conversation | null> {
    const { data, error } = await this.supabase
      .from('conversations')
      .select('*')
      .eq('platform_conversation_hash', hash)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  async getConversationByPhoneNumber(phoneNumber: string): Promise<Conversation | null> {
    const { data, error } = await this.supabase
      .from('conversations')
      .select('*')
      .eq('platform_conversation_hash', phoneNumber)
      .eq('platform', 'whatsapp')
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  async createConversation(conversation: Omit<Conversation, 'id' | 'created_at' | 'updated_at'>): Promise<Conversation> {
    const { data, error } = await this.supabase
      .from('conversations')
      .insert({
        contact_id: conversation.contact_id,
        platform: conversation.platform,
        email_thread_id: conversation.email_thread_id,
        platform_conversation_hash: conversation.platform_conversation_hash,
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
    const { error } = await this.supabase
      .from('conversations')
      .update(updates)
      .eq('id', conversationId);

    if (error) throw error;
  }

  // ==========================================
  // MESSAGES
  // ==========================================

  async getMessagesByConversation(conversationId: string): Promise<Message[]> {
    const { data, error } = await this.supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('sent_at', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async createMessage(message: Omit<Message, 'id' | 'read_at' | 'delivered_at'>): Promise<Message> {
    const { data, error } = await this.supabase
      .from('messages')
      .insert({
        conversation_id: message.conversation_id,
        content: message.content,
        sender_id: message.sender_id,
        sender_name: message.sender_name,
        sender_avatar: message.sender_avatar,
        sent_at: message.sent_at,
        is_own: message.is_own,
        external_message_id: message.external_message_id,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // ==========================================
  // AI RESPONSES (NEW!)
  // ==========================================

  /**
   * Get pending AI response for a conversation
   */
  async getPendingAIResponse(conversationId: string): Promise<AIResponse | null> {
    const { data, error } = await this.supabase
      .from('ai_responses')
      .select('*')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  /**
   * Get all unanswered guest messages (messages since last admin message)
   */
  async getUnansweredMessages(conversationId: string): Promise<Message[]> {
    // Use the Postgres function
    const { data, error } = await this.supabase.rpc('get_unanswered_messages', {
      p_conversation_id: conversationId,
    });

    if (error) throw error;
    return data || [];
  }

  /**
   * Create AI response
   */
  async createAIResponse(aiResponse: {
    conversation_id: string;
    content: string;
    source_message_ids: string[];
    model?: string;
    tokens_used?: number;
    generation_time_ms?: number;
  }): Promise<AIResponse> {
    const { data, error } = await this.supabase
      .from('ai_responses')
      .insert({
        conversation_id: aiResponse.conversation_id,
        content: aiResponse.content,
        status: 'pending',
        source_message_ids: aiResponse.source_message_ids,
        unanswered_message_count: aiResponse.source_message_ids.length,
        model: aiResponse.model || 'gpt-4',
        tokens_used: aiResponse.tokens_used,
        generation_time_ms: aiResponse.generation_time_ms,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Update AI response status
   */
  async updateAIResponse(aiResponseId: string, updates: Partial<AIResponse>): Promise<void> {
    const { error } = await this.supabase
      .from('ai_responses')
      .update(updates)
      .eq('id', aiResponseId);

    if (error) throw error;
  }

  /**
   * Supersede pending AI response (mark as superseded)
   */
  async supersedePendingAIResponse(conversationId: string): Promise<void> {
    // Use the Postgres function
    const { error } = await this.supabase.rpc('get_or_supersede_pending_ai_response', {
      p_conversation_id: conversationId,
    });

    if (error) throw error;
  }

  // ==========================================
  // PROCESSED MESSAGES
  // ==========================================

  async isMessageProcessed(externalMessageId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('processed_messages')
      .select('external_message_id')
      .eq('external_message_id', externalMessageId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return !!data;
  }

  async markMessageAsProcessed(externalMessageId: string, platform: 'gmail' | 'whatsapp'): Promise<void> {
    const { error } = await this.supabase
      .from('processed_messages')
      .insert({
        external_message_id: externalMessageId,
        platform: platform,
      });

    if (error && error.code !== '23505') throw error; // Ignore duplicate key errors
  }
}

export const supabaseDatabaseService = new SupabaseDatabaseService();

