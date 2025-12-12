import axios from 'axios';

export class WhatsAppService {
  private phoneNumberId: string;
  private accessToken: string;
  private apiVersion = 'v18.0';

  constructor() {
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
    this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
  }

  /**
   * Verify webhook (GET request from WhatsApp)
   */
  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'gq-ai-webhook-token';
    
    if (mode === 'subscribe' && token === verifyToken) {
      console.log('✅ WhatsApp webhook verified');
      return challenge;
    }
    
    console.log('❌ WhatsApp webhook verification failed');
    return null;
  }

  /**
   * Parse incoming webhook payload
   */
  parseWebhookPayload(body: any): {
    from: string;
    messageId: string;
    messageContent: string;
    timestamp: string;
  } | null {
    try {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      if (!messages || messages.length === 0) {
        console.log('⚠️  No messages in webhook payload');
        return null;
      }

      const message = messages[0];
      
      // Only process text messages for now
      if (message.type !== 'text') {
        console.log(`⚠️  Unsupported message type: ${message.type}`);
        return null;
      }

      return {
        from: message.from, // Phone number (e.g., "4917512345678")
        messageId: message.id,
        messageContent: message.text.body,
        timestamp: message.timestamp,
      };
    } catch (error) {
      console.error('❌ Error parsing WhatsApp webhook:', error);
      return null;
    }
  }

  /**
   * Send a text message via WhatsApp
   */
  async sendMessage(to: string, message: string): Promise<boolean> {
    if (!this.phoneNumberId || !this.accessToken) {
      console.error('❌ WhatsApp credentials not configured');
      return false;
    }

    try {
      const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
      
      const response = await axios.post(
        url,
        {
          messaging_product: 'whatsapp',
          to: to,
          type: 'text',
          text: {
            body: message,
          },
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log(`✅ WhatsApp message sent to ${to}:`, response.data);
      return true;
    } catch (error: any) {
      console.error('❌ Error sending WhatsApp message:', error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Send a template message (for messages outside 24-hour window)
   * @param to - Recipient phone number (e.g., "4917512345678")
   * @param templateName - Name of the approved template (e.g., "checkin_info")
   * @param languageCode - Language code (e.g., "de", "en")
   * @param components - Array of template components (parameters)
   */
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string = 'de',
    components?: Array<{
      type: 'header' | 'body' | 'button';
      parameters: Array<{ type: 'text' | 'currency' | 'date_time'; text?: string; [key: string]: any }>;
    }>
  ): Promise<boolean> {
    if (!this.phoneNumberId || !this.accessToken) {
      console.error('❌ WhatsApp credentials not configured');
      return false;
    }

    try {
      const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
      
      const payload: any = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'template',
        template: {
          name: templateName,
          language: {
            code: languageCode,
          },
        },
      };

      if (components && components.length > 0) {
        payload.template.components = components;
      }

      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      console.log(`✅ WhatsApp template "${templateName}" sent to ${to}:`, response.data);
      return true;
    } catch (error: any) {
      console.error(`❌ Error sending WhatsApp template "${templateName}":`, error.response?.data || error.message);
      return false;
    }
  }

  // =============================================================================
  // BOOKING CONFIRMATION TEMPLATES
  // =============================================================================

  /**
   * Send booking confirmation (German)
   */
  async sendBuchungsbestaetigung(
    to: string,
    guestName: string,
    bookingInfoLink: string,
    arrivalDate: string,
    departureDate: string,
    street: string,
    streetNr: string,
    zip: string,
    city: string,
    guestRegistrationLink: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'buchungsbestaetigung_de',
      'de',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: bookingInfoLink },
            { type: 'text', text: arrivalDate },
            { type: 'text', text: departureDate },
            { type: 'text', text: street },
            { type: 'text', text: streetNr },
            { type: 'text', text: zip },
            { type: 'text', text: city },
            { type: 'text', text: guestRegistrationLink },
          ],
        },
      ]
    );
  }

  /**
   * Send booking confirmation (English)
   */
  async sendBookingConfirmation(
    to: string,
    guestName: string,
    bookingInfoLink: string,
    arrivalDate: string,
    departureDate: string,
    street: string,
    streetNr: string,
    zip: string,
    city: string,
    guestRegistrationLink: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'buchungsbestaetigung_en',
      'en',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: bookingInfoLink },
            { type: 'text', text: arrivalDate },
            { type: 'text', text: departureDate },
            { type: 'text', text: street },
            { type: 'text', text: streetNr },
            { type: 'text', text: zip },
            { type: 'text', text: city },
            { type: 'text', text: guestRegistrationLink },
          ],
        },
      ]
    );
  }

  // =============================================================================
  // CANCELLATION TEMPLATES
  // =============================================================================

  /**
   * Send cancellation confirmation (German)
   */
  async sendCancellationDE(
    to: string,
    guestName: string,
    bookingReference: string,
    propertyName: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'cancellation_de',
      'de',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: bookingReference },
            { type: 'text', text: propertyName },
          ],
        },
      ]
    );
  }

  /**
   * Send cancellation confirmation (English)
   */
  async sendCancellationEN(
    to: string,
    guestName: string,
    bookingReference: string,
    propertyName: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'cancellation_en',
      'en',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: bookingReference },
            { type: 'text', text: propertyName },
          ],
        },
      ]
    );
  }

  // =============================================================================
  // CHECK-OUT TEMPLATES
  // =============================================================================

  /**
   * Send check-out reminder (German)
   */
  async sendCheckOutDE(
    to: string,
    guestName: string,
    propertyName: string,
    checkOutDate: string,
    checkOutTime: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkout_de',
      'de',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: propertyName },
            { type: 'text', text: checkOutDate },
            { type: 'text', text: checkOutTime },
          ],
        },
      ]
    );
  }

  /**
   * Send check-out reminder (English)
   */
  async sendCheckOutEN(
    to: string,
    guestName: string,
    propertyName: string,
    checkOutDate: string,
    checkOutTime: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkout_en',
      'en',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: propertyName },
            { type: 'text', text: checkOutDate },
            { type: 'text', text: checkOutTime },
          ],
        },
      ]
    );
  }

  // =============================================================================
  // FIRST NIGHT FOLLOW-UP TEMPLATES
  // =============================================================================

  /**
   * Send "How was your first night" message (German)
   */
  async sendFirstNightDE(
    to: string,
    guestName: string,
    propertyName: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'first_night_de',
      'de',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: propertyName },
          ],
        },
      ]
    );
  }

  /**
   * Send "How was your first night" message (English)
   */
  async sendFirstNightEN(
    to: string,
    guestName: string,
    propertyName: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'first_night_en',
      'en',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: propertyName },
          ],
        },
      ]
    );
  }

  // =============================================================================
  // CHECK-IN TEMPLATES - PERSÖNLICH (PERSONAL)
  // =============================================================================

  /**
   * Send personal check-in instructions (German)
   */
  async sendCheckInPersoenlichDE(
    to: string,
    guestName: string,
    propertyName: string,
    checkInDate: string,
    checkInTime: string,
    address: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkin_persoenlich_de',
      'de',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: propertyName },
            { type: 'text', text: checkInDate },
            { type: 'text', text: checkInTime },
            { type: 'text', text: address },
          ],
        },
      ]
    );
  }

  /**
   * Send personal check-in instructions (English)
   */
  async sendCheckInPersoenlichEN(
    to: string,
    guestName: string,
    propertyName: string,
    checkInDate: string,
    checkInTime: string,
    address: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkin_persoenlich_en',
      'en',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: propertyName },
            { type: 'text', text: checkInDate },
            { type: 'text', text: checkInTime },
            { type: 'text', text: address },
          ],
        },
      ]
    );
  }

  // =============================================================================
  // CHECK-IN TEMPLATES - SELLERGASSE
  // =============================================================================

  /**
   * Send Sellergasse check-in instructions (German)
   */
  async sendCheckInSellergasseDE(
    to: string,
    guestName: string,
    checkInDate: string,
    checkInTime: string,
    doorCode: string,
    apartmentNumber: string,
    wifiName: string,
    wifiPassword: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkin_sellergasse_de',
      'de',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: checkInDate },
            { type: 'text', text: checkInTime },
            { type: 'text', text: doorCode },
            { type: 'text', text: apartmentNumber },
            { type: 'text', text: wifiName },
            { type: 'text', text: wifiPassword },
          ],
        },
      ]
    );
  }

  /**
   * Send Sellergasse check-in instructions (English)
   */
  async sendCheckInSellergasseEN(
    to: string,
    guestName: string,
    checkInDate: string,
    checkInTime: string,
    doorCode: string,
    apartmentNumber: string,
    wifiName: string,
    wifiPassword: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkin_sellergasse_en',
      'en',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: checkInDate },
            { type: 'text', text: checkInTime },
            { type: 'text', text: doorCode },
            { type: 'text', text: apartmentNumber },
            { type: 'text', text: wifiName },
            { type: 'text', text: wifiPassword },
          ],
        },
      ]
    );
  }

  // =============================================================================
  // CHECK-IN TEMPLATES - RADETZKY TOP 56
  // =============================================================================

  /**
   * Send Radetzky Top 56 check-in instructions (German)
   */
  async sendCheckInRadetzkyTop56DE(
    to: string,
    guestName: string,
    checkInDate: string,
    checkInTime: string,
    doorCode: string,
    wifiName: string,
    wifiPassword: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkin_radetzky_top56_de',
      'de',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: checkInDate },
            { type: 'text', text: checkInTime },
            { type: 'text', text: doorCode },
            { type: 'text', text: wifiName },
            { type: 'text', text: wifiPassword },
          ],
        },
      ]
    );
  }

  /**
   * Send Radetzky Top 56 check-in instructions (English)
   */
  async sendCheckInRadetzkyTop56EN(
    to: string,
    guestName: string,
    checkInDate: string,
    checkInTime: string,
    doorCode: string,
    wifiName: string,
    wifiPassword: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkin_radetzky_top56_en',
      'en',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: checkInDate },
            { type: 'text', text: checkInTime },
            { type: 'text', text: doorCode },
            { type: 'text', text: wifiName },
            { type: 'text', text: wifiPassword },
          ],
        },
      ]
    );
  }

  // =============================================================================
  // CHECK-IN TEMPLATES - RADETZKY TOP 29
  // =============================================================================

  /**
   * Send Radetzky Top 29 check-in instructions (German)
   */
  async sendCheckInRadetzkyTop29DE(
    to: string,
    guestName: string,
    checkInDate: string,
    checkInTime: string,
    doorCode: string,
    wifiName: string,
    wifiPassword: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkin_radetzky_top29_de',
      'de',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: checkInDate },
            { type: 'text', text: checkInTime },
            { type: 'text', text: doorCode },
            { type: 'text', text: wifiName },
            { type: 'text', text: wifiPassword },
          ],
        },
      ]
    );
  }

  /**
   * Send Radetzky Top 29 check-in instructions (English)
   */
  async sendCheckInRadetzkyTop29EN(
    to: string,
    guestName: string,
    checkInDate: string,
    checkInTime: string,
    doorCode: string,
    wifiName: string,
    wifiPassword: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkin_radetzky_top29_en',
      'en',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: checkInDate },
            { type: 'text', text: checkInTime },
            { type: 'text', text: doorCode },
            { type: 'text', text: wifiName },
            { type: 'text', text: wifiPassword },
          ],
        },
      ]
    );
  }

  // =============================================================================
  // CHECK-IN TEMPLATES - RADETZKY TOP 19
  // =============================================================================

  /**
   * Send Radetzky Top 19 check-in instructions (German)
   */
  async sendCheckInRadetzkyTop19DE(
    to: string,
    guestName: string,
    checkInDate: string,
    checkInTime: string,
    doorCode: string,
    wifiName: string,
    wifiPassword: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkin_radetzky_top19_de',
      'de',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: checkInDate },
            { type: 'text', text: checkInTime },
            { type: 'text', text: doorCode },
            { type: 'text', text: wifiName },
            { type: 'text', text: wifiPassword },
          ],
        },
      ]
    );
  }

  /**
   * Send Radetzky Top 19 check-in instructions (English)
   */
  async sendCheckInRadetzkyTop19EN(
    to: string,
    guestName: string,
    checkInDate: string,
    checkInTime: string,
    doorCode: string,
    wifiName: string,
    wifiPassword: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkin_radetzky_top19_en',
      'en',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: checkInDate },
            { type: 'text', text: checkInTime },
            { type: 'text', text: doorCode },
            { type: 'text', text: wifiName },
            { type: 'text', text: wifiPassword },
          ],
        },
      ]
    );
  }

  // =============================================================================
  // CHECK-IN TEMPLATES - RADETZKYSTR (1D+2D)
  // =============================================================================

  /**
   * Send Radetzkystr (1D+2D) check-in instructions (German)
   */
  async sendCheckInRadetzkystr1D2DDE(
    to: string,
    guestName: string,
    checkInDate: string,
    checkInTime: string,
    doorCode: string,
    apartmentNumber: string,
    wifiName: string,
    wifiPassword: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkin_radetzkystr_1d2d_de',
      'de',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: checkInDate },
            { type: 'text', text: checkInTime },
            { type: 'text', text: doorCode },
            { type: 'text', text: apartmentNumber },
            { type: 'text', text: wifiName },
            { type: 'text', text: wifiPassword },
          ],
        },
      ]
    );
  }

  /**
   * Send Radetzkystr (1D+2D) check-in instructions (English)
   */
  async sendCheckInRadetzkystr1D2DEN(
    to: string,
    guestName: string,
    checkInDate: string,
    checkInTime: string,
    doorCode: string,
    apartmentNumber: string,
    wifiName: string,
    wifiPassword: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'checkin_radetzkystr_1d2d_en',
      'en',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: checkInDate },
            { type: 'text', text: checkInTime },
            { type: 'text', text: doorCode },
            { type: 'text', text: apartmentNumber },
            { type: 'text', text: wifiName },
            { type: 'text', text: wifiPassword },
          ],
        },
      ]
    );
  }

  // =============================================================================
  // GUEST REGISTRATION REMINDER TEMPLATES
  // =============================================================================

  /**
   * Send guest registration reminder (German)
   */
  async sendGuestRegistrationReminderDE(
    to: string,
    guestName: string,
    propertyName: string,
    guestRegistrationLink: string,
    checkInDate: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'erinnerung_gaesteblatt_de',
      'de',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: propertyName },
            { type: 'text', text: guestRegistrationLink },
            { type: 'text', text: checkInDate },
          ],
        },
      ]
    );
  }

  /**
   * Send guest registration reminder (English)
   */
  async sendGuestRegistrationReminderEN(
    to: string,
    guestName: string,
    propertyName: string,
    guestRegistrationLink: string,
    checkInDate: string
  ): Promise<boolean> {
    return this.sendTemplate(
      to,
      'erinnerung_gaesteblatt_en',
      'en',
      [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: guestName },
            { type: 'text', text: propertyName },
            { type: 'text', text: guestRegistrationLink },
            { type: 'text', text: checkInDate },
          ],
        },
      ]
    );
  }

  /**
   * Mark message as read
   */
  async markAsRead(messageId: string): Promise<void> {
    if (!this.phoneNumberId || !this.accessToken) {
      return;
    }

    try {
      const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
      
      await axios.post(
        url,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log(`✅ WhatsApp message ${messageId} marked as read`);
    } catch (error: any) {
      console.error('❌ Error marking WhatsApp message as read:', error.response?.data || error.message);
    }
  }
}

export const whatsappService = new WhatsAppService();

