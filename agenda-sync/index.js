#!/usr/bin/env node
/**
 * agenda-sync — sincroniza a agenda do Doutor Hérnia com um calendário do GoHighLevel.
 *
 *   node index.js calendarios          lista os calendários da subconta GHL (para achar GHL_CALENDAR_ID)
 *   node index.js simular              uma rodada SEM gravar nada (mostra o que faria)
 *   node index.js uma-vez              uma rodada de verdade
 *   node index.js rodar [minutos]      fica rodando a cada N minutos (padrão 5)
 *
 * Configuração: arquivo .env nesta pasta (ver .env.example) ou variáveis de ambiente.
 */
const fs = require("fs");
const path = require("path");
const { DoutorHernia } = require("./src/dh");
const { GoHighLevel } = require("./src/ghl");
const { sincronizar } = require("./src/sync");
const { sleep } = require("./src/util");

const ENV = process.env.AGENDA_SYNC_ENV || path.join(__dirname, ".env");
if (fs.existsSync(ENV)) {
  for (const line of fs.readFileSync(ENV, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);
const lista = (s) => String(s).split(",").map((x) => x.trim()).filter(Boolean);

const cfg = {
  dhUnidade: env("DH_UNIDADE", "379"),               // 379 = JANAÚBA - MG
  dhProfissional: env("DH_PROFISSIONAL", "1380"),    // DR. EMANUEL NASCIMENTO
  dhCategoria: env("DH_CATEGORIA", "1"),             // AVALIAÇÃO (para agendamentos vindos do GHL)
  dhOrigem: env("DH_ORIGEM", "22"),                  // FACEBOOK
  dhCategoriaLead: env("DH_CATEGORIA_LEAD", undefined),
  ghlLocationId: env("GHL_LOCATION_ID", "j3PgGRcO91FQMdNKo3bD"),
  ghlCalendarId: env("GHL_CALENDAR_ID", ""),
  ghlUserId: env("GHL_USER_ID", undefined),
  categoriasAgendamento: lista(env("CATEGORIAS", "1,3,6,7")), // avaliação, retorno, retorno c/ exames, reavaliação
  sessoes: env("SESSOES", "ignorar"),                // ignorar | bloquear
  ghlParaDh: env("GHL_PARA_DH", "sim") !== "nao",
  tagsContato: lista(env("TAGS_CONTATO", "janauba,doutor-hernia-sync")),
  diasAtras: Number(env("DIAS_ATRAS", "1")),
  diasFrente: Math.min(Number(env("DIAS_FRENTE", "28")), 28), // a página do DH só traz ~30 dias à frente
  estado: env("ARQUIVO_ESTADO", path.join(__dirname, "estado", "janauba.json")),
};

const log = (msg) => console.log(`${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}  ${msg}`);

function clientes() {
  const dh = new DoutorHernia({ email: env("DH_EMAIL"), password: env("DH_PASSWORD"), unidade: cfg.dhUnidade, log });
  const ghl = new GoHighLevel({ token: env("GHL_TOKEN"), locationId: cfg.ghlLocationId, log });
  return { dh, ghl };
}

function lerEstado() {
  try { return JSON.parse(fs.readFileSync(cfg.estado, "utf8")); } catch { return {}; }
}
function gravarEstado(estado) {
  fs.mkdirSync(path.dirname(cfg.estado), { recursive: true });
  const tmp = cfg.estado + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(estado, null, 1));
  fs.renameSync(tmp, cfg.estado);
}

async function rodada({ dryRun }) {
  const { dh, ghl } = clientes();
  const lock = cfg.estado + ".lock";
  fs.mkdirSync(path.dirname(cfg.estado), { recursive: true });
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs < 10 * 60000) { log("outra rodada em andamento — pulando"); return; }
  } catch {}
  fs.writeFileSync(lock, String(process.pid));
  const estado = lerEstado();
  try {
    if (!cfg.ghlCalendarId) throw new Error("GHL_CALENDAR_ID não configurado — rode `node index.js calendarios`");
    const r = await sincronizar({ dh, ghl, estado, cfg: { ...cfg, dryRun }, log });
    if (!dryRun) gravarEstado(estado);
    log(`fim${dryRun ? " (simulação)" : ""}: GHL +${r.criadosGhl}/~${r.atualizadosGhl} · DH +${r.criadosDh}/~${r.atualizadosDh} · ligados ${r.ligados} · conflitos ${r.conflitos} · erros ${r.erros}`);
    return r;
  } finally {
    try { await dh.restaurarUnidade(); } catch (e) { log("aviso: não consegui restaurar a unidade ativa: " + e.message); }
    fs.rmSync(lock, { force: true });
  }
}

(async () => {
  const [cmd = "simular", arg] = process.argv.slice(2);
  if (cmd === "calendarios") {
    const { ghl } = clientes();
    for (const c of await ghl.calendarios()) console.log(`${c.id}\t${c.name}\t${c.calendarType || ""}\t${c.isActive === false ? "inativo" : ""}`);
    return;
  }
  if (cmd === "simular") return void (await rodada({ dryRun: true }));
  if (cmd === "uma-vez") {
    const r = await rodada({ dryRun: false });
    process.exitCode = r && r.erros ? 2 : 0;
    return;
  }
  if (cmd === "rodar") {
    const min = Number(arg || 5);
    log(`sincronizando a cada ${min} min (Ctrl+C para parar)`);
    for (;;) {
      try { await rodada({ dryRun: false }); } catch (e) { log("ERRO na rodada: " + e.message); }
      await sleep(min * 60000);
    }
  }
  console.error("Comando inválido. Use: calendarios | simular | uma-vez | rodar [min]");
  process.exitCode = 1;
})().catch((e) => { log("ERRO: " + e.message); process.exitCode = 1; });
