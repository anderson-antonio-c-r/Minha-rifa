// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const MercadoPago = require('mercadopago');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');
const basicAuth = require('basic-auth');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ----- CONFIG MP (sandbox x production) -----
const MODE = (process.env.MP_MODE || 'sandbox').toLowerCase();
let MP_ACCESS_TOKEN = null;
let MP_PUBLIC_KEY = null;
if (MODE === 'production') {
  MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN_PROD;
  MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY_PROD;
} else {
  MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN_SANDBOX;
  MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY_SANDBOX;
}
if (!MP_ACCESS_TOKEN) console.warn('⚠️ MP access token não encontrado para o modo', MODE);

MercadoPago.configure({ access_token: MP_ACCESS_TOKEN });

// ----- DB (SQLite) -----
const db = new Database(path.join(__dirname, 'db.sqlite'));
db.exec(`
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  number INTEGER UNIQUE,
  status TEXT,
  held_until INTEGER,
  preference_id TEXT,
  payer_email TEXT,
  created_at INTEGER
);
`);

const count = db.prepare('SELECT COUNT(*) as c FROM tickets').get().c;
if (count === 0) {
  const insert = db.prepare('INSERT INTO tickets (number, status, created_at) VALUES (?, "available", ?)');
  const now = Date.now();
  const insertMany = db.transaction((arr) => {
    for (const n of arr) insert.run(n, now);
  });
  insertMany(Array.from({ length: 100 }, (_, i) => i + 1));
  console.log('✅ DB init: 100 números criados');
}

// Clear expired holds
function clearExpiredHolds() {
  const now = Date.now();
  const r = db.prepare('UPDATE tickets SET status="available", held_until=NULL, preference_id=NULL WHERE status="held" AND held_until < ?').run(now);
  if (r.changes) console.log(`🔄 Liberadas ${r.changes} reservas expiradas`);
}
setInterval(clearExpiredHolds, 60 * 1000);

// Reserve a random available number (atomic)
function reserveRandomNumber(holdMs = 15 * 60 * 1000) {
  clearExpiredHolds();
  const rows = db.prepare('SELECT number FROM tickets WHERE status="available"').all();
  if (!rows || rows.length === 0) return null;
  const idx = Math.floor(Math.random() * rows.length);
  const chosen = rows[idx].number;

  const info = db.transaction(() => {
    const res = db.prepare('SELECT status FROM tickets WHERE number = ?').get(chosen);
    if (!res || res.status !== 'available') return null;
    const heldUntil = Date.now() + holdMs;
    db.prepare('UPDATE tickets SET status="held", held_until=?, preference_id=NULL WHERE number=?').run(heldUntil, chosen);
    return { number: chosen, held_until: heldUntil };
  })();

  return info;
}

// ----- API: iniciar compra -----
app.post('/buy', async (req, res) => {
  try {
    const price = Number(req.body.price || 10);
    const hold = reserveRandomNumber(15 * 60 * 1000);
    if (!hold) return res.status(400).json({ error: 'Não há números disponíveis' });
    const number = hold.number;

    const preference = {
      items: [{
        title: `Rifa - Número ${number}`,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: price
      }],
      notification_url: (process.env.PUBLIC_NOTIFICATION_URL || (req.protocol + '://' + req.get('host'))) + '/mp_webhook',
      external_reference: String(number),
      back_urls: {
        success: req.protocol + '://' + req.get('host') + '/success',
        failure: req.protocol + '://' + req.get('host') + '/failure',
        pending: req.protocol + '://' + req.get('host') + '/pending'
      },
      auto_return: 'approved'
    };

    const mpRes = await MercadoPago.preferences.create(preference);
    // save preference id
    const preferenceId = mpRes.body.id;
    db.prepare('UPDATE tickets SET preference_id = ? WHERE number = ?').run(preferenceId, number);

    // Return sandbox_init_point when in sandbox mode and available
    const initPoint = (MODE === 'sandbox' && mpRes.body.sandbox_init_point) ? mpRes.body.sandbox_init_point : mpRes.body.init_point;

    res.json({ init_point: initPoint, number, preference_id: preferenceId, mode: MODE });
  } catch (err) {
    console.error('Erro /buy:', err);
    res.status(500).json({ error: 'Erro ao criar preferência' });
  }
});

// ----- Webhook Mercado Pago -----
app.post('/mp_webhook', async (req, res) => {
  try {
    // Mercado Pago pode enviar diferentes formatos. Aqui cobrimos o caso comum de payment id em data.id
    const id = req.query.id || (req.body && req.body.data && req.body.data.id) || null;
    if (!id) {
      res.status(200).send('ok');
      return;
    }

    // Try to fetch payment
    const payment = await MercadoPago.payment.get(id).catch(() => null);
    if (!payment || !payment.body) {
      console.warn('Webhook: pagamento não encontrado para id', id);
      res.status(200).send('ok');
      return;
    }

    const p = payment.body;
    const status = p.status; // approved, pending, rejected...
    const preferenceId = p.preference_id;
    const payerEmail = p.payer?.email || null;

    if (!preferenceId) {
      // tenta extrair external_reference via merchant_order ou outros, mas focamos em preference_id
      res.status(200).send('ok');
      return;
    }

    if (status === 'approved') {
      db.prepare('UPDATE tickets SET status="sold", payer_email=?, held_until=NULL WHERE preference_id=?').run(payerEmail, preferenceId);
      console.log(`🎟 Ticket (pref ${preferenceId}) marcado como SOLD`);
    } else if (status === 'cancelled' || status === 'rejected') {
      db.prepare('UPDATE tickets SET status="available", preference_id=NULL, held_until=NULL WHERE preference_id=?').run(preferenceId);
      console.log(`⚠ Pagamento ${preferenceId} cancelado/rejeitado -> liberado`);
    } else {
      console.log(`ℹ Webhook: pagamento ${preferenceId} status ${status}`);
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('Erro webhook:', err);
    res.status(500).send('erro');
  }
});

// ----- Admin JSON (dados) -----
app.get('/admin/data', (req, res) => {
  const all = db.prepare('SELECT number, status, payer_email, preference_id, datetime(created_at/1000, "unixepoch", "localtime") AS criado_em FROM tickets ORDER BY number').all();
  res.json(all);
});

// ----- Basic Auth middleware para /admin -----
function checkAdminAuth(req, res, next) {
  const user = basicAuth(req);
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const expectedPass = process.env.ADMIN_PASS || 'adminpass';
  if (!user || user.name !== expectedUser || user.pass !== expectedPass) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Autenticação requerida.');
  }
  return next();
}

app.get('/admin', checkAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve success/failure pages (simples)
app.get('/success', (req, res) => res.send('<h2>Pagamento aprovado — obrigado!</h2><p>Volte ao site.</p>'));
app.get('/failure', (req, res) => res.send('<h2>Pagamento não aprovado.</h2>'));
app.get('/pending', (req, res) => res.send('<h2>Pagamento pendente.</h2>'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Raffle server rodando na porta ${PORT} — modo MP: ${MODE}`));
