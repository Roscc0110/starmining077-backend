/**
 * lib/cryptopay.js — Integración con Crypto Pay (@CryptoBot) para cobrar la tarifa GRAM.
 *
 * Documentación: https://help.crypt.bot/crypto-pay-api
 * - Mainnet: https://pay.crypt.bot/api
 * - Testnet: https://testnet-pay.crypt.bot/api
 * - Auth: header "Crypto-Pay-API-Token" (token obtenido en @CryptoBot → Crypto Pay → Crear App)
 * - Webhook: se configura la URL en la misma app (Crypto Pay → tu app → Webhooks).
 *            Llega update_type="invoice_paid" con header "crypto-pay-api-signature".
 *
 * Variables de entorno requeridas (.env):
 *   CRYPTOPAY_TOKEN=tu_token_de_crypto_pay
 *   CRYPTOPAY_API=https://pay.crypt.bot/api   (opcional, mainnet por defecto)
 *   FEE_ASSET=TON                              (activo de la factura; prueba "GRAM" y verifica con getCurrencies)
 *   BOT_USERNAME=Starmining077Bot              (para el botón de regreso tras pagar)
 */
const crypto = require('crypto');

const API = process.env.CRYPTOPAY_API || 'https://pay.crypt.bot/api';
const TOKEN = process.env.CRYPTOPAY_TOKEN || '';

async function api(method, params) {
  const res = await fetch(API + '/' + method, {
    method: 'POST',
    headers: { 'Crypto-Pay-API-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {})
  });
  const j = await res.json();
  if (!j.ok) throw new Error('CryptoPay ' + method + ': ' + ((j.error && j.error.name) || JSON.stringify(j)));
  return j.result;
}

/** Lista de activos soportados (llama esto para confirmar si GRAM está disponible). */
async function getCurrencies() { return api('getCurrencies'); }

/**
 * Crea una factura de pago.
 * @param {object} opts
 * @param {string} opts.asset      - "GRAM" (si lo soporta), o "TON"/"USDT"/"BTC"...
 * @param {number} opts.amount     - tarifa (0.001 a 1)
 * @param {string} opts.payload    - id del retiro (tx) para conciliar al pagar
 * @param {string} opts.description
 * @returns {Promise<{invoice_id:number, pay_url:string, status:string}>}
 */
async function createInvoice({ asset, amount, payload, description }) {
  return api('createInvoice', {
    asset,
    amount: String(amount),
    payload: String(payload),
    description: description || 'Starmining077 — tarifa de retiro',
    expires_in: 3600,
    paid_btn_name: 'openBot',
    paid_btn_url: 'https://t.me/' + (process.env.BOT_USERNAME || '')
  });
}

/** Consulta facturas (fallback si el webhook falla). */
async function getInvoices(invoiceIds) {
  return api('getInvoices', invoiceIds ? { invoice_ids: invoiceIds.join(',') } : {});
}

/**
 * Verifica la firma del webhook.
 * CRÍTICO: rawBody debe ser el cuerpo CRUDO de la petición (Buffer/string),
 * NUNCA el JSON ya parseado (el re-serializado cambia espacios/orden de claves y el hash no coincide).
 * En Express: app.post('/api/fee-webhook', express.raw({type:'application/json'}), ...) y usa req.body (Buffer).
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!TOKEN || !signatureHeader) return false;
  const secret = crypto.createHash('sha256').update(TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(Buffer.isBuffer(rawBody) ? rawBody : String(rawBody)).digest('hex');
  const provided = String(signatureHeader).toLowerCase();
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

module.exports = { api, getCurrencies, createInvoice, getInvoices, verifyWebhookSignature };
