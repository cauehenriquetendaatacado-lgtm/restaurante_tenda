const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');

for (const v of ['DATABASE_URL', 'ADMIN_PASSWORD']) {
  if (!process.env[v]) { console.error('Faltou a variável de ambiente ' + v); process.exit(1); }
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Neon exige SSL. Tiramos o sslmode da URL (que gera o aviso do driver) e pedimos o SSL completo explicitamente.
const isLocalDb = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
let dbUrl = process.env.DATABASE_URL.trim();
let dbHost = '?';
try {
  const u = new URL(dbUrl);
  dbHost = u.hostname;
  u.searchParams.delete('sslmode');
  dbUrl = u.toString();
} catch (e) { /* mantém a URL como veio */ }

const pool = new Pool({
  connectionString: dbUrl,
  ssl: isLocalDb ? false : { rejectUnauthorized: true },
});
pool.on('error', (e) => console.error('[db] erro numa conexão ociosa:', e.message));

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

/* ---------- Totem -> Controle de refeição (marca o dia automaticamente) ---------- */
async function marcarRefeicao({ tipo, nome, matricula, empresa, cpf, dia }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const digits = String(cpf || '').replace(/\D/g, '');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tipo === 'tenda' ? 'm:' + matricula : 'c:' + digits]);
    let id;
    if (tipo === 'tenda') {
      const r = await client.query(
        `SELECT id FROM refeicao_pessoas WHERE mat_norm = $1 AND grupo <> 'parceiros'
         ORDER BY (upper(trim(nome)) = upper(trim($2))) DESC, ord, id LIMIT 1`, [matricula, nome]);
      id = r.rowCount ? r.rows[0].id : null;
      if (!id) {
        id = (await client.query(
          `INSERT INTO refeicao_pessoas (grupo, matricula, mat_norm, nome, ord)
           VALUES ('colaboradores', $1, $1, $2, COALESCE((SELECT MAX(ord)+1 FROM refeicao_pessoas WHERE grupo='colaboradores'), 0)) RETURNING id`,
          [matricula, nome])).rows[0].id;
      }
    } else {
      const r = await client.query(
        `SELECT id FROM refeicao_pessoas WHERE grupo = 'parceiros' AND regexp_replace(cpf, '\\D', '', 'g') = $1 ORDER BY id LIMIT 1`, [digits]);
      id = r.rowCount ? r.rows[0].id : null;
      if (!id) {
        id = (await client.query(
          `INSERT INTO refeicao_pessoas (grupo, nome, depto, cpf, ord)
           VALUES ('parceiros', $1, $2, $3, COALESCE((SELECT MAX(ord)+1 FROM refeicao_pessoas WHERE grupo='parceiros'), 0)) RETURNING id`,
          [nome, empresa, cpf])).rows[0].id;
      }
    }
    await client.query('INSERT INTO refeicao_marcas (pessoa_id, dia, qtd) VALUES ($1,$2,1) ON CONFLICT (pessoa_id, dia) DO NOTHING', [id, dia]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

app.post('/api/kiosk', async (req, res) => {
  const b = req.body || {};
  const tipo = b.tipo;
  if (tipo !== 'tenda' && tipo !== 'parceiro') return res.status(400).json({ error: 'invalid' });

  let name = String(b.name || '').trim().slice(0, 60);
  let matricula = '', empresa = '', cpf = '';

  try {
    if (tipo === 'tenda') {
      // matrícula sem zeros à esquerda; o nome vem da lista de colaboradores
      matricula = String(b.matricula || '').replace(/\D/g, '').replace(/^0+/, '');
      if (!matricula) return res.status(400).json({ error: 'invalid' });
      const c = await pool.query('SELECT nome FROM colaboradores WHERE chapa = $1', [matricula]);
      if (c.rowCount) name = c.rows[0].nome;
      else {
        // também vale a matrícula das pessoas do controle de refeição (diretoria, colaboradores...), se identificar uma só pessoa
        const r = await pool.query('SELECT DISTINCT nome FROM refeicao_pessoas WHERE mat_norm = $1', [matricula]);
        const nomes = new Set(r.rows.map((x) => x.nome.trim().toUpperCase()));
        if (nomes.size === 1) name = r.rows[0].nome;
        else if (b.novo === true && name.replace(/\s+/g, ' ').length >= 3) {
          // cadastro de novo colaborador feito no próprio totem
          name = name.replace(/\s+/g, ' ').toUpperCase();
          await pool.query(
            `INSERT INTO colaboradores (chapa, nome, setor, funcao, origem) VALUES ($1,$2,'','','totem') ON CONFLICT (chapa) DO NOTHING`,
            [matricula, name]);
          console.log('[colaborador] novo colaborador cadastrado pelo totem e salvo no Postgres');
        } else return res.status(404).json({ error: 'matricula' });
      }

    } else {
      empresa = String(b.empresa || '').trim().slice(0, 60);
      cpf = String(b.cpf || '').trim().slice(0, 14);
      if (!name || !empresa || !validCPF(cpf)) return res.status(400).json({ error: 'invalid' });
    }

    const { date, time } = nowBR();
    const keyCol = tipo === 'tenda' ? 'matricula' : 'cpf';
    const keyVal = tipo === 'tenda' ? matricula : cpf;
    const out = await pool.query(
      `UPDATE employees SET saida_time=$1, status='done', updated_at=now()
       WHERE id = (SELECT id FROM employees WHERE tipo=$2 AND date=$3 AND status='clocked-in' AND ${keyCol}=$4 ORDER BY id LIMIT 1)
       RETURNING name`,
      [time, tipo, date, keyVal]
    );
    if (out.rowCount) { console.log(`[ponto] saída salva no Postgres (${tipo}, ${date} ${time})`); return res.json({ msg: `Saída registrada às ${time}. Até logo, ${out.rows[0].name}!` }); }
    await pool.query(
      `INSERT INTO employees (id, tipo, name, matricula, empresa, cpf, status, entrada_time, saida_time, date)
       VALUES ($1,$2,$3,$4,$5,$6,'clocked-in',$7,'',$8)`,
      [newId(), tipo, name, matricula, empresa, cpf, time, date]
    );
    console.log(`[ponto] entrada salva no Postgres (${tipo}, ${date} ${time})`);
    // entrada = refeição do dia: atualiza o controle de refeição (falha aqui não impede o registro do ponto)
    try { await marcarRefeicao({ tipo, nome: name, matricula, empresa, cpf, dia: date }); }
    catch (e) { console.error('marcarRefeicao:', e.message); }
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

/* ---------- Controle de refeição (admin) ---------- */
const GRUPOS = ['conselho', 'diretoria', 'colaboradores', 'securitizadora', 'parceiros'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const matNorm = (m) => { const t = String(m || '').trim(); return /^\d+$/.test(t) ? t.replace(/^0+/, '') : ''; };
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
let ANCORA = '2026-08-17'; // início do primeiro período; os períodos seguintes andam de 30 em 30 dias
function inicioPadrao() { // período de 30 dias que contém hoje
  const hoje = nowBR().date;
  const diff = Math.round((Date.parse(hoje + 'T00:00:00Z') - Date.parse(ANCORA + 'T00:00:00Z')) / 86400000);
  return addDays(ANCORA, Math.max(0, Math.floor(diff / 30)) * 30);
}
const pessoaFields = (b) => ({
  nome: String(b.nome || '').replace(/\s+/g, ' ').trim().slice(0, 80),
  matricula: String(b.matricula || '').trim().slice(0, 30),
  depto: String(b.depto || '').trim().slice(0, 60),
  ccusto: String(b.ccusto || '').trim().slice(0, 30),
  cpf: String(b.cpf || '').trim().slice(0, 14),
});

app.get('/api/refeicao', requireAdmin, async (req, res) => {
  const inicio = ISO_DAY.test(String(req.query.inicio || '')) ? req.query.inicio : inicioPadrao();
  const fim = addDays(inicio, 29);
  try {
    const [p, m] = await Promise.all([
      pool.query('SELECT id, grupo, matricula, nome, depto, ccusto, cpf FROM refeicao_pessoas ORDER BY ord, id'),
      pool.query('SELECT pessoa_id, dia, qtd FROM refeicao_marcas WHERE dia >= $1 AND dia <= $2', [inicio, fim]),
    ]);
    const map = {};
    const pessoas = p.rows.map((r) => (map[r.id] = { id: Number(r.id), grupo: r.grupo, matricula: r.matricula, nome: r.nome, depto: r.depto, ccusto: r.ccusto, cpf: r.cpf, marcas: {} }));
    m.rows.forEach((r) => { if (map[r.pessoa_id]) map[r.pessoa_id].marcas[r.dia] = r.qtd; });
    res.set('Cache-Control', 'no-store').json({ inicio, pessoas });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

app.post('/api/refeicao/pessoas', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const f = pessoaFields(b);
  if (!GRUPOS.includes(b.grupo) || !f.nome) return res.status(400).json({ error: 'invalid' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO refeicao_pessoas (grupo, matricula, mat_norm, nome, depto, ccusto, cpf, ord)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE((SELECT MAX(ord)+1 FROM refeicao_pessoas WHERE grupo=$1), 0)) RETURNING id`,
      [b.grupo, f.matricula, matNorm(f.matricula), f.nome, f.depto, f.ccusto, f.cpf]
    );
    res.json({ id: Number(rows[0].id) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

app.put('/api/refeicao/pessoas/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const f = pessoaFields(req.body || {});
  if (!Number.isSafeInteger(id) || !f.nome) return res.status(400).json({ error: 'invalid' });
  try {
    await pool.query(
      'UPDATE refeicao_pessoas SET matricula=$2, mat_norm=$3, nome=$4, depto=$5, ccusto=$6, cpf=$7 WHERE id=$1',
      [id, f.matricula, matNorm(f.matricula), f.nome, f.depto, f.ccusto, f.cpf]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

app.delete('/api/refeicao/pessoas/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'invalid' });
  try {
    await pool.query('DELETE FROM refeicao_pessoas WHERE id = $1', [id]); // marcações saem junto (ON DELETE CASCADE)
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

app.put('/api/refeicao/marcas', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const id = Number(b.pessoa_id), qtd = Number(b.qtd);
  if (!Number.isSafeInteger(id) || !ISO_DAY.test(String(b.dia || '')) || !Number.isInteger(qtd) || qtd < 0 || qtd > 20) {
    return res.status(400).json({ error: 'invalid' });
  }
  try {
    if (qtd === 0) await pool.query('DELETE FROM refeicao_marcas WHERE pessoa_id=$1 AND dia=$2', [id, b.dia]);
    else await pool.query(
      `INSERT INTO refeicao_marcas (pessoa_id, dia, qtd) VALUES ($1,$2,$3)
       ON CONFLICT (pessoa_id, dia) DO UPDATE SET qtd=$3`, [id, b.dia, qtd]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db' }); }
});

app.get('/api/health', async (_req, res) => {
  try {
    const r = await pool.query('SELECT current_database() AS db, (SELECT count(*) FROM employees) AS registros, (SELECT count(*) FROM colaboradores) AS colaboradores');
    res.set('Cache-Control', 'no-store').json({ ok: true, banco: r.rows[0].db, registros_de_ponto: Number(r.rows[0].registros), colaboradores: Number(r.rows[0].colaboradores) });
  } catch (e) { console.error('[db] health:', e.message); res.status(500).json({ ok: false, erro: e.message }); }
});

app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, 'public')));

// data/colaboradores.json é a fonte da lista: a cada início do servidor a tabela é sincronizada com ele
async function loadColaboradores() {
  const file = path.join(__dirname, 'data', 'colaboradores.json');
  if (!fs.existsSync(file)) return;
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of list) {
      await client.query(
        `INSERT INTO colaboradores (chapa, nome, setor, funcao, origem) VALUES ($1,$2,$3,$4,'lista')
         ON CONFLICT (chapa) DO UPDATE SET nome=$2, setor=$3, funcao=$4, origem='lista'`,
        [String(c.chapa).trim(), c.nome, c.setor || '', c.funcao || '']
      );
    }
    await client.query(`DELETE FROM colaboradores WHERE origem = 'lista' AND NOT (chapa = ANY($1::text[]))`, [list.map((c) => String(c.chapa).trim())]);
    await client.query('COMMIT');
    console.log('Colaboradores carregados: ' + list.length);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// Carga inicial (só quando a tabela está vazia): depois disso os dados são editados pelo app
async function seedRefeicao() {
  const file = path.join(__dirname, 'data', 'refeicao_inicial.json');
  if (!fs.existsSync(file)) return;
  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (seed.inicio) ANCORA = seed.inicio;
  if ((await pool.query('SELECT 1 FROM refeicao_pessoas LIMIT 1')).rowCount) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ps = seed.pessoas;
    const ins = await client.query(
      `INSERT INTO refeicao_pessoas (grupo, matricula, mat_norm, nome, depto, ccusto, ord)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[])
       RETURNING id, grupo, ord`,
      [ps.map((p) => p.grupo), ps.map((p) => p.matricula), ps.map((p) => matNorm(p.matricula)), ps.map((p) => p.nome),
       ps.map((p) => p.depto), ps.map((p) => p.ccusto), ps.map((p) => p.ord)]
    );
    const idByKey = {};
    ins.rows.forEach((r) => { idByKey[r.grupo + ':' + r.ord] = r.id; });
    const ids = [], dias = [];
    ps.forEach((p) => p.marcas.forEach((d) => { ids.push(idByKey[p.grupo + ':' + p.ord]); dias.push(d); }));
    if (ids.length) {
      await client.query(
        'INSERT INTO refeicao_marcas (pessoa_id, dia, qtd) SELECT x, y, 1 FROM unnest($1::bigint[], $2::text[]) AS t(x, y)',
        [ids, dias]
      );
    }
    await client.query('COMMIT');
    console.log(`Controle de refeição carregado: ${ps.length} pessoas, ${ids.length} marcações`);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

(async () => {
  const who = await pool.query('SELECT current_database() AS db, current_user AS usr');
  console.log(`[db] Conectado ao Postgres: host=${dbHost} banco=${who.rows[0].db} usuário=${who.rows[0].usr}`);
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
    CREATE TABLE IF NOT EXISTS refeicao_pessoas (
      id        BIGSERIAL PRIMARY KEY,
      grupo     TEXT NOT NULL,
      matricula TEXT NOT NULL DEFAULT '',
      mat_norm  TEXT NOT NULL DEFAULT '',
      nome      TEXT NOT NULL,
      depto     TEXT NOT NULL DEFAULT '',
      ccusto    TEXT NOT NULL DEFAULT '',
      cpf       TEXT NOT NULL DEFAULT '',
      ord       INT  NOT NULL DEFAULT 0
    );
    ALTER TABLE refeicao_pessoas ADD COLUMN IF NOT EXISTS cpf TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS refeicao_pessoas_mat_idx ON refeicao_pessoas (mat_norm);
    CREATE TABLE IF NOT EXISTS refeicao_marcas (
      pessoa_id BIGINT NOT NULL REFERENCES refeicao_pessoas(id) ON DELETE CASCADE,
      dia       TEXT   NOT NULL,
      qtd       INT    NOT NULL DEFAULT 1,
      PRIMARY KEY (pessoa_id, dia)
    );
    CREATE TABLE IF NOT EXISTS colaboradores (
      chapa  TEXT PRIMARY KEY,
      nome   TEXT NOT NULL,
      setor  TEXT NOT NULL DEFAULT '',
      funcao TEXT NOT NULL DEFAULT '',
      origem TEXT NOT NULL DEFAULT 'lista'
    );
    ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'lista';
  `);
  await loadColaboradores();
  await seedRefeicao();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('[app] Ponto Lanchonete rodando na porta ' + port + ' — tabelas prontas no Neon'));
})().catch((e) => { console.error('[db] FALHA ao conectar/preparar o banco:', e.message); process.exit(1); });
