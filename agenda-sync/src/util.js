// Utilitários puros (sem rede) — testados em test/util.test.js

const TZ_OFFSET = "-03:00"; // America/Sao_Paulo (sem horário de verão desde 2019)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const norm = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();

const decodeHtml = (s) =>
  (s || "")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

/**
 * Chave de telefone para casar contatos entre os sistemas: DDD + últimos 8 dígitos.
 * Ignora DDI 55 e o nono dígito (o Doutor Hérnia às vezes grava sem ele, o GHL com).
 * "+553891159980", "(38) 99115-9980" e "5538991159980" viram todos "3891159980".
 */
function phoneKey(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.length < 10) return d.length >= 8 ? d.slice(-8) : "";
  return d.slice(0, 2) + d.slice(-8);
}

/** Telefone em E.164 com nono dígito (formato que o GHL usa). */
function phoneE164(raw) {
  const k = phoneKey(raw);
  if (k.length !== 10) return "";
  return `+55${k.slice(0, 2)}9${k.slice(2)}`;
}

/** "2026-10-05 11:30:00" (horário local do DH) -> "2026-10-05T11:30:00-03:00" */
function dhToIso(s) {
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/);
  if (!m) throw new Error("data inválida do Doutor Hérnia: " + s);
  return `${m[1]}T${m[2]}:${m[3] || "00"}${TZ_OFFSET}`;
}

/** Qualquer data/ISO -> {iso local -03:00, br "DD/MM/AAAA HH:MM", path "AAAA-MM-DDTHH:MM:00"} */
function localParts(input) {
  const ms = typeof input === "number" ? input : Date.parse(input);
  if (Number.isNaN(ms)) throw new Error("data inválida: " + input);
  const d = new Date(ms - 3 * 3600 * 1000); // desloca para -03:00 e lê em UTC
  const p = (n) => String(n).padStart(2, "0");
  const Y = d.getUTCFullYear(), M = p(d.getUTCMonth() + 1), D = p(d.getUTCDate());
  const h = p(d.getUTCHours()), mi = p(d.getUTCMinutes());
  return {
    ms,
    iso: `${Y}-${M}-${D}T${h}:${mi}:00${TZ_OFFSET}`,
    br: `${D}/${M}/${Y} ${h}:${mi}`,
    path: `${Y}-${M}-${D}T${h}:${mi}:00`,
    day: `${Y}-${M}-${D}`,
  };
}

/** Extrai o array `events: [...]` que o FullCalendar recebe embutido na página da agenda. */
function parseAgendaEvents(html) {
  const m = html.match(/^\s*events:\s*(\[.*\])\s*,?\s*$/m);
  if (!m) throw new Error("não achei a lista de eventos na página da agenda (layout mudou?)");
  const arr = JSON.parse(m[1]);
  const out = [];
  for (const e of arr) {
    const idm = (e.url || "").match(/agendamentos\/editar\/(\d+)/);
    if (!idm || !e.start) continue; // almoço/recorrentes não são agendamentos
    const parts = decodeHtml(e.title || "").split(/-\s+/).map((s) => s.trim());
    out.push({
      id: idm[1],
      title: decodeHtml(e.title || "").trim(),
      paciente: parts[0] || "",
      profissional: parts.length > 1 ? parts[parts.length - 1] : "",
      start: e.start,
      end: e.end || e.start,
      color: e.backgroundColor || "",
      icon: ((e.description || "").match(/class="([^"]*)"/) || [])[1] || "",
    });
  }
  return out;
}

/** Valor selecionado em um <select name="...">. */
function selectedOption(html, name) {
  const re = new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`);
  const sel = html.match(re);
  if (!sel) return null;
  const opt = sel[1].match(/<option[^>]*value="([^"]*)"[^>]*selected[^>]*>([^<]*)/) ||
    sel[1].match(/<option[^>]*selected[^>]*value="([^"]*)"[^>]*>([^<]*)/);
  return opt ? { value: opt[1], label: decodeHtml(opt[2]).trim() } : null;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`, "i"));
  return m ? decodeHtml(m[1]) : null;
}

/**
 * Serializa um <form> como o navegador faria ao enviar (inputs, selects, textareas).
 * `match` escolhe o form por trecho do action. Devolve {action, fields: [[k,v],...]}.
 */
function serializeForm(html, match) {
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)];
  const f = forms.find((x) => (attr(x[1], "action") || "").includes(match));
  if (!f) throw new Error(`formulário "${match}" não encontrado`);
  let body = f[2];
  const fields = [];
  const usable = (tag) => attr(tag, "name") && !/\sdisabled(\s|=|$)/i.test(tag + " ");
  body = body.replace(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi, (_, tag, inner) => {
    if (usable(tag)) {
      const opts = [...inner.matchAll(/<option\b([^>]*)>([^<]*)/gi)];
      const sel = opts.find((o) => /\sselected(\s|=|$)/i.test(o[1] + " ")) || opts[0];
      if (sel) fields.push([attr(tag, "name"), attr(sel[1], "value") ?? decodeHtml(sel[2]).trim()]);
    }
    return "";
  });
  body = body.replace(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi, (_, tag, inner) => {
    if (usable(tag)) fields.push([attr(tag, "name"), decodeHtml(inner)]);
    return "";
  });
  for (const t of body.matchAll(/<input\b([^>]*)>/gi)) {
    const tag = t[1];
    if (!usable(tag)) continue;
    const type = (attr(tag, "type") || "text").toLowerCase();
    if (["submit", "button", "file", "image", "reset"].includes(type)) continue;
    if ((type === "checkbox" || type === "radio") && !/\schecked(\s|=|$)/i.test(tag + " ")) continue;
    if ((attr(tag, "value") || "").includes("' + ")) continue; // template JS, não é campo real
    fields.push([attr(tag, "name"), attr(tag, "value") ?? (type === "checkbox" ? "on" : "")]);
  }
  return { action: decodeHtml(attr(f[1], "action") || ""), fields };
}

/** Substitui/insere campos em uma lista serializada. */
function setFields(fields, overrides) {
  const out = fields.filter(([k]) => !(k in overrides));
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined && v !== null) out.push([k, String(v)]);
  return out;
}

module.exports = {
  sleep, norm, decodeHtml, phoneKey, phoneE164, dhToIso, localParts,
  parseAgendaEvents, selectedOption, serializeForm, setFields,
};
