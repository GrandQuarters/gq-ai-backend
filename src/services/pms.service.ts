const PMS_API_URL = process.env.PMS_API_URL || '';
const PMS_API_KEY = process.env.PMS_API_KEY || '';

export interface PmsBookingData {
  booking_number: string | null;
  checkin_date: string | null;
  checkout_date: string | null;
  checkin_time: string | null;
  checkout_time: string | null;
  keybox_code: string | null;
  guest_phone: string | null;
  object_name: string | null;
  object_name_internal: string | null;
  adults: number | null;
  children: number | null;
}

export class PmsService {
  async fetchByExternalBookingId(externalId: string): Promise<PmsBookingData | null> {
    try {
      console.log(`🏨 PMS: Fetching booking by external ID: ${externalId}`);
      const response = await fetch(PMS_API_URL, {
        method: 'POST',
        headers: {
          'Apikey': PMS_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ bookingIdExtern: externalId }),
      });

      if (!response.ok) {
        console.log(`⚠️ PMS: HTTP error ${response.status}`);
        return null;
      }

      const data = await response.json();
      return this.parseResponse(data);
    } catch (error) {
      console.error('❌ PMS: Error fetching booking:', error);
      return null;
    }
  }

  private parseResponse(data: any): PmsBookingData | null {
    if (!data?.payload?.length) {
      console.log('⚠️ PMS: No booking found in response');
      return null;
    }

    const booking = data.payload[0];
    const formatTime = (t: string | null) => {
      if (!t) return null;
      const match = t.match(/^(\d{2}:\d{2})/);
      return match ? match[1] : null;
    };

    const result: PmsBookingData = {
      booking_number: booking.id || null,
      checkin_date: booking.arrivalFormated || null,
      checkout_date: booking.departureFormated || null,
      checkin_time: formatTime(booking.guest_check_in_time),
      checkout_time: formatTime(booking.guest_check_out_time),
      keybox_code: booking.keybox_code || null,
      guest_phone: booking.phone || null,
      object_name: booking.object_name || null,
      object_name_internal: booking.object_name_internal || null,
      adults: booking.adults ? parseInt(booking.adults, 10) : null,
      children: booking.childs ? parseInt(booking.childs, 10) : null,
    };

    console.log(`✅ PMS: Found booking - ${result.object_name} (${result.checkin_date} - ${result.checkout_date})`);
    return result;
  }
}

export const pmsService = new PmsService();
