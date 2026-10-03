// Cliente HTTP do sistema Doutor Hérnia (app.doutorhernia.com.br).
// Não há API oficial: o cliente faz login com usuário/senha e lê/envia as mesmas páginas
// e formulários que o navegador usa.

const { sleep, norm, phoneKey, localParts, parseAgendaEvents, selectedOption, serializeForm, setFields } = require("./util");

const BASE = "https://app.doutorhernia.com.br";

// Ids fixos do sistema (ver formulário de agendamento)
const STATUS = {
  37: "AGENDADO", 38: "CONFIRMADO", 39: "ATRASADO", 40: "NÃO COMPARECEU",
  41: "REMARCADO", 42: "ATENDIDO", 53: "AGUARDANDO", 57: "DESMARCADO",
};
const STATUS_DESMARCADO = "57";

class DoutorHernia {
  constructor({ email, password, unidade, log = console.log }) {
    if (!email || !password) throw new Error("DH_EMAIL/DH_PASSWORD não configurados");
    this.email = email;
    this.password = password;
    this.unidade = String(unidade);
    this.log = log;
    this.cookies = {};
    this.loggedIn = false;
    this.unidadeOriginal = null;
  }

  cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async req(pathname, { method = "GET", form = null, redirect = "manual" } = {}) {
    const headers = {
      "Accept-Language": "pt-BR,pt;q=0.9", // sem isso o site devolve erro PHP
      "User-Agent": "Mozilla/5.0 agenda-sync",
      Cookie: this.cookieHeader(),
    };
    let body;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString(); // aceita objeto ou lista [[k,v]]
    }
    const url = pathname.startsWith("http") ? pathname : BASE + pathname;
    const res = await fetch(url, { method, headers, body, redirect });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    return res;
  }

  async login() {
    await this.req("/login");
    const res = await this.req("/login", { method: "POST", form: { email: this.email, password: this.password } });
    if (!(res.headers.get("location") || "").includes("dashboard")) {
      throw new Error("login no Doutor Hérnia falhou (confira DH_EMAIL/DH_PASSWORD)");
    }
    this.loggedIn = true;
  }

  async html(pathname, opts = {}) {
    if (!this.loggedIn) await this.login();
    let res = await this.req(pathname, { ...opts, redirect: "follow" });
    let text = await res.text();
    if (text.includes('name="password"') && text.includes("/login")) {
      this.loggedIn = false;
      await this.login();
      res = await this.req(pathname, { ...opts, redirect: "follow" });
      text = await res.text();
    }
    return text;
  }

  /** POST de formulário sem seguir o redirect; devolve {status, location, text}. */
  async post(pathname, fields) {
    if (!this.loggedIn) await this.login();
    const res = await this.req(pathname, { method: "POST", form: fields });
    return { status: res.status, location: res.headers.get("location") || "", text: await res.text() };
  }

  /** A agenda mostra só a "Unidade Ativa" da sessão. Troca para a unidade configurada. */
  async ativarUnidade() {
    const page = await this.html("/dashboard/agenda");
    const atual = (selectedOption(page, "id_company") || {}).value;
    if (this.unidadeOriginal === null) this.unidadeOriginal = atual || "";
    if (atual === this.unidade) return page;
    await this.post("/dashboard/alterar_unidade", { id_company: this.unidade, url: BASE + "/dashboard/agenda" });
    const depois = await this.html("/dashboard/agenda");
    if ((selectedOption(depois, "id_company") || {}).value !== this.unidade) {
      throw new Error(`não consegui ativar a unidade ${this.unidade} no Doutor Hérnia`);
    }
    return depois;
  }

  /** Volta para a unidade que estava ativa antes (para não mudar a tela de quem usa o mesmo login). */
  async restaurarUnidade() {
    if (!this.unidadeOriginal || this.unidadeOriginal === this.unidade) return;
    await this.post("/dashboard/alterar_unidade", { id_company: this.unidadeOriginal, url: BASE + "/dashboard/agenda" });
  }

  /** Agendamentos da unidade ativa (a página traz ~30 dias para trás e ~30 para frente). */
  async listarEventos() {
    const page = await this.ativarUnidade();
    return parseAgendaEvents(page);
  }

  /** Detalhes de um agendamento (página de edição). */
  async detalhes(id) {
    const page = await this.html(`/agendamentos/editar/${id}`);
    const status = selectedOption(page, "id_status") || {};
    const cat = selectedOption(page, "id_category") || {};
    const unidade = (page.match(/<select[^>]*name="id_company" id="id_company"[\s\S]*?<option value="(\d+)" selected/) || [])[1];
    const whatsapp = (page.match(/name="whatsapp"[^>]*value="([^"]*)"/) || [])[1] || "";
    const idClient = (page.match(/name="id_client" value="(\d+)"/) || [])[1] || "";
    const date = (page.match(/name="date" value="([^"]*)"/) || [])[1] || "";
    return {
      id: String(id),
      statusId: status.value || "",
      status: status.label || "",
      categoriaId: cat.value || "",
      categoria: cat.label || "",
      unidade: unidade || "",
      whatsapp,
      idClient,
      date,
    };
  }

  /** Muda o status de um agendamento reenviando o formulário de edição completo. */
  async alterarAgendamento(id, overrides) {
    const page = await this.html(`/agendamentos/editar/${id}`);
    const form = serializeForm(page, `agendamentos/editar/${id}`);
    const fields = setFields(form.fields, overrides);
    const r = await this.post(form.action, fields);
    if (r.status >= 400 || /ERROR-/.test(r.text)) throw new Error(`falha ao alterar agendamento ${id} (HTTP ${r.status})`);
  }

  async desmarcar(id) {
    await this.alterarAgendamento(id, { id_status: STATUS_DESMARCADO });
  }

  async remarcar(id, startIso) {
    await this.alterarAgendamento(id, { date: localParts(startIso).br });
  }

  /** Busca pacientes no Cadastro. Devolve [{id, unidade, nome, telefone}]. */
  async buscarPacientes(keyword) {
    const page = await this.html("/pacientes/filtrar", { method: "POST", form: { keyword } });
    const out = [];
    for (const m of page.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const v = m[1].match(/pacientes\/visualizar\/(\d+)/);
      if (!v) continue;
      const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      out.push({ id: v[1], unidade: cells[1] || "", nome: cells[2] || "", telefone: cells[4] || "" });
    }
    return out;
  }

  /** Acha o paciente pelo telefone (preferência) ou pelo nome exato. */
  async acharPaciente({ nome, telefone }) {
    const key = phoneKey(telefone);
    if (key) {
      for (const termo of [key.slice(-8), key.slice(-8, -4) + "-" + key.slice(-4)]) {
        const achados = (await this.buscarPacientes(termo)).filter((p) => phoneKey(p.telefone) === key);
        if (achados.length) return achados[0];
      }
    }
    if (nome) {
      const achados = (await this.buscarPacientes(nome)).filter((p) => norm(p.nome) === norm(nome));
      // por nome só aceita se for único e o telefone não contradizer
      const ok = achados.filter((p) => !key || !phoneKey(p.telefone) || phoneKey(p.telefone) === key);
      if (ok.length === 1) return ok[0];
    }
    return null;
  }

  /** Cria lead e converte em paciente. Devolve o id do paciente. */
  async criarPaciente({ nome, telefone, origem, categoriaLead }) {
    const ddd = phoneKey(telefone);
    const whatsapp = ddd.length === 10 ? `${ddd.slice(0, 2)}9${ddd.slice(2)}` : String(telefone).replace(/\D/g, "");
    const criar = await this.html("/leads/criar");
    const form = serializeForm(criar, "leads/criar");
    const r = await this.post(form.action, setFields(form.fields, {
      id_company: this.unidade,
      id_source: origem,
      name: nome,
      whatsapp,
      id_category: categoriaLead,
      description: "Criado automaticamente pelo agenda-sync (agendamento feito no GoHighLevel)",
    }));
    if (r.status >= 400) throw new Error(`falha ao criar lead (HTTP ${r.status})`);
    await sleep(500);

    // o lead novo aparece no topo da lista
    const lista = await this.html("/leads");
    let idLead = null;
    for (const m of lista.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const v = m[1].match(/leads\/visualizar\/(\d+)/);
      if (v && norm(m[1].replace(/<[^>]+>/g, " ")).includes(norm(nome))) { idLead = v[1]; break; }
    }
    if (!idLead) throw new Error(`lead de ${nome} criado mas não encontrado na lista`);

    const cad = await this.html(`/pacientes/cadastrar/${idLead}`);
    const f2 = serializeForm(cad, "pacientes/cadastrar");
    const r2 = await this.post(f2.action, setFields(f2.fields, { id_company: this.unidade }));
    const idPaciente = (r2.location.match(/agendamentos\/criar\/null\/(\d+)/) || [])[1];
    if (!idPaciente) throw new Error(`lead ${idLead} não virou paciente (redirect: ${r2.location || r2.status})`);
    return idPaciente;
  }

  /**
   * Cria um agendamento para um paciente existente. Devolve o id do agendamento
   * (achado relendo a agenda no mesmo horário).
   */
  async criarAgendamento({ idPaciente, nome, startIso, profissional, categoria, origem, descricao }) {
    const quando = localParts(startIso);
    const page = await this.html(`/agendamentos/criar/null/${idPaciente}`);
    const form = serializeForm(page, "agendamentos/criar");
    const r = await this.post(form.action, setFields(form.fields, {
      id_client: idPaciente,
      id_company: this.unidade,
      id_hidden_company: this.unidade,
      id_source: origem,
      date: quando.br,
      id_staff: profissional,
      id_category: categoria,
      disable_payments: "1", // pagamento é feito no dia, na recepção
      description: descricao,
    }));
    if (r.status >= 400 || /ERROR-/.test(r.text)) throw new Error(`falha ao criar agendamento (HTTP ${r.status})`);
    await sleep(500);

    const eventos = await this.listarEventos();
    const primeiro = norm(nome).split(" ")[0];
    const novo = eventos
      .filter((e) => e.start.slice(0, 16) === quando.path.slice(0, 16).replace("T", " "))
      .filter((e) => norm(e.paciente).startsWith(primeiro))
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (!novo) throw new Error(`agendamento de ${nome} em ${quando.br} enviado, mas não apareceu na agenda`);
    return novo.id;
  }
}

module.exports = { DoutorHernia, STATUS, STATUS_DESMARCADO };
