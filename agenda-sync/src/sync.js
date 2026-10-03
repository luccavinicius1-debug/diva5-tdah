// Sincronização bidirecional Doutor Hérnia <-> GoHighLevel para uma unidade.
//
// Cada agendamento é ligado ao seu par no outro sistema (estado em disco). A cada rodada:
//   1. DH -> GHL: agendamentos novos do DH viram compromissos no calendário do GHL
//      (contato achado/criado pelo telefone); mudança de horário/status no DH é replicada.
//   2. GHL -> DH: compromissos marcados no GHL (ex.: pela IA Olívia) que não existem no DH
//      são criados lá (paciente achado pelo telefone/nome ou criado via lead).
//   3. Pares já ligados: o lado que mudou desde a última rodada é replicado no outro;
//      se os dois mudaram, o Doutor Hérnia vence (é o sistema da recepção).

const { norm, phoneKey, dhToIso, localParts } = require("./util");
const { STATUS } = require("./dh");

const DH_PARA_GHL = {
  37: "confirmed", 38: "confirmed", 39: "confirmed", 53: "confirmed",
  42: "showed", 40: "noshow", 57: "cancelled", 41: "cancelled",
};
const DH_INATIVOS = new Set(["57", "41"]); // desmarcado, remarcado (o novo horário é outro agendamento)
const GHL_INATIVOS = new Set(["cancelled", "invalid"]);
const ROTULO_CATEGORIA = { 1: "Avaliação", 2: "Sessão", 3: "Retorno", 6: "Retorno com exames", 7: "Reavaliação" };

const assinaturaDh = (e) => [e.start, e.end, e.color, e.icon, e.title].join("|");
const minuto = (iso) => Math.floor(Date.parse(iso) / 60000);

function nomeBonito(s) {
  return String(s || "").toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

async function sincronizar({ dh, ghl, estado, cfg, log = console.log }) {
  const dry = !!cfg.dryRun;
  const resumo = { criadosGhl: 0, atualizadosGhl: 0, criadosDh: 0, atualizadosDh: 0, ligados: 0, conflitos: 0, erros: 0 };
  estado.links = estado.links || {};       // dhId -> link
  estado.detalhes = estado.detalhes || {}; // dhId -> {assinatura, ...detalhes}
  estado.avisos = estado.avisos || {};     // ghlId -> último aviso (para não repetir no log)

  const agora = Date.now();
  const inicio = agora - cfg.diasAtras * 86400000;
  const fim = agora + cfg.diasFrente * 86400000;
  const dentro = (iso) => { const t = Date.parse(iso); return t >= inicio && t <= fim; };

  async function fazer(descricao, fn) {
    log((dry ? "[simulação] " : "") + descricao);
    if (dry) return null;
    return fn();
  }
  function erro(contexto, e) {
    resumo.erros++;
    log(`ERRO ${contexto}: ${e.message}`);
  }

  // ---------- leitura dos dois lados ----------
  const eventosDh = (await dh.listarEventos()).filter((e) => dentro(dhToIso(e.start)));
  const dhPorId = new Map(eventosDh.map((e) => [e.id, e]));
  for (const e of eventosDh) {
    const ass = assinaturaDh(e);
    const cache = estado.detalhes[e.id];
    if (!cache || cache.assinatura !== ass) {
      try {
        estado.detalhes[e.id] = { assinatura: ass, ...(await dh.detalhes(e.id)) };
      } catch (err) { erro(`lendo agendamento DH ${e.id}`, err); continue; }
    }
  }
  // esquece pares de agendamentos que já passaram há mais de 7 dias
  for (const [id, l] of Object.entries(estado.links)) {
    if (l.dhStart && Date.parse(dhToIso(l.dhStart)) < agora - 7 * 86400000) delete estado.links[id];
  }
  // limpa cache de agendamentos que saíram da janela
  for (const id of Object.keys(estado.detalhes)) if (!dhPorId.has(id) && !estado.links[id]) delete estado.detalhes[id];

  const eventosGhl = await ghl.eventos(cfg.ghlCalendarId, inicio, fim);
  const ghlPorId = new Map(eventosGhl.map((e) => [e.id, e]));
  const ghlLigados = new Map(Object.entries(estado.links).map(([dhId, l]) => [l.ghlId, dhId]));
  const tocados = new Set(); // dhIds já resolvidos nesta rodada (não processar de novo no sentido inverso)

  const tipoDe = (det) => {
    if (cfg.categoriasAgendamento.includes(det.categoriaId)) return "agendamento";
    if (cfg.sessoes === "bloquear") return "bloqueio";
    return null;
  };
  const dadosGhl = (e, det) => {
    const rotulo = ROTULO_CATEGORIA[det.categoriaId] || nomeBonito(det.categoria) || "Agendamento";
    return {
      title: `${rotulo} - ${nomeBonito(e.paciente)}`,
      startTime: dhToIso(e.start),
      endTime: dhToIso(e.end),
      status: DH_PARA_GHL[det.statusId] || "confirmed",
      notes: `Doutor Hérnia #${e.id} · ${STATUS[det.statusId] || det.status} · ${det.categoria} · ${e.profissional}`,
    };
  };

  // ---------- 1 e 3a. DH -> GHL ----------
  for (const e of eventosDh) {
    const det = estado.detalhes[e.id];
    if (!det) continue;
    if (det.unidade && det.unidade !== cfg.dhUnidade) continue;
    const tipo = tipoDe(det);
    const link = estado.links[e.id];
    const ativo = !DH_INATIVOS.has(det.statusId);
    try {
      if (!link) {
        if (!tipo || !ativo) continue;
        // pode já existir no GHL (marcado lá e lançado à mão no DH): liga sem duplicar
        const par = tipo === "agendamento" && (await acharParNoGhl(e, det));
        if (par) {
          estado.links[e.id] = { ghlId: par.id, tipo, origem: "ambos" };
          ghlLigados.set(par.id, e.id);
          tocados.add(e.id);
          marcarVisto(e.id, e, det, par);
          resumo.ligados++;
          log(`ligado: DH #${e.id} <-> GHL ${par.id} (${e.paciente} ${e.start})`);
          continue;
        }
        const d = dadosGhl(e, det);
        let ghlId;
        if (tipo === "agendamento") {
          ghlId = await fazer(`GHL: criar "${d.title}" em ${e.start} (${d.status})`, async () => {
            const contactId = await ghl.contatoPorTelefone({ nome: nomeBonito(e.paciente), telefone: det.whatsapp, tags: cfg.tagsContato });
            return ghl.criarAgendamento({ calendarId: cfg.ghlCalendarId, contactId, assignedUserId: cfg.ghlUserId, ...d });
          });
        } else {
          ghlId = await fazer(`GHL: bloquear ${e.start}–${e.end.slice(11, 16)} (${e.paciente})`, () =>
            ghl.criarBloqueio({ calendarId: cfg.ghlCalendarId, title: `Ocupado (DH) - ${nomeBonito(e.paciente)}`, startTime: d.startTime, endTime: d.endTime }));
        }
        if (ghlId) {
          estado.links[e.id] = { ghlId, tipo, origem: "dh" };
          ghlLigados.set(ghlId, e.id);
          tocados.add(e.id);
          marcarVisto(e.id, e, det, { startTime: d.startTime, appointmentStatus: d.status });
        }
        resumo.criadosGhl++;
        continue;
      }

      // já ligado: o DH mudou desde a última rodada?
      const mudouDh = link.dhStart !== e.start || link.dhStatus !== det.statusId;
      if (!mudouDh) continue;
      const d = dadosGhl(e, det);
      if (link.tipo === "bloqueio") {
        if (ativo) await fazer(`GHL: mover bloqueio ${link.ghlId} para ${e.start}`, () =>
          ghl.atualizarBloqueio(link.ghlId, { calendarId: cfg.ghlCalendarId, title: `Ocupado (DH) - ${nomeBonito(e.paciente)}`, startTime: d.startTime, endTime: d.endTime }));
        else await fazer(`GHL: remover bloqueio ${link.ghlId} (${STATUS[det.statusId]})`, () => ghl.apagarEvento(link.ghlId));
      } else {
        await fazer(`GHL: atualizar ${link.ghlId} "${d.title}" -> ${e.start} ${d.status}`, () => ghl.atualizarAgendamento(link.ghlId, d));
      }
      marcarVisto(e.id, e, det, { startTime: d.startTime, appointmentStatus: d.status });
      tocados.add(e.id);
      resumo.atualizadosGhl++;
      if (!ativo && link.tipo === "bloqueio") delete estado.links[e.id];
    } catch (err) { erro(`DH #${e.id} -> GHL`, err); }
  }

  // agendamentos ligados que sumiram do DH (excluídos) -> cancela no GHL
  for (const [dhId, link] of Object.entries(estado.links)) {
    if (dhPorId.has(dhId) || !link.dhStart || !dentro(dhToIso(link.dhStart))) continue;
    if (Date.parse(dhToIso(link.dhStart)) < agora) continue; // passado: saiu da janela da página, não foi excluído
    try {
      if (link.tipo === "bloqueio") await fazer(`GHL: remover bloqueio ${link.ghlId} (excluído no DH)`, () => ghl.apagarEvento(link.ghlId));
      else await fazer(`GHL: cancelar ${link.ghlId} (agendamento DH #${dhId} excluído)`, () => ghl.atualizarAgendamento(link.ghlId, { status: "cancelled" }));
      delete estado.links[dhId];
      resumo.atualizadosGhl++;
    } catch (err) { erro(`cancelando GHL ${link.ghlId}`, err); }
  }

  // ---------- 2 e 3b. GHL -> DH ----------
  for (const g of eventosGhl) {
    const dhId = ghlLigados.get(g.id);
    try {
      if (dhId) {
        if (!tocados.has(dhId)) await aplicarMudancaGhl(dhId, g);
        continue;
      }

      // compromisso do GHL ainda sem par no DH
      if (GHL_INATIVOS.has(g.appointmentStatus) || !dentro(g.startTime) || Date.parse(g.startTime) < agora) continue;
      if (!cfg.ghlParaDh) continue;
      const contato = g.contactId ? await ghl.contato(g.contactId) : {};
      const nome = (contato.firstName || contato.lastName)
        ? `${contato.firstName || ""} ${contato.lastName || ""}`.trim()
        : (contato.name || contato.contactName || String(g.title || "").replace(/^[^-]*-\s*/, ""));
      const telefone = contato.phone || "";

      // o mesmo horário já tem esse paciente no DH? só liga
      const mesmoHorario = eventosDh.filter((e) => minuto(dhToIso(e.start)) === minuto(g.startTime));
      const par = mesmoHorario.find((e) => {
        const det = estado.detalhes[e.id];
        return det && ((phoneKey(det.whatsapp) && phoneKey(det.whatsapp) === phoneKey(telefone)) ||
          norm(e.paciente).split(" ")[0] === norm(nome).split(" ")[0]);
      });
      if (par) {
        const det = estado.detalhes[par.id];
        estado.links[par.id] = { ghlId: g.id, tipo: "agendamento", origem: "ambos" };
        ghlLigados.set(g.id, par.id);
        tocados.add(par.id);
        marcarVisto(par.id, par, det, g);
        resumo.ligados++;
        log(`ligado: GHL ${g.id} <-> DH #${par.id} (${par.paciente} ${par.start})`);
        continue;
      }

      // conflito: horário já ocupado por outra avaliação no DH
      const ocupado = eventosDh.find((e) => {
        const det = estado.detalhes[e.id];
        if (!det || DH_INATIVOS.has(det.statusId) || !cfg.categoriasAgendamento.includes(det.categoriaId)) return false;
        return Date.parse(dhToIso(e.start)) < Date.parse(g.endTime) && Date.parse(dhToIso(e.end)) > Date.parse(g.startTime);
      });
      if (ocupado) {
        const aviso = `CONFLITO: GHL ${g.id} (${nome} ${localParts(g.startTime).br}) bate com DH #${ocupado.id} (${ocupado.paciente}) — não criado`;
        if (estado.avisos[g.id] !== aviso) { log(aviso); estado.avisos[g.id] = aviso; }
        resumo.conflitos++;
        continue;
      }

      const novoId = await fazer(`DH: criar avaliação de ${nome} em ${localParts(g.startTime).br}`, async () => {
        let paciente = await dh.acharPaciente({ nome, telefone });
        const idPaciente = paciente ? paciente.id : await dh.criarPaciente({
          nome, telefone, origem: cfg.dhOrigem, categoriaLead: cfg.dhCategoriaLead,
        });
        return dh.criarAgendamento({
          idPaciente, nome, startIso: g.startTime,
          profissional: cfg.dhProfissional, categoria: cfg.dhCategoria, origem: cfg.dhOrigem,
          descricao: `Agendado pelo GoHighLevel (${g.id}) — sincronizado automaticamente.`,
        });
      });
      if (novoId) {
        const det = await dh.detalhes(novoId);
        const fake = { id: novoId, start: localParts(g.startTime).path.replace("T", " "), paciente: nome };
        estado.detalhes[novoId] = { assinatura: "", ...det };
        estado.links[novoId] = { ghlId: g.id, tipo: "agendamento", origem: "ghl" };
        ghlLigados.set(g.id, novoId);
        tocados.add(novoId);
        marcarVisto(novoId, fake, det, g);
      }
      delete estado.avisos[g.id];
      resumo.criadosDh++;
    } catch (err) { erro(`GHL ${g.id} -> DH`, err); }
  }

  // compromissos ligados que não vieram na listagem do GHL: apagados ou movidos para fora da janela
  for (const [dhId, link] of Object.entries(estado.links)) {
    if (link.tipo !== "agendamento" || ghlPorId.has(link.ghlId) || tocados.has(dhId) || !link.ghlStart) continue;
    const e = dhPorId.get(dhId);
    const det = estado.detalhes[dhId];
    if (!e || !det || DH_INATIVOS.has(det.statusId) || Date.parse(dhToIso(e.start)) < agora) continue;
    try {
      let g = null;
      try { g = await ghl.evento(link.ghlId); } catch (err) { if (err.status !== 404 && err.status !== 400) throw err; }
      if (!g || g.deleted || !g.startTime) {
        await fazer(`DH: desmarcar #${dhId} (${e.paciente}) — apagado no GHL`, () => dh.desmarcar(dhId));
        if (!dry) delete estado.links[dhId];
        resumo.atualizadosDh++;
      } else {
        await aplicarMudancaGhl(dhId, g);
      }
    } catch (err) { erro(`conferindo GHL ${link.ghlId}`, err); }
  }

  /** O compromisso ligado mudou no GHL desde a última rodada? Replica no DH. */
  async function aplicarMudancaGhl(dhId, g) {
    const link = estado.links[dhId];
    const e = dhPorId.get(dhId);
    const det = estado.detalhes[dhId];
    if (!link || !e || !det || link.tipo !== "agendamento") return;
    tocados.add(dhId);
    const mudouGhl = minuto(g.startTime) !== minuto(link.ghlStart) || g.appointmentStatus !== link.ghlStatus;
    if (!mudouGhl || DH_INATIVOS.has(det.statusId)) { marcarVisto(dhId, e, det, g); return; }
    try {
      if (GHL_INATIVOS.has(g.appointmentStatus)) {
        await fazer(`DH: desmarcar #${dhId} (${e.paciente}) — cancelado no GHL`, () => dh.desmarcar(dhId));
        if (!dry) det.statusId = "57";
      } else if (minuto(g.startTime) !== minuto(dhToIso(e.start))) {
        await fazer(`DH: remarcar #${dhId} (${e.paciente}) para ${localParts(g.startTime).br}`, () => dh.remarcar(dhId, g.startTime));
        if (!dry) e.start = localParts(g.startTime).path.replace("T", " ");
      } else { marcarVisto(dhId, e, det, g); return; }
      marcarVisto(dhId, e, det, g);
      resumo.atualizadosDh++;
    } catch (err) { erro(`GHL ${g.id} -> DH #${dhId}`, err); }
  }

  function marcarVisto(dhId, e, det, g) {
    if (dry) return;
    const l = estado.links[dhId];
    if (!l) return;
    l.dhStart = e.start;
    l.dhStatus = det.statusId;
    if (g) { l.ghlStart = g.startTime; l.ghlStatus = g.appointmentStatus; }
  }

  async function acharParNoGhl(e, det) {
    const alvo = minuto(dhToIso(e.start));
    const candidatos = eventosGhl.filter((g) => !ghlLigados.has(g.id) && minuto(g.startTime) === alvo && !GHL_INATIVOS.has(g.appointmentStatus));
    for (const g of candidatos) {
      if (norm(g.title).includes(norm(e.paciente).split(" ")[0])) return g;
      if (g.contactId && phoneKey(det.whatsapp)) {
        const c = await ghl.contato(g.contactId);
        if (phoneKey(c.phone) === phoneKey(det.whatsapp)) return g;
      }
    }
    return null;
  }

  return resumo;
}

module.exports = { sincronizar, DH_PARA_GHL };
