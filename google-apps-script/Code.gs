/**
 * Villa Stefano — private lead collector
 *
 * Required Script Properties:
 *   SHEET_ID          (your Google Sheet ID — set it in Script Properties, not here)
 *   TURNSTILE_SECRET  (never place this value on the website)
 *   ALLOWED_HOSTNAME  villastefano.github.io
 *   AIRBNB_ICAL_URL   Airbnb > Calendar > Availability > Connect calendars > Export (private link, never on the website)
 *   DIRECT_CALENDAR_ID  ID of the Google Calendar holding confirmed direct bookings
 *   NOTIFY_EMAIL      (optional) where enquiry emails go; defaults to the script owner's address
 *
 * Run setup() once from the editor after setting the properties.
 */

const SHEET_NAME = 'Enquiries';
const STATUS_COLUMN = 15;
const EVENT_ID_COLUMN = 17;
const STATUS_NEW = 'New';
const STATUS_CONFIRMED = 'Confirmed';
const STATUS_CANCELLED = 'Cancelled';
const AVAILABILITY_CACHE_KEY = 'villa-stefano:availability';
const AVAILABILITY_CACHE_SECONDS = 600;
const AVAILABILITY_HORIZON_DAYS = 550;
const REQUIRED_FIELDS = ['firstName', 'lastName', 'phone', 'email', 'checkin', 'checkout', 'guests', 'adults', 'children', 'infants', 'language'];

function doGet(event) {
  const action = event && event.parameter ? event.parameter.action : '';
  if (action !== 'availability') return reply_({ ok: false, message: 'Not available.' });
  try {
    return reply_({ ok: true, booked: getBookedRanges_(false) });
  } catch (error) {
    console.error(error);
    return reply_({ ok: false });
  }
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
    // Re-check against a fresh Airbnb read: the visitor's page may be minutes old.
    // If the feed is down, accept the enquiry; confirmation re-checks before blocking.
    if (isUnavailable_(clean_(data.checkin), clean_(data.checkout))) return reply_({ ok: false, error: 'unavailable' });
    const translatedMessage = translateToEnglish_(clean_(data.message), clean_(data.language));

    // Avoid accidental double-clicks and basic form flooding.
    const cacheKey = Utilities.base64EncodeWebSafe(`villa-stefano:${data.email.toLowerCase()}`);
    const cache = CacheService.getScriptCache();
    if (cache.get(cacheKey)) return reply_({ ok: true, whatsapp: whatsAppUrl_(data, translatedMessage) });

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
      STATUS_NEW,
      'Website',
      ''
    ]);
    cache.put(cacheKey, '1', 90);
    notifyOwner_(data, translatedMessage);
    // The website opens WhatsApp itself: Apps Script pages cannot redirect the browser.
    return reply_({ ok: true, whatsapp: whatsAppUrl_(data, translatedMessage) });
  } catch (error) {
    console.error(error);
    return reply_({ ok: false, error: 'failed' });
  }
}

function getOrCreateSheet_() {
  const sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!sheetId) throw new Error('SHEET_ID is not configured.');

  const spreadsheet = SpreadsheetApp.openById(sheetId);
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Enquiry date', 'Language', 'First name', 'Last name', 'Phone', 'Email', 'Check-in', 'Check-out', 'Total guests', 'Adults', 'Children', 'Infants', 'Original message', 'Message (English translation)', 'Status', 'Source', 'Calendar event ID']);
    sheet.setFrozenRows(1);
    const statusRule = SpreadsheetApp.newDataValidation()
      .requireValueInList([STATUS_NEW, STATUS_CONFIRMED, STATUS_CANCELLED], true)
      .build();
    sheet.getRange(2, STATUS_COLUMN, sheet.getMaxRows() - 1, 1).setDataValidation(statusRule);
  }
  return sheet;
}

/**
 * Run once from the Apps Script editor (safe to re-run): creates the sheet,
 * installs the Status edit trigger plus a 10-minute safety-net sync, and
 * tests both calendars.
 */
function setup() {
  const sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  getOrCreateSheet_();
  ScriptApp.getProjectTriggers()
    .filter((trigger) => ['handleStatusEdit', 'syncAll'].includes(trigger.getHandlerFunction()))
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('handleStatusEdit').forSpreadsheet(sheetId).onEdit().create();
  ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(10).create();
  getDirectCalendar_();
  getBookedRanges_(true);
  MailApp.getRemainingDailyQuota();
  syncAll();
}

/** Adds a "Villa Stefano" menu to the Sheet for an on-demand sync. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Villa Stefano').addItem('Sync confirmed bookings now', 'syncAll').addToUi();
}

/**
 * Reconciles every row with the direct calendar. Runs every 10 minutes and
 * from the menu, so a missed or failed edit trigger catches up on its own.
 */
function syncAll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const sheet = getOrCreateSheet_();
    for (let row = 2; row <= sheet.getLastRow(); row++) {
      try {
        syncRow_(sheet, row, null);
      } catch (error) {
        console.error(`Row ${row}: ${error}`);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Installable onEdit trigger. 'Confirmed' creates an all-day event in the
 * direct calendar (which Airbnb imports); any other status removes it.
 */
function handleStatusEdit(event) {
  const range = event.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== SHEET_NAME || range.getRow() < 2 || range.getColumn() > STATUS_COLUMN || range.getLastColumn() < STATUS_COLUMN) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    for (let row = range.getRow(); row <= range.getLastRow(); row++) syncRow_(sheet, row, event.source);
  } finally {
    lock.releaseLock();
  }
}

function syncRow_(sheet, row, spreadsheet) {
  const notify = (message) => { if (spreadsheet) spreadsheet.toast(message, 'Villa Stefano', 10); };
  const values = sheet.getRange(row, 1, 1, EVENT_ID_COLUMN).getValues()[0];
  const status = String(values[STATUS_COLUMN - 1]).trim();
  const eventId = String(values[EVENT_ID_COLUMN - 1] || '').trim();

  if (status === STATUS_CONFIRMED && !eventId) {
    const checkin = toIsoDate_(values[6]);
    const checkout = toIsoDate_(values[7]);
    if (overlapsBooked_(checkin, checkout, getBookedRanges_(true))) {
      sheet.getRange(row, STATUS_COLUMN).setValue(STATUS_NEW).setNote(`Not confirmed on ${new Date().toLocaleString('en-GB')}: dates already taken on Airbnb or by another direct booking.`);
      notify(`Row ${row}: dates unavailable, booking not blocked.`);
      return;
    }
    const created = getDirectCalendar_().createAllDayEvent(
      `Villa Stefano - ${values[2]} ${values[3]} (direct)`,
      dateFromIso_(checkin),
      dateFromIso_(checkout),
      { description: `Phone: ${values[4]}\nEmail: ${values[5]}\nGuests: ${values[8]} (Adults: ${values[9]}, Children: ${values[10]}, Infants: ${values[11]})` }
    );
    sheet.getRange(row, EVENT_ID_COLUMN).setValue(created.getId());
    sheet.getRange(row, STATUS_COLUMN).clearNote();
    CacheService.getScriptCache().remove(AVAILABILITY_CACHE_KEY);
    notify(`Row ${row}: dates blocked. Airbnb will update within a few hours.`);
  } else if (status !== STATUS_CONFIRMED && eventId) {
    const existing = getDirectCalendar_().getEventById(eventId);
    if (existing) existing.deleteEvent();
    sheet.getRange(row, EVENT_ID_COLUMN).clearContent();
    CacheService.getScriptCache().remove(AVAILABILITY_CACHE_KEY);
    notify(`Row ${row}: dates released. Airbnb will update within a few hours.`);
  }
}

function getDirectCalendar_() {
  const calendarId = PropertiesService.getScriptProperties().getProperty('DIRECT_CALENDAR_ID');
  if (!calendarId) throw new Error('DIRECT_CALENDAR_ID is not configured.');
  const calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) throw new Error('Direct calendar not found.');
  return calendar;
}

/**
 * Booked nights as [{ start, end }] in yyyy-MM-dd, end exclusive (the
 * check-out day stays free for a new arrival). Rebuilt in full from both
 * calendars on every read, so cancellations free the dates automatically.
 */
function getBookedRanges_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const cached = cache.get(AVAILABILITY_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  }

  const today = toIsoDate_(new Date());
  const horizon = toIsoDate_(new Date(Date.now() + AVAILABILITY_HORIZON_DAYS * 86400000));
  const ranges = fetchAirbnbRanges_().concat(fetchDirectRanges_(today, horizon))
    .filter((range) => range.end > today && range.start < horizon && range.end > range.start)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const merged = [];
  ranges.forEach((range) => {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  });

  cache.put(AVAILABILITY_CACHE_KEY, JSON.stringify(merged), AVAILABILITY_CACHE_SECONDS);
  return merged;
}

function fetchAirbnbRanges_() {
  const url = PropertiesService.getScriptProperties().getProperty('AIRBNB_ICAL_URL');
  if (!url) throw new Error('AIRBNB_ICAL_URL is not configured.');
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw new Error(`Airbnb calendar returned ${response.getResponseCode()}.`);
  const text = response.getContentText();
  if (text.indexOf('BEGIN:VCALENDAR') === -1) throw new Error('Airbnb calendar is not a valid iCal feed.');

  // Unfold continuation lines (RFC 5545), then read each VEVENT's dates.
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const ranges = [];
  let current = null;
  lines.forEach((line) => {
    if (line === 'BEGIN:VEVENT') current = {};
    else if (line === 'END:VEVENT') {
      if (current && current.start) ranges.push({ start: current.start, end: current.end || addDaysIso_(current.start, 1) });
      current = null;
    } else if (current) {
      const match = line.match(/^(DTSTART|DTEND)[^:]*:(\d{4})(\d{2})(\d{2})/);
      if (match) current[match[1] === 'DTSTART' ? 'start' : 'end'] = `${match[2]}-${match[3]}-${match[4]}`;
    }
  });
  return ranges;
}

function fetchDirectRanges_(fromIso, toIso) {
  return getDirectCalendar_().getEvents(dateFromIso_(fromIso), dateFromIso_(toIso)).map((calendarEvent) => {
    if (calendarEvent.isAllDayEvent()) {
      return { start: toIsoDate_(calendarEvent.getAllDayStartDate()), end: toIsoDate_(calendarEvent.getAllDayEndDate()) };
    }
    // Manually added timed events: the end day is the check-out day; a same-day event blocks that night.
    const startIso = toIsoDate_(calendarEvent.getStartTime());
    const endIso = toIsoDate_(calendarEvent.getEndTime());
    return { start: startIso, end: endIso > startIso ? endIso : addDaysIso_(startIso, 1) };
  });
}

function isUnavailable_(checkin, checkout) {
  try {
    return overlapsBooked_(checkin, checkout, getBookedRanges_(true));
  } catch (error) {
    console.error(error);
    return false;
  }
}

function overlapsBooked_(checkin, checkout, ranges) {
  return ranges.some((range) => checkin < range.end && checkout > range.start);
}

function toIsoDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(value || '').trim().slice(0, 10);
}

function dateFromIso_(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addDaysIso_(value, days) {
  const date = dateFromIso_(value);
  date.setDate(date.getDate() + days);
  return toIsoDate_(date);
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

function translateToEnglish_(message, language) {
  if (!message || language === 'en') return message;
  const sourceLanguage = { it: 'it', es: 'es', fr: 'fr' }[language];
  return sourceLanguage ? LanguageApp.translate(message, sourceLanguage, 'en') : message;
}

function enquirySummary_(data, translatedMessage) {
  return [
    'New enquiry for Villa Stefano',
    '',
    `First name: ${clean_(data.firstName)}`,
    `Last name: ${clean_(data.lastName)}`,
    `Phone: ${clean_(data.phone)}`,
    `Email: ${clean_(data.email)}`,
    `Check-in: ${formatDateEnglish_(clean_(data.checkin))}`,
    `Check-out: ${formatDateEnglish_(clean_(data.checkout))}`,
    `Guests: ${clean_(data.guests)} (Adults: ${clean_(data.adults)}, Children: ${clean_(data.children)}, Infants: ${clean_(data.infants)})`,
    translatedMessage ? `\nMessage: ${translatedMessage}` : ''
  ].filter(Boolean).join('\n');
}

function whatsAppUrl_(data, translatedMessage) {
  return `https://wa.me/4407843936267?text=${encodeURIComponent(enquirySummary_(data, translatedMessage))}`;
}

// Email copy of every enquiry, so nothing depends on the guest having WhatsApp.
// A failure here never blocks the enquiry: it is already in the Sheet.
function notifyOwner_(data, translatedMessage) {
  try {
    const recipient = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL') || Session.getEffectiveUser().getEmail();
    const original = clean_(data.message);
    const body = [
      enquirySummary_(data, translatedMessage),
      original && original !== translatedMessage ? `\nOriginal message (${clean_(data.language)}): ${original}` : '',
      `\nSheet: https://docs.google.com/spreadsheets/d/${PropertiesService.getScriptProperties().getProperty('SHEET_ID')}/edit`,
      'Set Status to Confirmed to block the dates on the website and Airbnb.'
    ].filter(Boolean).join('\n');
    MailApp.sendEmail({
      to: recipient,
      replyTo: clean_(data.email),
      subject: `Villa Stefano enquiry: ${clean_(data.firstName)} ${clean_(data.lastName)}, ${formatDateEnglish_(clean_(data.checkin))} - ${formatDateEnglish_(clean_(data.checkout))}`,
      body: body
    });
  } catch (error) {
    console.error(error);
  }
}

function formatDateEnglish_(value) {
  const [year, month, day] = value.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${day} ${months[month - 1]} ${year}`;
}

function reply_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
