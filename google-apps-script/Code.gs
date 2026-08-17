/**
 * Villa Stefano — private lead collector
 *
 * Required Script Properties:
 *   SHEET_ID          1-21rD2qo5CekQ-tZVW1jYD56u3W9ZW831UcRMa4YiQ0
 *   TURNSTILE_SECRET  (never place this value on the website)
 *   ALLOWED_HOSTNAME  villastefano.github.io
 */

const SHEET_NAME = 'Richieste';
const REQUIRED_FIELDS = ['firstName', 'lastName', 'phone', 'email', 'checkin', 'checkout', 'guests', 'adults', 'children', 'infants', 'language'];

function doGet() {
  return reply_({ ok: false, message: 'Not available.' });
}

function doPost(event) {
  try {
    const data = event && event.parameter ? event.parameter : {};

    // Honeypot: real visitors never see or fill this field.
    if (data.website) return reply_({ ok: true });
    REQUIRED_FIELDS.forEach((field) => {
      if (!String(data[field] || '').trim()) throw new Error(`Missing field: ${field}`);
    });
    data.turnstile = data.turnstile || data['cf-turnstile-response'];
    if (!data.turnstile) throw new Error('Missing Turnstile token.');

    validateLead_(data);
    if (!verifyTurnstile_(data.turnstile)) throw new Error('Turnstile validation failed.');
    const translatedMessage = translateToItalian_(clean_(data.message), clean_(data.language));

    // Avoid accidental double-clicks and basic form flooding.
    const cacheKey = Utilities.base64EncodeWebSafe(`villa-stefano:${data.email.toLowerCase()}`);
    const cache = CacheService.getScriptCache();
    if (cache.get(cacheKey)) return redirectToWhatsApp_(data, translatedMessage);

    const sheet = getOrCreateSheet_();
    sheet.appendRow([
      new Date(),
      clean_(data.language),
      clean_(data.firstName),
      clean_(data.lastName),
      clean_(data.phone),
      clean_(data.email).toLowerCase(),
      clean_(data.checkin),
      clean_(data.checkout),
      Number(data.guests),
      Number(data.adults),
      Number(data.children),
      Number(data.infants),
      clean_(data.message),
      translatedMessage,
      'Nuova',
      'Sito web'
    ]);
    cache.put(cacheKey, '1', 90);
    return redirectToWhatsApp_(data, translatedMessage);
  } catch (error) {
    console.error(error);
    return HtmlService.createHtmlOutput('<p>Unable to send your request. Please return to the website and try again.</p>');
  }
}

function getOrCreateSheet_() {
  const sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!sheetId) throw new Error('SHEET_ID is not configured.');

  const spreadsheet = SpreadsheetApp.openById(sheetId);
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Data richiesta', 'Lingua', 'Nome', 'Cognome', 'Telefono', 'Email', 'Check-in', 'Check-out', 'Ospiti totali', 'Adulti', 'Bambini', 'Neonati', 'Messaggio originale', 'Messaggio tradotto in italiano', 'Stato', 'Fonte']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function verifyTurnstile_(token) {
  const properties = PropertiesService.getScriptProperties();
  const secret = properties.getProperty('TURNSTILE_SECRET');
  const allowedHostname = properties.getProperty('ALLOWED_HOSTNAME');
  if (!secret || !allowedHostname) throw new Error('Turnstile settings are not configured.');

  const response = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'post',
    payload: { secret: secret, response: token },
    muteHttpExceptions: true
  });
  const result = JSON.parse(response.getContentText());
  return result.success === true && result.hostname === allowedHostname;
}

function validateLead_(data) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean_(data.email))) throw new Error('Invalid email.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean_(data.checkin)) || !/^\d{4}-\d{2}-\d{2}$/.test(clean_(data.checkout))) throw new Error('Invalid dates.');
  if (clean_(data.checkout) <= clean_(data.checkin)) throw new Error('Check-out must be after check-in.');
  const maxCheckout = new Date(`${clean_(data.checkin)}T00:00:00`);
  maxCheckout.setDate(maxCheckout.getDate() + 30);
  if (new Date(`${clean_(data.checkout)}T00:00:00`) > maxCheckout) throw new Error('Stay exceeds 30 days.');
  if (!Number.isInteger(Number(data.guests)) || Number(data.guests) < 1 || Number(data.guests) > 9) throw new Error('Invalid guest count.');
  const guestTypes = Number(data.adults) + Number(data.children) + Number(data.infants);
  if (Number(data.adults) < 1 || guestTypes !== Number(data.guests)) throw new Error('Invalid guest types.');
  if (!['it', 'en', 'es', 'fr'].includes(clean_(data.language))) throw new Error('Invalid language.');
}

function clean_(value) {
  return String(value || '').trim().slice(0, 500);
}

function translateToItalian_(message, language) {
  if (!message || language === 'it') return message;
  const sourceLanguage = { en: 'en', es: 'es', fr: 'fr' }[language];
  return sourceLanguage ? LanguageApp.translate(message, sourceLanguage, 'it') : message;
}

function redirectToWhatsApp_(data, translatedMessage) {
  const text = [
    'Nuova richiesta per Villa Stefano',
    '',
    `Nome: ${clean_(data.firstName)}`,
    `Cognome: ${clean_(data.lastName)}`,
    `Telefono: ${clean_(data.phone)}`,
    `Email: ${clean_(data.email)}`,
    `Check-in: ${formatDateItalian_(clean_(data.checkin))}`,
    `Check-out: ${formatDateItalian_(clean_(data.checkout))}`,
    `Ospiti: ${clean_(data.guests)} (Adulti: ${clean_(data.adults)}, Bambini: ${clean_(data.children)}, Neonati: ${clean_(data.infants)})`,
    translatedMessage ? `\nMessaggio: ${translatedMessage}` : ''
  ].filter(Boolean).join('\n');
  const url = `https://wa.me/4407843936267?text=${encodeURIComponent(text)}`;
  return HtmlService.createHtmlOutput(`<script>window.top.location.replace(${JSON.stringify(url)});</script><p>Opening WhatsApp…</p>`);
}

function formatDateItalian_(value) {
  const [year, month, day] = value.split('-').map(Number);
  const months = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  return `${String(day).padStart(2, '0')}-${months[month - 1]}-${year}`;
}

function reply_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
