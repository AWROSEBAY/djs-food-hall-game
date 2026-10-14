# DJs Food Hall game

Snakes and ladders loyalty game for the DJs Food Hall (David Jones Elizabeth St, Sydney), run by Create Catering.
Customers sign in with their mobile, earn rolls from paid Square orders, move up a 50-square board,
win instant prizes, and finishers go into the season's grand prize draw.

It's a web app (works in the phone browser, can be added to the home screen). No App Store needed.

## How it works

1. Customer signs up with their mobile number and a 6-digit SMS code, and accepts the game terms.
2. They pay at any DJES outlet in Square. Square sends a webhook to this app.
3. The app finds the customer's mobile from the payment (the Square customer on the payment, or the
   pickup phone number on a kiosk/online order) and grants rolls:
   - $10 minimum order (excludes tips), $8 at Cool Press Juice Bar
   - 1 roll, or 2 for orders paid before 11:30 or from 2pm (Sydney time)
   - max 3 rolls per person per day
   - an off-peak order also gives a snake shield (hold 1 at a time)
   - a refund that takes the order under $10 removes its unused rolls
4. Customer rolls in the app. Ladders lift, snakes drop at most 3 squares and never below a checkpoint
   (10, 20, 30, 40). A shield blocks one snake.
5. Each roll has a chance of an instant prize. Prizes are only awarded if total prize cost stays within
   3% of tracked revenue plus a $200 starting float, and stock is released evenly across the 8 weeks.
6. Customer shows the prize code at the counter. Staff redeem it at `/staff.html` with the staff PIN.
7. Square 50 = finished, entered in the grand prize draw (`/api/admin/finishers`).

All rules live in `src/config.js`. The logic is in `src/engine.js` (pure, unit tested).

**Important:** rolls only come from Square. A counter sale with no phone attached earns nothing.
For counter sales to count, the customer's phone must be on the payment, which in practice means turning on
Square Loyalty (or the customer-capture prompt) on the Square terminals so customers enter their mobile at
payment. Kiosk and online orders already capture a phone number.

## Run it locally

Needs Node 22.13 or later. No npm packages to install.

```
SMS_PROVIDER=console DEV_PURCHASES=1 SEASON_START=2026-10-01 STAFF_PIN=1234 ADMIN_TOKEN=change-me npm start
```

Open http://localhost:3000. SMS codes print in the terminal. `DEV_PURCHASES=1` shows a "fake a Square order"
panel for testing; it is ignored when `NODE_ENV=production`.

Tests: `npm test`

## Settings (environment variables)

| Variable | What it is |
|---|---|
| `NODE_ENV` | `production` on the live server (secure cookies, test panel off) |
| `PORT` | default 3000 |
| `DB_PATH` | SQLite file, default `./data/game.db`. Must be on persistent storage and backed up |
| `APP_URL` | public URL, used in SMS links |
| `SEASON_START` | Sydney date the season starts, e.g. `2026-11-02` |
| `SQUARE_ENV` | `sandbox` for testing, otherwise production |
| `SQUARE_ACCESS_TOKEN` | Square app access token with `PAYMENTS_READ`, `ORDERS_READ`, `CUSTOMERS_READ` |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | from the webhook subscription in the Square Developer Dashboard |
| `SQUARE_WEBHOOK_URL` | the exact notification URL registered in Square, e.g. `https://game.example.com/webhooks/square` |
| `SMS_PROVIDER` | `twilio` or `console` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio credentials |
| `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM` | sender (alphanumeric sender ID "DJsFoodHall" needs Twilio registration in AU) |
| `JUICE_BAR_LOCATION_ID` | Square location ID for Cool Press Juice Bar once it has its own location (it sells under Celebration today). Cool Press has an $8 minimum order |
| `STAFF_PIN` | PIN staff enter to redeem prizes |
| `ADMIN_TOKEN` | bearer token for `/api/admin/*` |

## Square setup

1. Square Developer Dashboard: create an application for the Create Catering account.
2. Production access token with `PAYMENTS_READ`, `ORDERS_READ`, `CUSTOMERS_READ`.
3. Webhook subscription to `payment.created`, `payment.updated`, `refund.created`, `refund.updated`,
   pointing at `https://<your domain>/webhooks/square`. Copy the signature key.
4. Test in the Square sandbox first (`SQUARE_ENV=sandbox`).

The nine DJES location IDs are in `src/config.js`, plus Cool Press Juice Bar from `JUICE_BAR_LOCATION_ID`. Payments at any other location are ignored.

## Admin

```
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<domain>/api/admin/summary
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<domain>/api/admin/finishers
```

Summary shows players, tracked revenue, prize cost and prize cost as a % of revenue, prizes won and redeemed,
and finishers.

## Deploying

Any host that runs a single long-lived Node process with a persistent disk works (e.g. Render, Fly.io,
Railway, a small VPS). Run one instance only: SQLite is a single file. Put it behind HTTPS.

## Before launch: checklist for the developer

- [ ] Security review of `src/server.js`, `src/auth.js`, `src/square.js` (sessions, OTP rate limits, webhook signature)
- [ ] Add per-IP rate limiting on `/api/auth/start` (current limit is per phone number)
- [ ] Backups for the SQLite file
- [ ] Twilio account and AU sender registration
- [ ] Square production app, token and webhook as above; test with a real $10 order at each outlet
- [ ] Square Loyalty / customer phone capture on counter terminals (otherwise counter sales won't earn rolls)
- [ ] Final game terms and privacy policy (`web/terms.html` is a placeholder), checked by a lawyer:
      trade promotion rules for each state entrants may live in, 18+ for alcohol prizes, Spam Act consent for SMS
- [ ] Set real prize costs, quantities, win chance and season start date in `src/config.js`
- [ ] Domain, e.g. play.djsfoodhall.com.au

## Not built yet

- Push notifications (SMS only for now)
- Admin screen (admin is JSON endpoints for now)
- Grand prize draw tool (export finishers and draw manually, under the terms)
- Linking to DJs / Qantas loyalty
