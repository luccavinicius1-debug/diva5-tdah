# agenda-sync — Doutor Hérnia ⇄ GoHighLevel (unidade Janaúba)

Mantém a agenda do **Doutor Hérnia** (`app.doutorhernia.com.br/dashboard/agenda`, unidade
JANAÚBA - MG) e um **calendário do GoHighLevel** (subconta `j3PgGRcO91FQMdNKo3bD`) iguais,
nos dois sentidos.

| Acontece em… | O que o sync faz no outro sistema |
|---|---|
| DH: nova avaliação/retorno/reavaliação | GHL: cria compromisso "Avaliação - Nome" no calendário, ligado ao contato (achado pelo WhatsApp; criado se não existir) |
| DH: muda horário ou status | GHL: atualiza o compromisso (Atendido → *showed*, Não compareceu → *noshow*, Desmarcado/Remarcado → *cancelled*) |
| DH: agendamento excluído | GHL: cancela o compromisso |
| GHL: compromisso novo (ex.: marcado pela IA Olívia) | DH: acha o paciente pelo telefone/nome (ou cria lead → paciente) e cria a **AVALIAÇÃO** com o Dr. Emanuel |
| GHL: compromisso cancelado ou apagado | DH: muda o status para **DESMARCADO** |
| GHL: compromisso mudou de horário | DH: remarca para o novo horário |
| GHL: horário já ocupado por outra avaliação no DH | **não cria**: registra `CONFLITO` no log para a recepção resolver |

- Se um mesmo atendimento já existe nos dois lados (mesmo horário, mesmo telefone ou mesmo
  primeiro nome), o sync só **liga** os dois, sem duplicar.
- Se os dois lados mudarem o mesmo agendamento entre duas rodadas, vale o Doutor Hérnia.
- Sessões de tratamento (`LOMBAR - 03 MESES` etc.) ficam de fora por padrão. Com `SESSOES=bloquear`
  elas viram horários bloqueados no GHL, e a IA deixa de oferecer esses horários.
- Janela: de ontem até 28 dias à frente (é o que a página da agenda do DH mostra).
- O Doutor Hérnia não tem API: o sync entra com usuário e senha e usa as mesmas páginas e
  formulários que a recepção usa. Ele troca a "Unidade Ativa" só na própria sessão dele, então
  não muda a tela de quem está usando o sistema.

## Configurar (uma vez)

1. **Token do GoHighLevel**: na subconta de Janaúba, *Configurações → Integrações Privadas →
   Criar nova integração*, com os escopos `calendars.readonly`, `calendars.write`,
   `calendars/events.readonly`, `calendars/events.write`, `contacts.readonly`, `contacts.write`.
   Copie o token (`pit-...`).
2. `cp .env.example .env` e preencha `DH_EMAIL`, `DH_PASSWORD` e `GHL_TOKEN`.
3. Descubra o calendário de avaliações de Janaúba e coloque o id em `GHL_CALENDAR_ID`:
   ```bash
   node index.js calendarios
   ```
4. Rode uma **simulação** (não grava nada, só mostra o que faria):
   ```bash
   node index.js simular
   ```
5. Se estiver tudo certo, rode de verdade:
   ```bash
   node index.js uma-vez        # uma rodada
   node index.js rodar 5        # fica sincronizando a cada 5 minutos
   ```

Precisa de Node 20 ou mais novo. Não há dependências para instalar.

## Deixar rodando sozinho

**No Mac** (launchd, a cada 5 min): crie `~/Library/LaunchAgents/br.doutorhernia.agenda-sync.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>br.doutorhernia.agenda-sync</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/CAMINHO/PARA/agenda-sync/index.js</string>
    <string>uma-vez</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>/tmp/agenda-sync.log</string>
  <key>StandardErrorPath</key><string>/tmp/agenda-sync.log</string>
</dict></plist>
```

e ative com `launchctl load ~/Library/LaunchAgents/br.doutorhernia.agenda-sync.plist`.
(Ajuste o caminho do `node` com `which node`.)

**Num servidor** (Railway, VPS etc.): comando de start `node index.js rodar 5`, com as variáveis
do `.env.example` configuradas no painel e um volume persistente montado em `estado/`.

## Estado

`estado/janauba.json` guarda os pares `agendamento DH ⇄ compromisso GHL`. Não apague com o sync
rodando; se apagar, a próxima rodada religa os pares que estiverem no mesmo horário com o mesmo
paciente (não duplica). Essa pasta e o `.env` estão no `.gitignore`.

## Testes

```bash
node --test test/*.test.js
```
