// ══════════════════════════════════════════════════════
//  DIVA-5 · Servidor Principal
// ══════════════════════════════════════════════════════
const express      = require('express');
const session      = require('express-session');
const cookieParser = require('cookie-parser');
const path         = require('path');
const os           = require('os');
const { v4: uuidv4 } = require('uuid');
const bcrypt       = require('bcryptjs');
const db           = require('./db');

// ── Detecta IP local da rede ────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const app  = express();
const PORT = process.env.PORT || 3000;

// Necessário para cookies seguros atrás do proxy do Railway/Heroku
app.set('trust proxy', 1);

// ── Middleware ──────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;
app.use(session({
  secret: process.env.SESSION_SECRET || 'diva5-secret-2024',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000, // 8h
    secure: isProduction ? true : false,
    sameSite: isProduction ? 'none' : 'lax',
    httpOnly: true
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth helper ─────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: 'Não autorizado' });
}

// ══════════════════════════════════════════════════════
//  ADMIN: LOGIN
// ══════════════════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const admin = db.getAdmin();
  if (!admin) return res.status(500).json({ error: 'Admin não configurado' });
  const ok = bcrypt.compareSync(password, admin.password_hash);
  if (!ok) return res.status(401).json({ error: 'Senha incorreta' });
  req.session.admin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ admin: !!(req.session && req.session.admin) });
});

// Retorna a URL base para o painel gerar links acessíveis pelo paciente
// Em produção (Railway/cloud) usa o host do request; localmente usa o IP da rede
app.get('/api/server-info', requireAdmin, (req, res) => {
  const ip = getLocalIP();
  // Se há um host header com domínio externo (não localhost/IP privado), usa ele
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const isCloud = host && !host.startsWith('localhost') && !host.match(/^192\.168|^10\.|^172\.(1[6-9]|2\d|3[01])\./);
  if (isCloud) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const baseUrl = `${proto}://${host}`;
    return res.json({ ip: host, port: PORT, baseUrl });
  }
  res.json({ ip, port: PORT, baseUrl: `http://${ip}:${PORT}` });
});

// ══════════════════════════════════════════════════════
//  ADMIN: GERENCIAR LINKS
// ══════════════════════════════════════════════════════
app.post('/api/admin/links', requireAdmin, (req, res) => {
  const { patientName, patientEmail, notes } = req.body;
  const token = uuidv4();
  const link  = db.createLink({ token, patientName: patientName || '', patientEmail: patientEmail || '', notes: notes || '' });
  res.json({ ok: true, token, url: `/teste/${token}`, link });
});

app.get('/api/admin/links', requireAdmin, (req, res) => {
  res.json(db.getAllLinks());
});

app.delete('/api/admin/links/:token', requireAdmin, (req, res) => {
  db.deleteLink(req.params.token);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════
//  ADMIN: RELATÓRIOS
// ══════════════════════════════════════════════════════
app.get('/api/admin/reports', requireAdmin, (req, res) => {
  res.json(db.getAllReports());
});

app.get('/api/admin/reports/:token', requireAdmin, (req, res) => {
  const report = db.getReport(req.params.token);
  if (!report) return res.status(404).json({ error: 'Relatório não encontrado' });
  res.json(report);
});

app.delete('/api/admin/reports/:token', requireAdmin, (req, res) => {
  db.deleteReport(req.params.token);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════
//  PACIENTE: VALIDAR TOKEN
// ══════════════════════════════════════════════════════
app.get('/api/link/:token', (req, res) => {
  const link = db.getLink(req.params.token);
  if (!link) return res.status(404).json({ error: 'Link inválido ou expirado' });
  if (link.used) return res.status(410).json({ error: 'Este link já foi utilizado', completed: true });
  res.json({ ok: true, patientName: link.patient_name });
});

// ══════════════════════════════════════════════════════
//  PACIENTE: SALVAR RELATÓRIO
// ══════════════════════════════════════════════════════
app.post('/api/report/:token', (req, res) => {
  const link = db.getLink(req.params.token);
  if (!link) return res.status(404).json({ error: 'Link inválido' });
  if (link.used) return res.status(410).json({ error: 'Link já utilizado' });

  const { answers, scores, result, patientData } = req.body;
  db.saveReport({
    token: req.params.token,
    patientName:  patientData?.nome || link.patient_name || '',
    patientEmail: link.patient_email || '',
    answers:      JSON.stringify(answers),
    scores:       JSON.stringify(scores),
    result:       JSON.stringify(result),
    patientData:  JSON.stringify(patientData || {}),
  });
  db.markLinkUsed(req.params.token);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════
//  ROTAS HTML
// ══════════════════════════════════════════════════════
// Paciente acessa o teste
app.get('/teste/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'teste.html'));
});
// Admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
// Raiz
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Start ────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n✅  DIVA-5 rodando!`);
  console.log(`\n📋  Admin (este computador):  http://localhost:${PORT}/admin`);
  console.log(`🌐  Admin (rede local):        http://${ip}:${PORT}/admin`);
  console.log(`👤  Link paciente (exemplo):   http://${ip}:${PORT}/teste/<token>`);
  console.log(`\n🔑  Senha padrão: diva2024`);
  console.log(`\n⚠️   Pacientes devem estar na mesma rede Wi-Fi que este computador.\n`);
});
