// Cliente da API v2 do GoHighLevel (LeadConnector) com token de Integração Privada da subconta.
// Escopos necessários no token: calendars.readonly, calendars.write, calendars/events.readonly,
// calendars/events.write, contacts.readonly, contacts.write.

const { sleep, phoneKey, phoneE164 } = require("./util");

const API = "https://services.leadconnectorhq.com";

class GoHighLevel {
  constructor({ token, locationId, log = console.log }) {
    if (!token) throw new Error("GHL_TOKEN não configurado");
    if (!locationId) throw new Error("GHL_LOCATION_ID não configurado");
    this.token = token;
    this.locationId = locationId;
    this.log = log;
  }

  async call(method, path, { query, body, version = "2021-04-15" } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, v);
    for (let tentativa = 1; ; tentativa++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Version: version,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 && tentativa < 5) { await sleep(1000 * tentativa); continue; }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (!res.ok) {
        const msg = (json && (json.message || json.msg)) || text.slice(0, 200);
        const err = new Error(`GHL ${method} ${path} -> HTTP ${res.status}: ${Array.isArray(msg) ? msg.join("; ") : msg}`);
        err.status = res.status;
        throw err;
      }
      return json;
    }
  }

  async calendarios() {
    const j = await this.call("GET", "/calendars/", { query: { locationId: this.locationId } });
    return j.calendars || [];
  }

  /** Agendamentos (não bloqueios) do calendário no intervalo. */
  async eventos(calendarId, inicioMs, fimMs) {
    const j = await this.call("GET", "/calendars/events", {
      query: { locationId: this.locationId, calendarId, startTime: String(inicioMs), endTime: String(fimMs) },
    });
    return (j.events || []).filter((e) => !e.deleted);
  }

  async evento(id) {
    const j = await this.call("GET", `/calendars/events/appointments/${id}`);
    return j.appointment || j.event || j;
  }

  async contato(id) {
    const j = await this.call("GET", `/contacts/${id}`, { version: "2021-07-28" });
    return j.contact || j;
  }

  /** Acha contato pelo telefone (com ou sem nono dígito); cria se não existir. */
  async contatoPorTelefone({ nome, telefone, tags = [] }) {
    const key = phoneKey(telefone);
    if (key.length === 10) {
      const j = await this.call("POST", "/contacts/search", {
        version: "2021-07-28",
        body: { locationId: this.locationId, pageLimit: 20, query: key.slice(-8) },
      });
      const achado = (j.contacts || []).find((c) => phoneKey(c.phone) === key);
      if (achado) return achado.id;
    }
    const partes = String(nome || "").trim().split(/\s+/);
    const j = await this.call("POST", "/contacts/upsert", {
      version: "2021-07-28",
      body: {
        locationId: this.locationId,
        firstName: partes[0] || "Paciente",
        lastName: partes.slice(1).join(" ") || undefined,
        phone: phoneE164(telefone) || undefined,
        tags,
        source: "Doutor Hérnia (agenda-sync)",
      },
    });
    return (j.contact || j).id;
  }

  async criarAgendamento({ calendarId, contactId, title, startTime, endTime, status, assignedUserId, notes }) {
    const j = await this.call("POST", "/calendars/events/appointments", {
      body: {
        calendarId, locationId: this.locationId, contactId, title, startTime, endTime,
        appointmentStatus: status, assignedUserId, description: notes,
        ignoreDateRange: true, ignoreFreeSlotValidation: true, toNotify: false,
      },
    });
    return j.id || (j.appointment || j.event || {}).id;
  }

  async atualizarAgendamento(id, { title, startTime, endTime, status, notes }) {
    await this.call("PUT", `/calendars/events/appointments/${id}`, {
      body: {
        title, startTime, endTime, appointmentStatus: status, description: notes,
        ignoreDateRange: true, ignoreFreeSlotValidation: true, toNotify: false,
      },
    });
  }

  async criarBloqueio({ calendarId, title, startTime, endTime }) {
    const j = await this.call("POST", "/calendars/events/block-slots", {
      body: { calendarId, locationId: this.locationId, title, startTime, endTime },
    });
    return j.id || (j.event || {}).id;
  }

  async atualizarBloqueio(id, { calendarId, title, startTime, endTime }) {
    await this.call("PUT", `/calendars/events/block-slots/${id}`, {
      body: { calendarId, locationId: this.locationId, title, startTime, endTime },
    });
  }

  async apagarEvento(id) {
    await this.call("DELETE", `/calendars/events/${id}`, { body: {} });
  }
}

module.exports = { GoHighLevel };
