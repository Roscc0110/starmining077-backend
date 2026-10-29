/**
 * Starmining077 — Backend (esqueleto)
 * Telegram Mini App: minería de estrellas + retiros con tarifa GRAM.
 *
 * Regla de retiro (tarifa GRAM):
 *   - 0.001 GRAM (mínimo)  -> retiro procesado en 7 días
 *   - 1 GRAM   (máximo)    -> retiro instantáneo
 *   - Tarifas intermedias  -> escala lineal: delay_dias = 7 * (1 - (fee-0.001)/(1-0.001))
 *
 * Ejecutar: npm install && npm start
 * Variables de entorno: ver .env.example
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- Configuración ----------
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const RATE = 0.5;                       // STARS por cada 60 segundos
const RATE_PER_MS = RATE / 60000;
const MIN_WITHDRAW = 5;                 // retiro mínimo en STARS
const FEE_MIN = parseFloat(process.env.FEE_MIN_GRAM || '0.001');
const FEE_MAX = parseFloat(process.env.FEE_MAX_GRAM || '1');
const MAX_DELAY_DAYS = parseInt(process.env.MAX_DELAY_DAYS || '7', 10);
const MAX_OFFLINE_MS = 8 * 3600 * 1000; // tope de minería offline (8h)
const INIT_DATA_MAX_AGE_SEC = 86400;    // initData válido por 24h
const DATA_FILE = path.join(__dirname, 'data.json');

// ---------- Persistencia simple (JSON). En producción: PostgreSQL/Redis ----------
let db = { users: {}, withdrawals: [] };
function loadDB() { try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { /* primera ejecución */ } }
function saveDB() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
loadDB();

// ---------- Verificación de initData (Telegram WebApp) ----------
// Documentación: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData) {
  if (!BOT_TOKEN) return { ok: false, error: 'BOT_TOKEN no configurado en el servidor' };
  if (!initData) return { ok: false, error: 'falta initData' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'falta hash' };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computed !== hash) return { ok: false, error: 'hash inválido (initData manipulado)' };
  const authDate = parseInt(params.get('auth_date'), 10);
  if (Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE_SEC) return { ok: false, error: 'initData expirado' };
  let user = {};
  try { user = JSON.parse(params.get('user') || '{}'); } catch (e) { user = {}; }
  return { ok: true, user };
}

// ---------- Cálculo de demora según tarifa GRAM ----------
function computeDelayDays(fee) {
  const f = Math.min(FEE_MAX, Math.max(FEE_MIN, fee));
  // Lineal: en FEE_MIN -> 7 días; en FEE_MAX -> 0 días (instantáneo)
  return MAX_DELAY_DAYS * (1 - (f - FEE_MIN) / (FEE_MAX - FEE_MIN));
}

// ---------- Rate limit simple en memoria (30 req/min por usuario) ----------
const rl = {};
function rateLimit(req, res, next) {
  const id = req.userId || req.ip;
  const now = Date.now();
  rl[id] = (rl[id] || []).filter(t => now - t < 60000);
  if (rl[id].length > 30) return res.status(429).json({ error: 'Demasiadas peticiones, espera un minuto' });
  rl[id].push(now);
  next();
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // sirve la Mini App (public/index.html)

// Middleware de autenticación: valida initData en cada petición protegida
function auth(req, res, next) {
  const initData = (req.body && req.body.initData) || req.query.initData;
  const v = verifyInitData(initData);
  if (!v.ok) return res.status(401).json({ error: v.error });
  req.userId = String(v.user.id);
  req.user = v.user;
  next();
}

// ---------- Endpoints ----------

// Salud del servicio
app.get('/api/health', (req, res) => res.json({ ok: true, app: 'Starmining077', time: Date.now() }));

// Sincronización: el cliente llama cada ~15s con initData y estado de minería.
// El servidor calcula las STARS ganadas desde la última actividad (tope 8h offline).
app.post('/api/sync', auth, rateLimit, (req, res) => {
  const id = req.userId;
  const { mining_active } = req.body || {};
  const now = Date.now();
  let u = db.users[id] || { id, balance: 0, total_mined: 0, last_active: now, mining: false, created: now };
  if (u.mining) {
    const elapsed = Math.min(now - u.last_active, MAX_OFFLINE_MS);
    const earned = elapsed * RATE_PER_MS;
    u.balance += earned;
    u.total_mined += earned;
  }
  u.last_active = now;
  u.mining = !!mining_active;
  db.users[id] = u;
  saveDB();
  const pending = db.withdrawals.filter(w => w.user_id === id && w.status === 'pending');
  res.json({
    balance: u.balance,
    total_mined: u.total_mined,
    mining: u.mining,
    rate_per_60s: RATE,
    min_withdraw: MIN_WITHDRAW,
    fee_min: FEE_MIN,
    fee_max: FEE_MAX,
    max_delay_days: MAX_DELAY_DAYS,
    pending_withdrawals: pending
  });
});

// Retiro: valida saldo y tarifa GRAM, deduce STARS, crea registro con demora según tarifa.
// IMPORTANTE: este esqueleto NO verifica el pago real de GRAM en cadena. En producción,
// espera la confirmación on-chain (webhook / escaneo de billetera TON) antes de liberar.
app.post('/api/withdraw', auth, rateLimit, (req, res) => {
  const id = req.userId;
  let { amount, fee_gram, wallet_type, wallet_dest, chain } = req.body || {};
  amount = parseFloat(amount);
  fee_gram = parseFloat(fee_gram);
  const u = db.users[id];
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado (haz /api/sync primero)' });
  if (isNaN(amount) || amount < MIN_WITHDRAW) return res.status(400).json({ error: `El retiro mínimo es ${MIN_WITHDRAW} STARS` });
  if (amount > u.balance) return res.status(400).json({ error: `Saldo insuficiente. Tienes ${u.balance.toFixed(2)} STARS` });
  if (isNaN(fee_gram) || fee_gram < FEE_MIN || fee_gram > FEE_MAX)
    return res.status(400).json({ error: `La tarifa GRAM debe estar entre ${FEE_MIN} y ${FEE_MAX}` });
  if (!wallet_dest || !String(wallet_dest).trim()) return res.status(400).json({ error: 'Falta el destino de la billetera' });

  const delayDays = computeDelayDays(fee_gram);
  const instant = delayDays <= 0.001;
  u.balance -= amount;
  const tx = 'STX-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const record = {
    id: tx,
    user_id: id,
    amount,
    fee_gram,
    wallet_type: wallet_type || 'external',
    wallet_dest: String(wallet_dest).trim(),
    chain: chain || null,
    status: instant ? 'completed' : 'pending',   // instantáneo si la tarifa es máxima
    fee_verified: false,                          // TODO: poner true al confirmar pago GRAM on-chain
    created_at: now(),
    release_at: instant ? now() : now() + Math.round(delayDays * 86400000),
    delay_days: +delayDays.toFixed(3)
  };
  db.withdrawals.push(record);
  saveDB();
  res.json({
    ok: true,
    tx,
    status: record.status,
    fee_gram,
    delay_days: +delayDays.toFixed(2),
    release_at: record.release_at,
    balance: u.balance,
    note: instant
      ? 'Retiro instantáneo procesado (requiere confirmación de pago GRAM en producción).'
      : `Retiro pendiente. Se liberará en ~${delayDays.toFixed(1)} días. Verifica el pago de ${fee_gram} GRAM.`
  });
});

// Historial de retiros del usuario
app.get('/api/history', auth, (req, res) => {
  const list = db.withdrawals.filter(w => w.user_id === req.userId).sort((a, b) => b.created_at - a.created_at).slice(0, 50);
  res.json({ withdrawals: list });
});

// Webhook (stub): tu proveedor de pagos GRAM/TON llama aquí cuando el pago de tarifa se confirma.
// En producción: verifica firma del webhook, busca el retiro por tx o dirección y marca fee_verified=true.
app.post('/api/fee-webhook', express.json(), (req, res) => {
  const { tx, confirmed } = req.body || {};
  const w = db.withdrawals.find(x => x.id === tx);
  if (w && confirmed) { w.fee_verified = true; saveDB(); }
  res.json({ ok: true });
});

// Procesador en segundo plano: libera retiros pendientes cuya fecha de liberación llegó
// (y cuya tarifa GRAM fue confirmada). En producción: un worker separado + cola de jobs.
setInterval(() => {
  const t = now();
  let changed = false;
  for (const w of db.withdrawals) {
    if (w.status === 'pending' && w.release_at <= t && w.fee_verified) {
      w.status = 'completed';
      changed = true;
    }
  }
  if (changed) saveDB();
}, 60000);

function now() { return Date.now(); }

app.listen(PORT, () => {
  console.log(`Starmining077 backend escuchando en http://localhost:${PORT}`);
  if (!BOT_TOKEN) console.warn('ADVERTENCIA: BOT_TOKEN no está configurado — la verificación de initData rechazará todas las peticiones.');
});
