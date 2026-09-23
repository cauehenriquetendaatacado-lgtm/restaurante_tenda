const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

for (const v of ['DATABASE_URL', 'ADMIN_PASSWORD']) {
  if (!process.env[v]) { console.error('Faltou a variável de ambiente ' + v); process.exit(1); }
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));

/* ---------- Auth do admin (token assinado, sem sessão em memória) ---------- */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const hmac = (s) => crypto.createHmac('sha256', 'ponto:' + ADMIN_PASSWORD).update(s).digest('hex');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function makeToken() { const exp = String(Date.now() + TOKEN_TTL_MS); return exp + '.' + hmac(exp); }
function validToken(t) {
  if (typeof t !== 'string') return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = hmac(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function requireAdmin(req, res, next) {
  if (!validToken(req.get('x-admin-token'))) return res.status(401).json({ error: 'auth' });
  next();
}

const attempts = new Map(); // ip -> {n, reset}
app.post('/api/login', (req, res) => {
  const now = Date.now();
  const a = attempts.get(req.ip);
  if (a && a.reset > now && a.n >= 10) return res.status(429).json({ error: 'rate' });
  const cur = a && a.reset > now ? a : { n: 0, reset: now + 15 * 60 * 1000 };
  const ok = crypto.timingSafeEqual(sha(req.body && req.body.password), sha(ADMIN_PASSWORD));
  if (!ok) { cur.n++; attempts.set(req.ip, cur); return res.status(401).json({ error: 'senha' }); }
  attempts.delete(req.ip);
  res.json({ token: makeToken() });
});

/* ---------- Totem (sem senha): só registra entrada/saída ---------- */
function nowBR() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
}
const validCPF = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 && !/^(\d)\1{10}$/.test(d); };
const newId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

app.post('/api/kiosk', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 60);
  const tipo = b.tipo;
  const matricula = String(b.matricula || '').trim().slice(0, 30);
  const empresa = String(b.empresa || '').trim().slice(0, 60);
  const cpf = String(b.cpf || '').trim().slice(0, 14);
  if (!name || (tipo !== 'tenda' && tipo !== 'parceiro')) return res.status(400).json({ error: 'invalid' });
  if (tipo === 'tenda' && !matricula) return res.status(400).json({ error: 'invalid' });
  if (tipo === 'parceiro' && (!empresa || !validCPF(cpf))) return res.status(400).json({ error: 'invalid' });

  const { date, time } = nowBR();
  const keyCol = tipo === 'tenda' ? 'matricula' : 'cpf';
  const keyVal = tipo === 'tenda' ? matricula : cpf;
  try {
    const out = await pool.query(
      `UPDATE employees SET saida_time=$1, status='done', updated_at=now()
       WHERE id = (SELECT id FROM employees WHERE tipo=$2 AND date=$3 AND status='clocked-in' AND ${keyCol}=$4 ORDER BY id LIMIT 1)
       RETURNING name`,
      [time, tipo, date, keyVal]
    );
    if (out.rowCount) return res.json({ msg: `Saída registrada às ${time}. Até logo, ${out.rows[0].name}!` });
    await pool.query(
      `INSERT INTO employees (id, tipo, name, matricula, empresa, cpf, status, entrada_time, saida_time, date)
       VALUES ($1,$2,$3,$4,$5,$6,'clocked-in',$7,'',$8)`,
      [newId(), tipo, name, tipo === 'tenda' ? matricula : '', tipo === 'parceiro' ? empresa : '', tipo === 'parceiro' ? cpf : '', time, date]
    );
    res.json({ msg: `Entrada registrada às ${time}. Bem-vindo(a), ${name}!` });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

/* ---------- Admin (exige token) ---------- */
const toApi = (r) => ({
  id: Number(r.id), tipo: r.tipo, name: r.name, matricula: r.matricula, empresa: r.empresa,
  cpf: r.cpf, status: r.status, entradaTime: r.entrada_time, saidaTime: r.saida_time, date: r.date,
});

app.get('/api/employees', requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM employees ORDER BY id');
    res.set('Cache-Control', 'no-store').json(rows.map(toApi));
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

app.put('/api/employees/:id', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0 || typeof b.name !== 'string' || !b.name.trim()) {
    return res.status(400).json({ error: 'invalid' });
  }
  try {
    await pool.query(
      `INSERT INTO employees (id, tipo, name, matricula, empresa, cpf, status, entrada_time, saida_time, date, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (id) DO UPDATE SET tipo=$2, name=$3, matricula=$4, empresa=$5, cpf=$6,
         status=$7, entrada_time=$8, saida_time=$9, date=$10, updated_at=now()`,
      [id, b.tipo || null, String(b.name).slice(0, 60), b.matricula || '', b.empresa || '', b.cpf || '',
       b.status || 'pending', b.entradaTime || '', b.saidaTime || '', b.date || '']
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

app.delete('/api/employees/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'invalid' });
  try {
    await pool.query('DELETE FROM employees WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id           BIGINT PRIMARY KEY,
      tipo         TEXT,
      name         TEXT NOT NULL,
      matricula    TEXT NOT NULL DEFAULT '',
      empresa      TEXT NOT NULL DEFAULT '',
      cpf          TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending',
      entrada_time TEXT NOT NULL DEFAULT '',
      saida_time   TEXT NOT NULL DEFAULT '',
      date         TEXT NOT NULL DEFAULT '',
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS employees_date_idx ON employees (date);
  `);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Ponto Lanchonete rodando na porta ' + port));
})().catch((e) => { console.error('Falha ao conectar no banco:', e.message); process.exit(1); });
