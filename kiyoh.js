/**
 * Kiyoh signup link builder.
 *
 * Lazy route: we don't provision the account ourselves. After payment
 * we just send the customer to https://kiyoh.com/signup with their
 * details prefilled via query string, and they finish the form.
 *
 * Configure via config.json (or env):
 *   kiyohSignupUrl  defaults to "https://kiyoh.com/signup"
 */

const DEFAULT_SIGNUP_URL = 'https://kiyoh.com/signup';

function splitStreet(streetLine) {
  if (!streetLine) return { street: '', houseNumber: '', houseNumberExtension: '' };
  const m = streetLine.trim().match(/^(.+?)\s+(\d+)\s*([a-zA-Z0-9\-\/]*)\s*$/);
  if (!m) return { street: streetLine, houseNumber: '', houseNumberExtension: '' };
  return { street: m[1].trim(), houseNumber: m[2], houseNumberExtension: (m[3] || '').trim() };
}

/**
 * Build a kiyoh.com/signup URL with the customer's data prefilled as
 * query params. Field names match the form inputs on the signup page.
 */
function buildSignupUrl(metadata, baseUrl = DEFAULT_SIGNUP_URL) {
  const { street, houseNumber, houseNumberExtension } = splitStreet(metadata.businessAddress);

  const params = new URLSearchParams();
  if (metadata.businessName)    params.set('name', metadata.businessName);
  if (metadata.customerName)    params.set('accountName', metadata.customerName);
  if (metadata.customerEmail)   params.set('accountEmail', metadata.customerEmail);
  if (metadata.customerPhone)   params.set('phoneNumber', metadata.customerPhone);
  if (metadata.customerPhone)   params.set('telephone', metadata.customerPhone);
  if (metadata.website)         params.set('website', metadata.website);
  if (street)                   params.set('street', street);
  if (houseNumber)              params.set('houseNumber', houseNumber);
  if (houseNumberExtension)     params.set('houseNumberExtension', houseNumberExtension);
  if (metadata.businessPostal)  params.set('postCode', metadata.businessPostal);
  if (metadata.businessCity)    params.set('city', metadata.businessCity);
  if (metadata.businessCountry) params.set('country', metadata.businessCountry);

  const qs = params.toString();
  return qs ? `${baseUrl}?${qs}` : baseUrl;
}

module.exports = { buildSignupUrl };
