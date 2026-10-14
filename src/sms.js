// SMS sending. SMS_PROVIDER=console prints messages instead (local testing).

export async function sendSms(to, body) {
  const provider = process.env.SMS_PROVIDER || 'console';
  if (provider === 'console') {
    console.log(`[sms to ${to}] ${body}`);
    return;
  }
  if (provider === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const form = new URLSearchParams({ To: to, Body: body });
    if (process.env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
    else form.set('From', process.env.TWILIO_FROM);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!res.ok) throw new Error(`Twilio send failed: ${res.status}`);
    return;
  }
  throw new Error(`Unknown SMS_PROVIDER ${provider}`);
}

export function rollMessage({ rolls, shield }) {
  const app = process.env.APP_URL || 'http://localhost:3000';
  const what = rolls > 1 ? `${rolls} rolls` : 'a roll';
  const extra = shield ? ' plus a snake shield' : '';
  return `DJs Food Hall: you've earned ${what}${extra}. Tap to play: ${app} Reply STOP to opt out`;
}
