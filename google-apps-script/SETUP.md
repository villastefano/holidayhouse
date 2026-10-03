# Villa Stefano - booking form and Airbnb calendar sync

One-time setup, about 20 minutes. Use the same Google account throughout (Sheet, Calendar and Apps Script). Nothing secret goes in this repository: private links and keys live only in Apps Script's Script Properties.

## How it works

- **Airbnb -> website.** The website asks the Apps Script for booked nights. The script reads the Airbnb calendar export plus the "direct" Google Calendar, merges them and returns date ranges only (no guest data). It is cached for 10 minutes, and the full feed is re-read every time, so cancellations on Airbnb reopen the dates on the website automatically.
- **Website -> Airbnb.** Enquiries land in the Google Sheet as `New`. When you set **Status** to `Confirmed`, the script re-checks Airbnb and, if the dates are still free, creates an all-day event in the direct calendar. Airbnb imports that calendar and blocks the dates. Setting Status to `Cancelled` (or back to `New`) deletes the event and unblocks the dates.
- **Submit-time check.** When a guest submits, the script re-reads Airbnb and rejects dates taken since the page loaded. If the Airbnb feed is down, the enquiry is still accepted; the check at confirmation still applies.
- **Enquiries.** Each valid enquiry is logged in the Sheet, the guest's message is translated into English, and WhatsApp opens with a pre-filled English summary for you. Repeat submissions from the same email within 90 seconds are not logged twice.

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
3. If the site later moves to a custom domain, add it to the widget and update `ALLOWED_HOSTNAME` in step 5.

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

4. In the editor, select the `setup` function and click **Run**, then approve the permissions. This creates the sheet headers and the Status dropdown, installs the Status trigger plus a sync that runs every 10 minutes, and tests both calendars. Fix any error it reports before continuing. It is safe to run again.
5. **Deploy -> New deployment -> Web app**: *Execute as* **Me**, *Who has access* **Anyone**. Copy the web app URL (ends in `/exec`).
6. **Check it works:** open `<web app URL>?action=availability` in a browser. You should see `{"ok":true,"booked":[...]}` listing your current Airbnb bookings. `{"ok":false}` means a property or calendar is wrong - check **Executions** in the Apps Script sidebar for the error.

## 6. Website

Fill in `secure-form-config.js` and commit it to the branch GitHub Pages publishes:

```js
window.VILLA_STEFANO_SECURE_FORM = {
  endpoint: 'https://script.google.com/macros/s/.../exec',
  turnstileSiteKey: '<Turnstile site key>'
};
```

Once the site has republished (a minute or two), the availability calendar appears on the form and submissions go through the Apps Script.

## 7. Airbnb import

On Airbnb: **Availability -> Connect calendars -> Import calendar**. Paste the Google **Secret address in iCal format** from step 2 and name it "Villa Stefano - direct".

**End-to-end test:** submit a test enquiry on the website for free dates, set its Status to `Confirmed`, and check the dates show as blocked on the website straight away and on Airbnb within a few hours. Then set it to `Cancelled` and check both free up again.

## Day-to-day

- **New enquiries** arrive on WhatsApp and as a `New` row in the Sheet. Nothing is blocked until you confirm.
- **Confirm a direct booking:** set Status to `Confirmed`. Normally the event appears in the direct calendar within seconds, with a pop-up; if not, the 10-minute sync picks it up. To sync immediately, use the Sheet menu **Villa Stefano -> Sync confirmed bookings now** (reload the Sheet if the menu is missing). If the dates are no longer free, Status goes back to `New` with a note on the cell.
- **Check it worked:** the **Calendar event ID** column is filled once the dates are blocked.
- **Cancel:** set Status to `Cancelled`.
- **Change dates after confirming:** set Status to `Cancelled`, correct Check-in/Check-out, then set `Confirmed` again.
- **Block dates for yourself (maintenance, family):** add an all-day event in the direct calendar. It blocks both the website and Airbnb.
- **Keep the private links private:** the Airbnb export link and the Google secret iCal address each give read access to your bookings. If one leaks, reset it (Airbnb: export a new link; Google: **Reset** next to the secret address) and update Script Properties or the Airbnb import.
- **After editing the code:** paste the new `Code.gs`, run `setup` again, then **Deploy -> Manage deployments -> Edit -> Version: New version**. This keeps the same URL. A *new* deployment changes the URL and breaks the website.
