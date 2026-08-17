import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

const listingUrl = 'https://www.airbnb.it/rooms/6303698?locale=it';
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ locale: 'it-IT' });
  await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const text = await page.locator('body').innerText();

  const match = text.match(/Valutazione di\s*([\d,.]+)\s*stelle su 5[\s\S]{0,100}?([\d.]+)\s*recensioni/i)
    || text.match(/([\d,.]+)\s*·\s*([\d.]+)\s*recensioni/i);

  if (!match) throw new Error('Rating and review count not found on the listing page.');

  const rating = Number(match[1].replace(',', '.'));
  const reviews = Number(match[2].replace('.', ''));
  if (!Number.isFinite(rating) || !Number.isFinite(reviews)) throw new Error('Could not parse Airbnb stats.');

  const previous = JSON.parse(await readFile('stats.json', 'utf8'));
  const next = { ...previous, rating, reviews, updatedAt: new Date().toISOString(), source: 'Airbnb' };
  await writeFile('stats.json', `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Updated Airbnb stats: ${rating} stars, ${reviews} reviews.`);
} finally {
  await browser.close();
}
