const axios = require('axios');
const db = require('./db');

/**
 * Exact Online Integration Helper
 * handles OAuth2 and Relation Creation
 */

const EXACT_BASE_URL = 'https://start.exactonline.nl';
const REDIRECT_URI = process.env.EXACT_REDIRECT_URI || 'https://payment.kiyoh.com/api/exact/callback';

/**
 * Get the Authorization URL for the user to link their account
 */
function getAuthUrl() {
  const clientId = process.env.EXACT_CLIENT_ID;
  if (!clientId) return null;
  
  return `${EXACT_BASE_URL}/api/oauth2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code`;
}

/**
 * Exchange Authorization Code for Tokens
 */
async function getTokensFromCode(code) {
  const params = new URLSearchParams();
  params.append('client_id', process.env.EXACT_CLIENT_ID);
  params.append('client_secret', process.env.EXACT_CLIENT_SECRET);
  params.append('grant_type', 'authorization_code');
  params.append('code', code);
  params.append('redirect_uri', REDIRECT_URI);

  const response = await axios.post(`${EXACT_BASE_URL}/api/oauth2/token`, params);
  return response.data; // { access_token, refresh_token, expires_in }
}

/**
 * Refresh Access Token
 */
async function refreshTokens(refreshToken) {
  const params = new URLSearchParams();
  params.append('client_id', process.env.EXACT_CLIENT_ID);
  params.append('client_secret', process.env.EXACT_CLIENT_SECRET);
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);

  const response = await axios.post(`${EXACT_BASE_URL}/api/oauth2/token`, params);
  return response.data;
}

/**
 * Create a new Relation (Account) in Exact Online
 */
async function createRelation(customerData) {
  const config = await db.loadSettings({});
  const exactToken = config.exactToken;

  if (!exactToken || !exactToken.access_token) {
    throw new Error('Exact Online not linked. Please visit /api/exact/auth');
  }

  try {
    // 1. Get Me (to get Division)
    let divisionResponse = await axios.get(`${EXACT_BASE_URL}/api/v1/current/Me`, {
      headers: { Authorization: `Bearer ${exactToken.access_token}` }
    });
    const division = divisionResponse.data.d.results[0].CurrentDivision;

    // 2. Create Account
    // Mapping Mollie metadata to Exact fields
    const accountData = {
       Name: customerData.businessName || customerData.customerName,
       Email: customerData.customerEmail,
       Phone: customerData.customerPhone,
       Website: customerData.website,
       Status: 'C', // Customer
       AddressLine1: '', // Would need more fields in checkout to populate
       Postcode: '',
       City: '',
       Country: 'NL',
       Language: 'NL'
    };

    const response = await axios.post(`${EXACT_BASE_URL}/api/v1/${division}/crm/Accounts`, accountData, {
      headers: { 
        Authorization: `Bearer ${exactToken.access_token}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('Exact Online Relation Created:', response.data.d.ID);
    return response.data.d;
  } catch (err) {
    if (err.response && err.response.status === 401) {
      console.log('Exact Token expired, refreshing...');
      const newTokens = await refreshTokens(exactToken.refresh_token);
      config.exactToken = newTokens;
      await db.saveSettings(config);
      return createRelation(customerData); // Retry once
    }
    throw err;
  }
}

module.exports = {
  getAuthUrl,
  getTokensFromCode,
  createRelation
};
