# GQ-AI Backend

Gmail-based messaging backend for Grand Quarters AI assistant.

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables

**IMPORTANT**: Add content to your `.env` file:
```bash
GMAIL_USER=kilian1.sternath@gmail.com
GOOGLE_REDIRECT_URI=http://localhost:4000/oauth2callback
OPENAI_API_KEY=your-openai-key-here
PORT=4000
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
```

**NOTE**: The `.env` file has been created, but you need to add your OpenAI API key!

### 3. Verify credentials.json

The file `credentials.json` has been created with your Gmail API credentials.

### 4. Authenticate with Gmail (First Time Only)
```bash
npm run auth
```

This will:
- Open your browser
- Ask you to login with `kilian1.sternath@gmail.com`
- Grant permissions to the app
- Save your refresh token to `token.json`

### 5. Start the Backend Server
```bash
npm run dev
```

The server will:
- Start on http://localhost:4000
- Connect to Gmail API
- Start monitoring for new emails every 30 seconds
- Provide WebSocket for real-time updates

---

## 📡 API Endpoints

### GET `/health`
Check if server is running

### GET `/api/conversations`
Get all conversations with contacts

**Response:**
```json
[
  {
    "id": "conv-123",
    "name": "Max Mustermann",
    "avatar": "/Logos/airbnb-logo.png",
    "lastMessage": "When is check-in?",
    "lastMessageTime": "2025-12-10T15:30:00Z",
    "unreadCount": 2,
    "pinned": false
  }
]
```

### GET `/api/conversations/:id/messages`
Get all messages in a conversation

**Response:**
```json
[
  {
    "id": "msg-123",
    "content": "Hi! What time is check-in?",
    "senderName": "Max Mustermann",
    "timestamp": "2025-12-10T15:30:00Z",
    "isOwn": false
  }
]
```

### POST `/api/messages/send`
Send a reply to a customer

**Request:**
```json
{
  "conversationId": "conv-123",
  "content": "Check-in is at 3 PM. See you then!"
}
```

### GET `/api/action-required`
Get list of conversation IDs that need attention

**Response:**
```json
["conv-456", "conv-789"]
```

---

## 🔄 WebSocket Events

Connect to `ws://localhost:4000`

### Server → Client Events

#### `new_message`
Sent when a new email is received

```json
{
  "type": "new_message",
  "conversation": { ... },
  "contact": { ... },
  "message": { ... },
  "aiSuggestion": "Generated response text"
}
```

---

## 🧪 Testing

### Test with Your Own Gmail

1. Send an email to `kilian1.sternath@gmail.com` from another account
2. In the **subject**, include: `from YourName`
3. In the **body**, write your test message
4. Wait up to 30 seconds
5. Check backend logs - you should see it detected
6. Check frontend - new conversation should appear!

### Test Email Format
```
From: test@example.com
To: kilian1.sternath@gmail.com
Subject: Test message from Max Test

Hi! This is a test message. 
When is check-in time?
```

---

## 🛠️ Development

### Run in Development Mode
```bash
npm run dev
```

### Build for Production
```bash
npm run build
npm start
```

---

## 📝 How It Works

1. **Email Monitoring**: Polls Gmail API every 30 seconds for new unread emails from booking platforms
2. **Email Parsing**: Extracts customer name and message content, removes boilerplate
3. **Contact Matching**: Finds existing contact or creates new one
4. **AI Generation**: Generates contextual response using GPT-4
5. **Database Storage**: Saves everything to SQLite database
6. **Real-time Updates**: Broadcasts to frontend via WebSocket
7. **Reply Handling**: When admin sends message, replies via Gmail API maintaining email thread

---

## 🔐 Security Notes

- `token.json` contains your Gmail access tokens - NEVER commit this
- `credentials.json` contains OAuth secrets - Keep private
- `.env` contains API keys - Keep secure
- All sensitive files are in `.gitignore`

---

## 🎯 Next Steps

1. ✅ Backend is built
2. ⏳ Run `npm run auth` to authenticate
3. ⏳ Add your OpenAI API key to `.env`
4. ⏳ Run `npm run dev` to start server
5. ⏳ Send test email to yourself
6. ⏳ Connect frontend to backend

---

**Created for Grand Quarters by GQ-AI** 🏛️

