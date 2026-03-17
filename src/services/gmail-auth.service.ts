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

    let clientId: string;
    let clientSecret: string;
    let redirectUri: string;

    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
      clientId = process.env.GOOGLE_CLIENT_ID;
      clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/oauth2callback';
      console.log('🔑 Gmail auth: Using environment variables for credentials');
    } else if (fs.existsSync(CREDENTIALS_PATH)) {
      const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
      const web = credentials.web || credentials.installed;
      clientId = web.client_id;
      clientSecret = web.client_secret;
      redirectUri = process.env.GOOGLE_REDIRECT_URI || web.redirect_uris?.[0] || 'http://localhost:4000/oauth2callback';
      console.log('🔑 Gmail auth: Using credentials.json file');
    } else {
      throw new Error(
        'Gmail credentials not found. Set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET env vars, or provide credentials.json'
      );
    }

    this.oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    if (process.env.GOOGLE_REFRESH_TOKEN) {
      this.oAuth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      });
      console.log('🔑 Gmail auth: Using GOOGLE_REFRESH_TOKEN from environment');
      return this.oAuth2Client;
    }

    if (fs.existsSync(TOKEN_PATH)) {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
      this.oAuth2Client.setCredentials(token);

      this.oAuth2Client.on('tokens', (tokens) => {
        if (tokens.refresh_token) {
          try {
            const currentTokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
            currentTokens.refresh_token = tokens.refresh_token;
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(currentTokens, null, 2));
          } catch {
            // On Railway there's no writable filesystem, ignore
          }
        }
      });

      console.log('🔑 Gmail auth: Using token.json file');
      return this.oAuth2Client;
    }

    throw new Error(
      'No Gmail token found. Set GOOGLE_REFRESH_TOKEN env var, or run `npm run auth` locally first.'
    );
  }

  async authenticate(): Promise<void> {
    let clientId: string;
    let clientSecret: string;
    let redirectUri: string;

    if (fs.existsSync(CREDENTIALS_PATH)) {
      const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
      const web = credentials.web || credentials.installed;
      clientId = web.client_id;
      clientSecret = web.client_secret;
      redirectUri = process.env.GOOGLE_REDIRECT_URI || web.redirect_uris?.[0] || 'http://localhost:4000/oauth2callback';
    } else {
      throw new Error('credentials.json required for interactive authentication');
    }

    this.oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

    return new Promise((resolve, reject) => {
      const authUrl = this.oAuth2Client!.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
      });

      console.log('\n🔐 Opening browser for authentication...');
      console.log('If browser doesn\'t open, go to this URL:');
      console.log(authUrl);
      console.log('');

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
            if (tokens.refresh_token) {
              console.log('\n📋 For Railway, set this env var:');
              console.log(`   GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
            }
            resolve();
          } catch (error) {
            console.error('❌ Error getting tokens:', error);
            reject(error);
          }
        }
      });

      server.listen(4000, () => {
        console.log('🚀 Listening on http://localhost:4000');
        open(authUrl);
      });
    });
  }
}

export const gmailAuthService = new GmailAuthService();
