import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import http from 'http';
import url from 'url';
import open from 'open';

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const TOKEN_PATH = path.join(__dirname, '../../token.json');
const CREDENTIALS_PATH = path.join(__dirname, '../../credentials.json');

export class GmailAuthService {
  private oAuth2Client: OAuth2Client | null = null;

  async getAuthClient(): Promise<OAuth2Client> {
    if (this.oAuth2Client) {
      return this.oAuth2Client;
    }

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    const { client_id, client_secret, redirect_uris } = credentials.web;

    const redirectUri = process.env.GOOGLE_REDIRECT_URI || redirect_uris[0];
    this.oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

    // Check if we have a token
    if (fs.existsSync(TOKEN_PATH)) {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
      this.oAuth2Client.setCredentials(token);
      
      // Refresh token if expired
      this.oAuth2Client.on('tokens', (tokens) => {
        if (tokens.refresh_token) {
          const currentTokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
          currentTokens.refresh_token = tokens.refresh_token;
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(currentTokens, null, 2));
        }
      });

      return this.oAuth2Client;
    }

    // Need to authenticate
    throw new Error('No token found. Please run authentication first.');
  }

  async authenticate(): Promise<void> {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    const { client_id, client_secret, redirect_uris } = credentials.web;
    
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || redirect_uris[0];
    this.oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

    return new Promise((resolve, reject) => {
      const authUrl = this.oAuth2Client!.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
      });

      console.log('\n🔐 Opening browser for authentication...');
      console.log('If browser doesn\'t open, go to this URL:');
      console.log(authUrl);
      console.log('');

      // Create temporary server to receive callback
      const server = http.createServer(async (req, res) => {
        if (req.url?.startsWith('/oauth2callback')) {
          const queryParams = url.parse(req.url, true).query;
          const code = queryParams.code as string;

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>✅ Authentication successful!</h1><p>You can close this window.</p>');

          server.close();

          try {
            const { tokens } = await this.oAuth2Client!.getToken(code);
            this.oAuth2Client!.setCredentials(tokens);
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
            console.log('✅ Token saved to', TOKEN_PATH);
            resolve();
          } catch (error) {
            console.error('❌ Error getting tokens:', error);
            reject(error);
          }
        }
      });

      server.listen(4000, () => {
        console.log('🚀 Listening on http://localhost:4000');
        // Open browser
        open(authUrl);
      });
    });
  }
}

export const gmailAuthService = new GmailAuthService();

