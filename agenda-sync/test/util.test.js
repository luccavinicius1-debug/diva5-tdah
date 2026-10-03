const test = require("node:test");
const assert = require("node:assert");
const u = require("../src/util");

test("phoneKey ignora DDI e nono dígito", () => {
  for (const p of ["+553812345678", "(38) 91234-5678", "5538912345678", "38 1234-5678"]) {
    assert.strictEqual(u.phoneKey(p), "3812345678");
  }
  assert.strictEqual(u.phoneE164("+553812345678"), "+5538912345678");
});

test("datas no fuso -03:00", () => {
  assert.strictEqual(u.dhToIso("2026-10-05 11:30:00"), "2026-10-05T11:30:00-03:00");
  const p = u.localParts("2026-10-05T14:30:00Z");
  assert.strictEqual(p.br, "05/10/2026 11:30");
  assert.strictEqual(p.path, "2026-10-05T11:30:00");
});

test("parseAgendaEvents lê o array do FullCalendar e pula o almoço", () => {
  const html = `x\n                      events: [{"title":"FULANO TESTE- AVALIA\\u00c7\\u00c3O- DR X","start":"2026-10-05 11:30:00","end":"2026-10-05 12:00:00","description":"<i class=\\"fa fa-calendar\\"><\\/i>","url":"https:\\/\\/app.doutorhernia.com.br\\/agendamentos\\/editar\\/123","backgroundColor":"#ffb94b"},{"title":"Hor\\u00e1rio de Almo\\u00e7o","startTime":"12:00","endTime":"14:00"}],\n y`;
  const ev = u.parseAgendaEvents(html);
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual([ev[0].id, ev[0].paciente, ev[0].profissional, ev[0].icon], ["123", "FULANO TESTE", "DR X", "fa fa-calendar"]);
});

test("serializeForm imita o navegador", () => {
  const html = `<form action="/outra"><input name="a" value="1"></form>
  <form action="https://x/agendamentos/editar/9" method="post">
    <input type="hidden" name="url" value="u&amp;1">
    <select name="id_status"><option value="37" selected>AGENDADO</option><option value="57">DESMARCADO</option></select>
    <select name="vazio"><option value="1">A</option><option value="2">B</option></select>
    <input type="checkbox" name="cb" value="1">
    <input type="checkbox" name="cb2" value="1" checked>
    <textarea name="description">texto</textarea>
    <input type="radio" name="check" value="' + item.id + '">
    <input type="text" name="date" value="05/10/2026 11:30" required/>
  </form>`;
  const f = u.serializeForm(html, "agendamentos/editar/9");
  assert.strictEqual(f.action, "https://x/agendamentos/editar/9");
  assert.deepStrictEqual(Object.fromEntries(f.fields), { url: "u&1", id_status: "37", vazio: "1", cb2: "1", description: "texto", date: "05/10/2026 11:30" });
  const g = Object.fromEntries(u.setFields(f.fields, { id_status: "57" }));
  assert.strictEqual(g.id_status, "57");
});
