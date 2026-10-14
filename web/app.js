const $ = (id) => document.getElementById(id);
const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
let me = null;
let busy = false;
let phone = '';

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function msg(html) { $('msg').innerHTML = html; }
let tt;
function toast(t) {
  $('toastText').textContent = t;
  $('toast').classList.add('show');
  clearTimeout(tt);
  tt = setTimeout(() => $('toast').classList.remove('show'), 3200);
}

// Board layout: 10 x 5, square 1 bottom-left, rows snake back and forth.
function rc(n) { const r = Math.floor((n - 1) / 10); return { r, c: r % 2 === 0 ? (n - 1) % 10 : 9 - (n - 1) % 10 }; }
function centre(n) { if (n <= 0) return { x: -3, y: 45 }; const p = rc(n); return { x: p.c * 10 + 5, y: (4 - p.r) * 10 + 5 }; }
function placeToken(n) { const c = centre(n); $('token').style.left = c.x + '%'; $('token').style.top = c.y * 2 + '%'; }

function drawBoard(season) {
  const board = $('board');
  board.querySelectorAll('.cell').forEach((c) => c.remove());
  const cps = season.checkpoints;
  for (let n = 1; n <= season.boardSize; n++) {
    const p = rc(n);
    const d = document.createElement('div');
    d.className = 'cell' + ((p.r + p.c) % 2 ? ' alt' : '') + (cps.includes(n) ? ' cp' : '') +
      (n === season.boardSize ? ' fin' : '') + (season.ladders[n] ? ' lad' : '') + (season.snakes[n] ? ' snk' : '');
    d.style.gridRow = String(5 - p.r);
    d.style.gridColumn = String(p.c + 1);
    d.textContent = n === season.boardSize ? `${n} ★` : cps.includes(n) ? `${n} ⚑` : String(n);
    board.appendChild(d);
  }
  let svg = '';
  for (const [a, b] of Object.entries(season.ladders)) {
    const f = centre(+a); const t = centre(b);
    for (const dx of [-1.2, 1.2]) {
      svg += `<line x1="${f.x + dx}" y1="${f.y}" x2="${t.x + dx}" y2="${t.y}" stroke="var(--ladder)" vector-effect="non-scaling-stroke" style="stroke-width:3px" stroke-linecap="round"/>`;
    }
  }
  for (const [a, b] of Object.entries(season.snakes)) {
    const f = centre(+a); const t = centre(b);
    svg += `<path d="M${f.x} ${f.y} Q${(f.x + t.x) / 2} ${(f.y + t.y) / 2 - 4} ${t.x} ${t.y}" fill="none" stroke="var(--snake)" vector-effect="non-scaling-stroke" style="stroke-width:4px" stroke-linecap="round"/>`;
    svg += `<circle cx="${f.x}" cy="${f.y}" r="1.6" fill="var(--snake)"/>`;
  }
  $('overlay').innerHTML = svg;
}

function render() {
  $('sRolls').textContent = me.rolls;
  $('sPos').textContent = me.position;
  $('sShield').textContent = me.shields;
  $('seasonName').textContent = me.season.name;
  $('grandPrize').textContent = me.season.grandPrize;
  $('who').textContent = me.phone.replace('+61', '0');
  const btn = $('rollBtn');
  btn.disabled = busy || me.rolls < 1 || me.finished;
  btn.textContent = me.finished ? 'Board complete' : me.rolls < 1 ? 'No rolls yet' : 'Roll the dice';
  $('wallet').innerHTML = me.wallet.length
    ? me.wallet.map((w) => `<li class="${w.redeemedAt ? 'used' : ''}"><span>${esc(w.name)}</span><code>${w.redeemedAt ? 'Used' : esc(w.code)}</code></li>`).join('')
    : '<li class="empty" style="background:none;padding:0">Nothing yet. Instant wins land here. Show the code at the counter.</li>';
  placeToken(me.position);
}

async function load() {
  const r = await api('/api/me');
  if (r.status === 401) {
    $('signin').classList.remove('hidden');
    $('game').classList.add('hidden');
    $('stats').classList.add('hidden');
    return;
  }
  me = r;
  $('signin').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('stats').classList.remove('hidden');
  drawBoard(me.season);
  render();
  const cfg = await api('/api/config');
  if (cfg.devPurchases) {
    $('devPanel').classList.remove('hidden');
    $('devOutlet').innerHTML = Object.entries(cfg.locations).map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('');
  }
}

$('phoneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  phone = $('phone').value;
  const r = await api('/api/auth/start', { phone });
  if (r.status === 200) {
    $('phoneForm').classList.add('hidden');
    $('codeForm').classList.remove('hidden');
    $('authErr').textContent = '';
    $('code').focus();
  } else {
    $('authErr').textContent = r.error === 'bad_phone' ? 'That doesn\'t look like an Australian mobile.' : 'Too many codes sent. Try again in an hour.';
  }
});

$('codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('/api/auth/verify', {
    phone, code: $('code').value.trim(), acceptTerms: $('terms').checked, smsOptIn: $('smsOptIn').checked,
  });
  if (r.status === 200) return load();
  $('authErr').textContent = r.error === 'terms_required' ? 'Please accept the game terms to play.' : 'That code didn\'t work. Check it and try again.';
});

$('rollBtn').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  render();
  const die = $('die');
  die.classList.remove('spin'); void die.offsetWidth; die.classList.add('spin');
  const r = await api('/api/roll', {});
  await wait(450);
  if (r.status !== 200) {
    busy = false;
    msg(r.error === 'no_rolls' ? 'No rolls left. Order $10 or more to earn another.' : 'Something went wrong. Try again.');
    return load();
  }
  die.textContent = r.die;
  for (let i = r.from + 1; i <= r.landed; i++) { placeToken(i); $('sPos').textContent = i; await wait(160); }
  let note = `You rolled <b>${r.die}</b>.`;
  if (r.event === 'ladder') note += ` Ladder! Up to <b>${r.to}</b>.`;
  if (r.event === 'snake') note += ` Snake! Down to <b>${r.to}</b>.`;
  if (r.event === 'shielded') note += ` Snake on ${r.landed}, but your <b>shield</b> blocked it.`;
  if (r.award) note += ` <b>Instant win: ${esc(r.award.name)}</b>. It's in your wallet.`;
  if (r.finished) note += ` <b>You finished!</b> You're in the grand prize draw.`;
  msg(note);
  busy = false;
  await load();
});

$('logout').addEventListener('click', async () => { await api('/api/auth/logout', {}); location.reload(); });

$('devBuy').addEventListener('click', async () => {
  const r = await api('/api/dev/purchase', { locationId: $('devOutlet').value, amount: $('devAmount').value });
  if (r.rolls > 0) toast(`You've earned ${r.rolls > 1 ? r.rolls + ' rolls' : 'a roll'} at DJs Food Hall${r.shield ? ' plus a snake shield' : ''}. Tap to play.`);
  else msg(r.reason === 'daily_cap' ? 'Daily cap of 3 rolls reached.' : r.reason === 'under_minimum' ? 'Under $10, no roll.' : 'That order didn\'t count (is the season running?).');
  load();
});

load();
