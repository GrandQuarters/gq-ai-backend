import dotenv from 'dotenv';
import { gmailAuthService } from './services/gmail-auth.service';

dotenv.config();

async function main() {
  console.log('\n🔐 GQ-AI Gmail Authentication\n');
  console.log('This will open your browser to authorize Gmail access.');
  console.log('Please login with:', process.env.GMAIL_USER);
  console.log('\nStarting authentication in 3 seconds...\n');

  setTimeout(async () => {
    try {
      await gmailAuthService.authenticate();
      console.log('\n✅ Authentication successful!');
      console.log('🎉 You can now start the backend server with: npm run dev\n');
      process.exit(0);
    } catch (error) {
      console.error('\n❌ Authentication failed:', error);
      process.exit(1);
    }
  }, 3000);
}

main();

