import OpenAI from 'openai';

const SYSTEM_PROMPT = `You are an AI assistant for Grand Quarters, a luxury serviced apartment provider in Vienna, Austria.

CONTEXT:
- You manage multiple apartments in central Vienna
- Primary location: Radetzkystraße 14, 1030 Wien  
- You provide professional, warm, helpful service
- Guests book through Airbnb, Booking.com, Expedia, FeWo-direkt

YOUR ROLE:
- Answer guest questions accurately in their language
- Provide helpful information about Vienna
- Give clear instructions (check-in, parking, amenities)
- Maintain professional yet friendly tone
- Be concise but thorough

COMMON TOPICS:
- Check-in/Check-out times (flexible 3PM-9PM)
- Parking (€22/day, nearby at Radetzkystraße 14)
- WiFi (included, password in welcome booklet)
- Public transport (U-Bahn 2 min walk)
- Luggage storage (available at office - Radetzkystraße 14)
- Fresh linens (one level down in building, door next to stairs, use room key, please return when done)
- Local recommendations (restaurants, cafes, sights)

APARTMENT DETAILS:
- Fully equipped kitchen
- Washer/dryer available
- Fresh linens/towels provided (self-service from linen room)
- Central heating
- High-speed WiFi

RESPONSE STYLE:
- Warm and welcoming
- Clear and informative
- Anticipate follow-up questions
- Offer additional help
- Match the guest's language (German, English, Spanish, Chinese, Japanese, etc.)
- Keep responses concise (2-4 sentences usually)

Generate appropriate responses to guest messages.`;

export class OpenAIService {
  private openai: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === 'your-openai-key-here') {
      console.warn('⚠️  OpenAI API key not set. AI responses will be disabled.');
      this.openai = null as any;
    } else {
      this.openai = new OpenAI({ apiKey });
    }
  }

  async generateResponse(
    customerMessage: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
  ): Promise<string> {
    if (!this.openai) {
      return 'Vielen Dank für Ihre Nachricht! Ich werde mich in Kürze bei Ihnen melden.';
    }

    try {
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...conversationHistory,
        { role: 'user', content: customerMessage },
      ];

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4',
        messages,
        temperature: 0.7,
        max_tokens: 300,
      });

      return response.choices[0].message.content || 'Danke für Ihre Nachricht!';
    } catch (error) {
      console.error('❌ OpenAI error:', error);
      return 'Vielen Dank für Ihre Nachricht! Ich werde mich in Kürze bei Ihnen melden.';
    }
  }

  detectActionRequired(message: string): boolean {
    const urgentKeywords = [
      'defekt',
      'kaputt',
      'broken',
      'not working',
      'problem',
      'hilfe',
      'help',
      'dringend',
      'urgent',
      'emergency',
      'notfall',
      'heizung',
      'heating',
      'wasser',
      'water',
      'leak',
      'leck',
    ];

    const lowerMessage = message.toLowerCase();
    return urgentKeywords.some((keyword) => lowerMessage.includes(keyword));
  }
}

export const openAIService = new OpenAIService();

