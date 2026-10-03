# Villa Stefano - booking form and Airbnb calendar sync

One-time setup. Nothing secret goes in this repository: private links and keys live only in Apps Script's Script Properties.

## How it works

- **Airbnb -> website.** The website asks the Apps Script for booked nights. The script reads the Airbnb calendar export plus the "direct" Google Calendar, merges them and returns date ranges only (no guest data). It is cached for 10 minutes, and the full feed is re-read every time, so cancellations on Airbnb reopen the dates on the website automatically.
- **Website -> Airbnb.** Enquiries land in the Google Sheet as `New`. When you set **Status** to `Confirmed`, the script re-checks Airbnb and, if the dates are still free, creates an all-day event in the direct calendar. Airbnb imports that calendar and blocks the dates. Setting Status to `Cancelled` (or back to `New`) deletes the event and unblocks the dates.
- **Submit-time check.** When a guest submits, the script re-reads Airbnb and rejects dates taken since the page loaded.

**Limitation:** Airbnb refreshes imported calendars on its own schedule (typically every few hours). Between confirming a direct booking and Airbnb's next refresh, Airbnb can still sell those dates. Real-time sync is only available through Airbnb-approved channel managers.

## 1. Google Sheet

1. Create an empty Google Sheet (e.g. "Villa Stefano - Enquiries"). The script adds an `Enquiries` tab with English column headers.
2. Copy its ID from the URL: `docs.google.com/spreadsheets/d/`**`<SHEET_ID>`**`/edit`.

## 2. Direct-bookings Google Calendar

1. In Google Calendar, go to **Other calendars -> + -> Create new calendar**, name it "Villa Stefano - direct" and set the time zone to Rome.
2. In that calendar's **Settings -> Integrate calendar**, copy:
   - **Calendar ID** -> used for `DIRECT_CALENDAR_ID`
   - **Secret address in iCal format** -> used in step 7
3. Use this calendar only for direct bookings and manual blocks. Do not subscribe it to the Airbnb feed.

## 3. Airbnb export link

On Airbnb: **Calendar -> (the listing) -> Availability -> Connect calendars -> Export calendar**. Copy the `.ics` link -> used for `AIRBNB_ICAL_URL`.

## 4. Cloudflare Turnstile (spam protection)

1. Cloudflare dashboard -> **Turnstile -> Add widget**, hostname `villastefano.github.io`, mode **Managed**.
2. Copy the **Site key** (public) and the **Secret key** (private).

## 5. Apps Script

1. Go to [script.google.com](https://script.google.com) -> **New project**, and paste in the contents of `Code.gs`.
2. **Project Settings**: set the time zone to `(GMT+01:00) Rome` (Europe/Rome).
3. **Project Settings -> Script Properties**, add:

| Property | Value |
|---|---|
| `SHEET_ID` | from step 1 |
| `DIRECT_CALENDAR_ID` | from step 2 |
| `AIRBNB_ICAL_URL` | from step 3 |
| `TURNSTILE_SECRET` | Turnstile secret key |
| `ALLOWED_HOSTNAME` | `villastefano.github.io` |

4. In the editor, select the `setup` function and click **Run**, then approve the permissions. This creates the sheet headers and the Status dropdown, installs the confirmation trigger and tests both calendars. Fix any error it reports before continuing.
5. **Deploy -> New deployment -> Web app**: *Execute as* **Me**, *Who has access* **Anyone**. Copy the web app URL (ends in `/exec`).

## 6. Website

Fill in `secure-form-config.js` and commit:

```js
window.VILLA_STEFANO_SECURE_FORM = {
  endpoint: 'https://script.google.com/macros/s/.../exec',
  turnstileSiteKey: '<Turnstile site key>'
};
```

The availability calendar appears on the form as soon as `endpoint` is set.

## 7. Airbnb import

On Airbnb: **Availability -> Connect calendars -> Import calendar**. Paste the Google **Secret address in iCal format** from step 2 and name it "Villa Stefano - direct".

## Day-to-day

- **Confirm a direct booking:** set Status to `Confirmed`. A pop-up confirms it, or says the dates are no longer free (Status then goes back to `New`, with a note on the cell).
- **Cancel:** set Status to `Cancelled`.
- **Change dates after confirming:** set Status to `Cancelled`, correct Check-in/Check-out, then set `Confirmed` again.
- **Block dates for yourself (maintenance, family):** add an all-day event in the direct calendar. It blocks both the website and Airbnb.
- **After editing the code:** **Deploy -> Manage deployments -> Edit -> Version: New version**. This keeps the same URL. A *new* deployment changes the URL and breaks the website.
