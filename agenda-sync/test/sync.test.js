const test = require("node:test");
const assert = require("node:assert");
const { sincronizar } = require("../src/sync");
const { localParts } = require("../src/util");

const em = (dias, hora) => {
  const d = localParts(Date.now() + dias * 86400000).day;
  return `${d} ${hora}:00`;
};
const iso = (s) => s.replace(" ", "T") + "-03:00";

function fakes({ dhEventos, dhDet, ghlEventos = [], contatos = {} }) {
  const chamadas = [];
  let seq = 0;
  const dh = {
    listarEventos: async () => dhEventos.map((e) => ({ ...e })),
    detalhes: async (id) => ({ ...dhDet[id] }),
    desmarcar: async (id) => chamadas.push(["dh.desmarcar", id]),
    remarcar: async (id, s) => chamadas.push(["dh.remarcar", id, s]),
    acharPaciente: async () => null,
    criarPaciente: async (p) => { chamadas.push(["dh.criarPaciente", p.nome]); return "P1"; },
    criarAgendamento: async (a) => {
      chamadas.push(["dh.criarAgendamento", a.idPaciente, a.startIso]);
      dhDet["900"] = { statusId: "37", categoriaId: "1", unidade: "379", whatsapp: "" };
      return "900";
    },
  };
  const ghl = {
    eventos: async () => ghlEventos.map((e) => ({ ...e })),
    evento: async (id) => { const e = ghlEventos.find((x) => x.id === id); if (!e) { const er = new Error("404"); er.status = 404; throw er; } return e; },
    contato: async (id) => contatos[id] || {},
    contatoPorTelefone: async () => "C1",
    criarAgendamento: async (a) => { chamadas.push(["ghl.criar", a.title, a.startTime, a.status]); return "G" + ++seq; },
    atualizarAgendamento: async (id, a) => chamadas.push(["ghl.atualizar", id, a.startTime, a.status]),
    criarBloqueio: async () => "B" + ++seq,
    atualizarBloqueio: async () => {},
    apagarEvento: async (id) => chamadas.push(["ghl.apagar", id]),
  };
  return { dh, ghl, chamadas };
}
const cfg = { dhUnidade: "379", ghlCalendarId: "CAL", categoriasAgendamento: ["1", "3", "6", "7"], sessoes: "ignorar",
  ghlParaDh: true, diasAtras: 1, diasFrente: 28, tagsContato: [] };
const silencio = () => {};

test("DH -> GHL: avaliação nova vira compromisso; sessão é ignorada; desmarcado não é criado", async () => {
  const dhEventos = [
    { id: "1", title: "ANA TESTE- AVALIAÇÃO- DR", paciente: "ANA TESTE", profissional: "DR", start: em(2, "09:00"), end: em(2, "09:30"), color: "#ffb94b", icon: "" },
    { id: "2", title: "BIA- LOMBAR- 03 MESES- DR", paciente: "BIA", profissional: "DR", start: em(2, "10:00"), end: em(2, "10:30"), color: "#77c4ff", icon: "" },
    { id: "3", title: "CAIO- AVALIAÇÃO- DR", paciente: "CAIO", profissional: "DR", start: em(3, "10:00"), end: em(3, "10:30"), color: "#ff4040", icon: "" },
  ];
  const dhDet = {
    1: { statusId: "37", categoriaId: "1", unidade: "379", whatsapp: "+553812345678" },
    2: { statusId: "37", categoriaId: "2", unidade: "379", whatsapp: "" },
    3: { statusId: "57", categoriaId: "1", unidade: "379", whatsapp: "" },
  };
  const { dh, ghl, chamadas } = fakes({ dhEventos, dhDet });
  const estado = {};
  const r = await sincronizar({ dh, ghl, estado, cfg, log: silencio });
  assert.strictEqual(r.criadosGhl, 1);
  assert.deepStrictEqual(chamadas, [["ghl.criar", "Avaliação - Ana Teste", iso(em(2, "09:00")), "confirmed"]]);
  assert.strictEqual(estado.links["1"].ghlId, "G1");

  // segunda rodada sem mudanças: nada acontece (o GHL agora devolve o compromisso criado)
  const f2 = fakes({ dhEventos, dhDet, ghlEventos: [{ id: "G1", startTime: iso(em(2, "09:00")), endTime: iso(em(2, "09:30")), appointmentStatus: "confirmed" }] });
  const r2 = await sincronizar({ dh: f2.dh, ghl: f2.ghl, estado, cfg, log: silencio });
  assert.deepStrictEqual(f2.chamadas, []);
  assert.strictEqual(r2.erros, 0);

  // DH marca "não compareceu": GHL recebe noshow, e isso não volta para o DH
  dhEventos[0].icon = "fa fa-user-times";
  dhDet[1].statusId = "40";
  const f3 = fakes({ dhEventos, dhDet, ghlEventos: [{ id: "G1", startTime: iso(em(2, "09:00")), endTime: iso(em(2, "09:30")), appointmentStatus: "confirmed" }] });
  await sincronizar({ dh: f3.dh, ghl: f3.ghl, estado, cfg, log: silencio });
  assert.deepStrictEqual(f3.chamadas, [["ghl.atualizar", "G1", iso(em(2, "09:00")), "noshow"]]);
});

test("GHL -> DH: compromisso marcado no GHL é criado no DH; cancelamento no GHL desmarca no DH", async () => {
  const g = { id: "GX", contactId: "C9", title: "Avaliação - Davi", startTime: iso(em(4, "15:00")), endTime: iso(em(4, "15:30")), appointmentStatus: "confirmed" };
  const dhDet = {};
  const f = fakes({ dhEventos: [], dhDet, ghlEventos: [g], contatos: { C9: { firstName: "Davi", lastName: "Teste", phone: "+5538999990000" } } });
  const estado = {};
  const r = await sincronizar({ dh: f.dh, ghl: f.ghl, estado, cfg, log: silencio });
  assert.strictEqual(r.criadosDh, 1);
  assert.deepStrictEqual(f.chamadas, [["dh.criarPaciente", "Davi Teste"], ["dh.criarAgendamento", "P1", g.startTime]]);
  assert.strictEqual(estado.links["900"].ghlId, "GX");

  // próxima rodada: DH já mostra o agendamento 900; GHL cancela
  const dhEventos = [{ id: "900", title: "DAVI TESTE- AVALIAÇÃO- DR", paciente: "DAVI TESTE", profissional: "DR", start: em(4, "15:00"), end: em(4, "15:30"), color: "#ffb94b", icon: "" }];
  const f2 = fakes({ dhEventos, dhDet, ghlEventos: [{ ...g, appointmentStatus: "cancelled" }] });
  await sincronizar({ dh: f2.dh, ghl: f2.ghl, estado, cfg, log: silencio });
  assert.deepStrictEqual(f2.chamadas, [["dh.desmarcar", "900"]]);
});

test("GHL -> DH: horário já ocupado por outra avaliação gera conflito e não cria", async () => {
  const dhEventos = [{ id: "5", title: "EVA- AVALIAÇÃO- DR", paciente: "EVA", profissional: "DR", start: em(2, "14:00"), end: em(2, "14:30"), color: "#ffb94b", icon: "" }];
  const dhDet = { 5: { statusId: "37", categoriaId: "1", unidade: "379", whatsapp: "+553800000001" } };
  const g = { id: "GY", contactId: "C2", title: "Avaliação - Fabio", startTime: iso(em(2, "14:00")), endTime: iso(em(2, "14:30")), appointmentStatus: "confirmed" };
  const f = fakes({ dhEventos, dhDet, ghlEventos: [g], contatos: { C2: { firstName: "Fabio", phone: "+5538999990002" } } });
  const estado = {};
  const r = await sincronizar({ dh: f.dh, ghl: f.ghl, estado, cfg, log: silencio });
  assert.strictEqual(r.conflitos, 1);
  assert.ok(!f.chamadas.some((c) => c[0].startsWith("dh.")));
});

test("simulação não grava nada", async () => {
  const g = { id: "GZ", contactId: "C3", title: "x", startTime: iso(em(5, "08:00")), endTime: iso(em(5, "08:30")), appointmentStatus: "confirmed" };
  const f = fakes({ dhEventos: [], dhDet: {}, ghlEventos: [g], contatos: { C3: { firstName: "Gil" } } });
  const estado = {};
  await sincronizar({ dh: f.dh, ghl: f.ghl, estado, cfg: { ...cfg, dryRun: true }, log: silencio });
  assert.deepStrictEqual(f.chamadas, []);
  assert.deepStrictEqual(estado.links, {});
});
