import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { MessageStore } from '../store/sqlite-message-store.js';
import { normalizePhone } from '../phone.js';

export interface WhatsAppSendPayload {
  chatId: string;
  text: string;
  image?: Buffer;
  imageName?: string;
  document?: Buffer;
  documentName?: string;
  documentMime?: string;
}

export interface OperatorServerOptions {
  tenantId: string;
  store: MessageStore;
  whitelistPhones: string[];
  authToken: string;
  noAuth?: boolean;
  getAutoReplyAudience?: () => 'whitelist' | 'all';
  setAutoReplyAudience?: (audience: 'whitelist' | 'all') => Promise<void> | void;
  sendWhatsAppMessage: (payload: WhatsAppSendPayload) => Promise<string | undefined>;
}

export function createOperatorHttpServer(options: OperatorServerOptions): Server {
  if (!options.noAuth && (!options.authToken || options.authToken.length < 16)) {
    throw new Error('operator authToken missing or too short (min 16 chars)');
  }
  return createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && parsed.pathname === '/') return sendHtml(res, dashboardHtml(options.noAuth ?? false));
      if (req.method === 'GET' && parsed.pathname === '/qr') return sendHtml(res, qrPageHtml());
      if (req.method === 'GET' && parsed.pathname === '/qr.png') {
        try {
          const png = readFileSync('data/latest-qr.png');
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          return res.end(png);
        } catch {
          return sendJson(res, { error: 'qr_not_ready' }, 404);
        }
      }

      if (!options.noAuth && parsed.pathname.startsWith('/api/') && !isAuthorized(req, options.authToken)) {
        return sendJson(res, { error: 'unauthorized' }, 401);
      }
      if (req.method === 'GET' && parsed.pathname === '/api/conversations') return sendJson(res, { conversations: await options.store.listConversations(options.tenantId) });
      if (req.method === 'GET' && parsed.pathname === '/api/messages') {
        const chatId = parsed.searchParams.get('chatId');
        if (!chatId) return sendJson(res, { error: 'chatId_required' }, 400);
        return sendJson(res, { messages: await options.store.listMessagesByChat(options.tenantId, chatId) });
      }
      if (req.method === 'GET' && parsed.pathname === '/api/settings') {
        return sendJson(res, { autoReplyAudience: options.getAutoReplyAudience?.() ?? 'whitelist' });
      }
      if (req.method === 'GET' && parsed.pathname === '/api/conversation-settings') {
        const chatId = parsed.searchParams.get('chatId');
        if (!chatId) return sendJson(res, { error: 'chatId_required' }, 400);
        return sendJson(res, { settings: await options.store.getConversationSettings(options.tenantId, chatId) });
      }
      if (req.method === 'POST' && parsed.pathname === '/api/conversation-settings') {
        const body = await readJson(req);
        const chatId = String(body.chatId ?? '').trim();
        if (!chatId) return sendJson(res, { error: 'chatId_required' }, 400);
        const settings = await options.store.setConversationSettings(options.tenantId, chatId, {
          botEnabled: typeof body.botEnabled === 'boolean' ? body.botEnabled : undefined,
          tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
          note: typeof body.note === 'string' ? body.note : undefined
        });
        return sendJson(res, { ok: true, settings });
      }
      if (req.method === 'POST' && parsed.pathname === '/api/settings') {
        const body = await readJson(req);
        const audience = body.autoReplyAudience === 'all' ? 'all' : 'whitelist';
        await options.setAutoReplyAudience?.(audience);
        return sendJson(res, { ok: true, autoReplyAudience: audience });
      }
      if (req.method === 'GET' && parsed.pathname === '/api/history-import') {
        return sendJson(res, await getHistoryImportStatus(options.store));
      }
      if (req.method === 'POST' && parsed.pathname === '/api/history-import/start') {
        const status = await getHistoryImportStatus(options.store);
        if (status.status === 'completed') return sendJson(res, { error: 'history_import_already_completed', ...status }, 409);
        if (status.status === 'listening') return sendJson(res, status);
        const next = { status: 'listening', progress: 0, imported: 0, note: 'Pasif history listener açık. Bu gerçek bir geçmiş aktarımı değildir; WhatsApp/Baileys yalnızca ilk eşleşme sırasında history event gönderirse kayıt düşer.', startedAt: new Date().toISOString() };
        await setHistoryImportStatus(options.store, next);
        return sendJson(res, next);
      }
      if (req.method === 'GET' && parsed.pathname === '/api/whitelist') return sendJson(res, { phones: options.whitelistPhones });
      if (req.method === 'POST' && parsed.pathname === '/api/whitelist') {
        const body = await readJson(req);
        const phone = normalizePhone(String(body.phone ?? ''));
        if (!phone) return sendJson(res, { error: 'phone_required' }, 400);
        if (!options.whitelistPhones.map(normalizePhone).includes(phone)) options.whitelistPhones.push(phone);
        return sendJson(res, { ok: true, phones: options.whitelistPhones });
      }
      if (req.method === 'DELETE' && parsed.pathname.startsWith('/api/whitelist/')) {
        const phone = normalizePhone(decodeURIComponent(parsed.pathname.split('/').pop() ?? ''));
        const before = options.whitelistPhones.length;
        for (let i = options.whitelistPhones.length - 1; i >= 0; i -= 1) {
          if (normalizePhone(options.whitelistPhones[i] ?? '') === phone) options.whitelistPhones.splice(i, 1);
        }
        return sendJson(res, { ok: true, removed: before !== options.whitelistPhones.length, phones: options.whitelistPhones });
      }
      if (req.method === 'POST' && parsed.pathname === '/api/send') {
        const body = await readJson(req);
        const chatId = String(body.chatId ?? '').trim();
        const text = String(body.text ?? '').trim();
        const imageData = typeof body.imageData === 'string' ? body.imageData : '';
        const imageName = typeof body.imageName === 'string' ? body.imageName.trim() : undefined;
        const imageFile = imageData ? decodeDataUrl(imageData, 'image') : undefined;
        const documentData = typeof body.documentData === 'string' ? body.documentData : '';
        const documentName = typeof body.documentName === 'string' ? body.documentName.trim() : undefined;
        const documentFile = documentData ? decodeDataUrl(documentData, 'document') : undefined;
        if (!chatId) return sendJson(res, { error: 'chatId_required' }, 400);
        if (!text && !imageFile && !documentFile) return sendJson(res, { error: 'text_or_file_required' }, 400);

        const providerMessageId = await options.sendWhatsAppMessage({ chatId, text, image: imageFile?.buffer, imageName, document: documentFile?.buffer, documentName, documentMime: documentFile?.mime });
        const messageId = providerMessageId || `manual-${randomUUID()}`;
        const mediaKind = imageFile ? 'image' : documentFile ? 'document' : undefined;
        const mediaName = imageFile ? imageName : documentFile ? documentName : undefined;
        const mediaMime = imageFile?.mime ?? documentFile?.mime;
        const mediaData = imageData || documentData || undefined;
        await options.store.saveOutbound({
          tenantId: options.tenantId,
          channel: 'whatsapp',
          provider: 'baileys',
          direction: 'outbound',
          origin: 'manual',
          messageId,
          chatId,
          recipientPhone: normalizePhone(chatId.split('@')[0] ?? chatId),
          text: text || `[${mediaKind === 'image' ? 'Görsel' : 'Dosya'}] ${mediaName ?? ''}`.trim(),
          mediaKind,
          mediaName,
          mediaMime,
          mediaData,
          sentAt: new Date()
        });
        return sendJson(res, { ok: true, messageId });
      }
      return sendJson(res, { error: 'not_found' }, 404);
    } catch (error) {
      console.error('Operator API hatası:', error);
      return sendJson(res, { error: 'internal_error' }, 500);
    }
  });
}

function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1].trim(), 'utf8');
  const exp = Buffer.from(expected, 'utf8');
  if (provided.length !== exp.length) return false;
  return timingSafeEqual(provided, exp);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

interface DecodedDataUrl { buffer: Buffer; mime: string }

async function getHistoryImportStatus(store: MessageStore): Promise<Record<string, unknown>> {
  const raw = await store.getAppState('history_import');
  if (!raw) return { status: 'idle', progress: 0, imported: 0 };
  return JSON.parse(raw) as Record<string, unknown>;
}

async function setHistoryImportStatus(store: MessageStore, status: Record<string, unknown>): Promise<void> {
  await store.setAppState('history_import', JSON.stringify(status));
}

function decodeDataUrl(value: string, kind: 'image' | 'document'): DecodedDataUrl {
  const match = value.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) throw new Error('invalid_data_url');
  const mime = match[1] ?? 'application/octet-stream';
  if (kind === 'image' && !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('invalid_image_data_url');
  return { buffer: Buffer.from(match[2] ?? '', 'base64'), mime };
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function sendHtml(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function qrPageHtml(): string {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="5" />
<title>WhatsApp QR</title>
<style>body{margin:0;background:#0b141a;color:#e9edef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center;padding:24px}.q{width:340px;height:340px;background:#fff;padding:14px;border-radius:14px;margin:18px auto;display:block}.muted{color:#8696a0;font-size:13px}</style>
</head><body>
<h2>+1 hattından okut</h2>
<p>WhatsApp Business → Ayarlar → Bağlı Cihazlar → Cihaz Bağla</p>
<img class="q" src="/qr.png?t=${Date.now()}" alt="QR hazırlanıyor, birkaç sn bekleyin..." />
<p class="muted">Sayfa 5 sn'de bir yenilenir (QR tazelenir). Bağlanınca bu sekmeyi kapatıp panele dön.</p>
</body></html>`;
}

function dashboardHtml(noAuth: boolean): string {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MURTAZA WhatsApp Operatör Paneli</title>
<style>
:root{
  color-scheme:dark;
  --bg:#0b141a;--panel:#111b21;--panel2:#202c33;--line:#24333b;
  --text:#e9edef;--muted:#8696a0;--green:#00a884;
  --manual:#005c4b;--bot:#3b2d73;--in:#202c33;--warn:#f5c542;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
*{box-sizing:border-box}
html,body{height:100%;overflow:hidden}
body{margin:0;background:var(--bg);color:var(--text)}
.app{display:grid;grid-template-columns:340px minmax(420px,1fr) 340px;height:100dvh;max-height:100dvh;overflow:hidden}
.left,.chat,.right{min-width:0;min-height:0;border-right:1px solid var(--line);background:var(--bg)}
.bar{height:64px;display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line)}
.brand{font-weight:800}
.sub{color:var(--muted);font-size:12px}
.avatar{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#00a884,#128c7e);font-weight:800}
.spacer{flex:1}
.icon{border:0;background:transparent;color:var(--text);font-size:20px;width:36px;height:36px;border-radius:50%;cursor:pointer}
.icon:hover{background:var(--panel2)}
.linkish{cursor:pointer}
.linkish:hover{opacity:.85}

#conversations{height:calc(100vh - 116px);overflow:auto}
.search{padding:10px;background:var(--panel)}
.search input{width:100%;border:0;border-radius:8px;background:#2a3942;color:var(--text);padding:10px}
.conv{display:flex;gap:12px;padding:12px 14px;border-bottom:1px solid #1f2c33;cursor:pointer}
.conv:hover,.conv.active{background:var(--panel2)}
.conv .meta{min-width:0;flex:1}
.name{font-weight:700}
.last{color:#aebac1;font-size:13px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.time{font-size:11px;color:var(--muted)}
.badge{display:inline-block;min-width:18px;padding:0 6px;border-radius:9px;background:var(--green);color:#041410;font-size:11px;font-weight:800;text-align:center}

.chat{display:flex;flex-direction:column;height:100%;overflow:hidden}
.chatHead{flex:0 0 64px;cursor:pointer}
.chatHead .ttl{display:flex;flex-direction:column}
.statusDot{width:9px;height:9px;border-radius:50%;background:var(--green);display:inline-block}
.messages{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:22px;background-color:#0b141a;background-image:radial-gradient(rgba(255,255,255,.035) 1px,transparent 1px);background-size:22px 22px}

.msg{max-width:72%;margin:8px 0;padding:8px 10px 6px;border-radius:10px;line-height:1.35;white-space:pre-wrap;box-shadow:0 1px 0 rgba(0,0,0,.18);position:relative}
.msg .label{display:block;font-size:11px;font-weight:800;margin-bottom:4px;opacity:.8}
.msg .time{display:block;font-size:10px;color:rgba(233,237,239,.55);margin-top:4px;text-align:right}
.inbound{background:var(--in);margin-right:auto}
.outbound.manual{background:var(--manual);margin-left:auto}
.outbound.self{background:var(--manual);margin-left:auto}
.outbound.bot{background:var(--bot);border:1px solid rgba(255,255,255,.12);margin-left:auto}
.mediaBadge{display:inline-flex;align-items:center;gap:6px;padding:6px 8px;margin-bottom:6px;background:rgba(0,0,0,.2);border-radius:8px;font-size:12px}

.composerWrap{flex:0 0 auto;background:var(--panel);border-top:1px solid var(--line);padding:8px 10px;position:relative}
.composer{display:flex;align-items:flex-end;gap:6px}
.composer textarea{min-height:46px;max-height:130px;resize:none;flex:1;border:0;border-radius:10px;background:#2a3942;color:var(--text);padding:12px;font:inherit}
.send{background:var(--green);color:#041410;border:0;border-radius:10px;padding:13px 18px;font-weight:800;cursor:pointer}
.attachName{font-size:12px;color:#ffd56b;margin:0 0 6px 6px}
.quickRow{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.quickRow button{background:#2a3942;color:var(--text);border:0;border-radius:999px;padding:6px 10px;font-size:12px;cursor:pointer}
.quickRow button:hover{background:var(--panel2)}
.emojiPicker{position:absolute;bottom:64px;left:10px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:8px;display:none;z-index:5}
.emojiPicker.open{display:flex;flex-wrap:wrap;gap:4px;max-width:260px}
.emojiPicker button{background:transparent;border:0;color:var(--text);font-size:22px;width:36px;height:36px;border-radius:6px;cursor:pointer}
.emojiPicker button:hover{background:#2a3942}

.side{padding:14px;overflow:auto;height:calc(100vh - 64px)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:14px}
.card h3{margin:0 0 6px 0;font-size:14px}
.row{display:flex;gap:8px;align-items:center;margin-top:8px}
.row input{min-width:0;flex:1;background:#2a3942;color:var(--text);border:0;border-radius:8px;padding:10px}
.btn{background:#2a3942;color:var(--text);border:0;border-radius:8px;padding:10px 12px;cursor:pointer}
.btn.primary{background:var(--green);color:#041410;font-weight:800}
.btn:disabled{opacity:.5;cursor:not-allowed}
.pill{display:inline-flex;gap:6px;background:var(--panel2);padding:7px 9px;border-radius:999px;margin:4px;font-size:13px;cursor:pointer}
.tagPill{display:inline-block;background:#2a3942;padding:4px 10px;border-radius:999px;margin:3px;font-size:12px}
.legend{display:grid;gap:8px}
.legend div{display:flex;align-items:center;gap:8px}
.sw{width:16px;height:16px;border-radius:4px}
.saveStatus{font-size:12px;margin-left:8px;color:var(--muted)}
.saveStatus.ok{color:var(--green)}
.saveStatus.err{color:#ff6b6b}

.modalBg{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:50}
.modalBg.open{display:flex}
.modal{width:min(520px,92vw);max-height:84vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px}
.toggle{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}
.detailRow{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);align-items:flex-start}
.detailRow:last-child{border-bottom:0}
.detailRow .k{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px;flex:0 0 130px}
.detailRow .v{flex:1;word-break:break-word;text-align:right}
.detailHero{display:flex;align-items:center;gap:14px;margin-bottom:10px}
.detailHero .avatar{width:56px;height:56px;font-size:22px}
.notice{background:rgba(245,197,66,.12);border:1px solid rgba(245,197,66,.4);color:#f5c542;border-radius:8px;padding:8px 10px;font-size:12px;margin:8px 0}

@media(max-width:900px){.app{grid-template-columns:1fr}.right{display:none}.left{display:none}.msg{max-width:88%}}
</style>
</head>
<body>
<div class="app">
  <aside class="left">
    <div class="bar">
      <div class="avatar">M</div>
      <div><div class="brand">MURTAZA</div><div class="sub">WhatsApp Operatör</div></div>
      <div class="spacer"></div>
      <button class="icon" id="settingsBtn" title="Ayarlar">⚙</button>
    </div>
    <div class="search"><input id="search" placeholder="Ara veya yeni sohbet başlat" /></div>
    <div id="conversations"></div>
  </aside>

  <main class="chat">
    <div class="bar chatHead linkish" id="chatHead" title="Kişi detaylarını aç">
      <div class="avatar" id="chatAvatar">?</div>
      <div class="ttl">
        <div class="brand" id="chatTitle">Konuşma seç</div>
        <div class="sub" id="chatSub"><span class="statusDot"></span> bağlı · manuel/bot ayrımı aktif</div>
      </div>
      <div class="spacer"></div>
      <button class="icon" id="detailBtn" title="Kişi detayı">ℹ</button>
      <button class="icon" id="notifyBtn" title="Bildirimleri aç">🔔</button>
    </div>

    <div class="messages" id="messages"></div>

    <div class="composerWrap">
      <div class="quickRow" id="quickReplies"></div>
      <div class="attachName" id="attachName"></div>
      <form class="composer" id="sendForm">
        <button type="button" class="icon" id="emojiBtn" title="Emoji ekle">😊</button>
        <button type="button" class="icon" id="attachBtn" title="Görsel/dosya ekle">📎</button>
        <input id="fileInput" type="file" accept="image/png,image/jpeg,image/webp,application/pdf,text/plain,.txt,.csv,.doc,.docx,.xls,.xlsx" hidden />
        <textarea id="messageText" rows="1" placeholder="Mesaj yazın"></textarea>
        <button class="send" type="submit">Gönder</button>
      </form>
      <div class="emojiPicker" id="emojiPicker"></div>
    </div>
  </main>

  <section class="right">
    <div class="bar"><div><div class="brand">Kontrol Merkezi</div><div class="sub">ayarlar · listeler · modlar</div></div></div>
    <div class="side">
      <div class="card">
        <h3>Seçili konuşma</h3>
        <div class="sub" id="convSettingsStatus">Konuşma seçilmedi</div>
        <div id="convSummary" style="margin:8px 0;font-size:13px"></div>
        <label class="toggle" style="padding:8px 0">
          <span>Bot bu konuşmada açık</span>
          <input id="convBotEnabled" type="checkbox" checked />
        </label>
        <input id="convTags" placeholder="Etiketler: sıcak lead, web" style="width:100%;margin:6px 0;background:#2a3942;color:var(--text);border:0;border-radius:8px;padding:10px" />
        <textarea id="convNote" rows="3" placeholder="Operatör notu" style="width:100%;resize:vertical;background:#2a3942;color:var(--text);border:0;border-radius:8px;padding:10px"></textarea>
        <div style="display:flex;align-items:center;margin-top:8px">
          <button id="saveConvSettings" class="btn primary">Konuşma ayarını kaydet</button>
          <span class="saveStatus" id="convSaveStatus"></span>
        </div>
      </div>

      <div class="card">
        <h3>Otomatik cevap kapsamı</h3>
        <div class="row">
          <select id="audienceSelect" style="flex:1;background:#2a3942;color:var(--text);border:0;border-radius:8px;padding:10px">
            <option value="whitelist">Sadece whitelist</option>
            <option value="all">Herkes yazabilsin</option>
          </select>
          <button id="saveAudience" class="btn primary">Kaydet</button>
        </div>
        <p class="sub">Herkes seçilirse bot whitelist kontrolü yapmadan cevap verir.</p>
      </div>

      <div class="card">
        <h3>Whitelist / izinli numaralar</h3>
        <div id="whitelist"></div>
        <div class="row"><input id="phoneInput" placeholder="905..." /><button id="addPhone" class="btn primary">Ekle</button></div>
      </div>

      <div class="card">
        <h3>Geçmiş durumu</h3>
        <p class="sub">Bu bölüm gerçek bir “eski mesajları çek” butonu değildir. WhatsApp Web/Baileys mevcut bağlı cihazda geçmişi zorla vermez; sadece yeni mesajlar ve nadiren ilk eşleşme history event'i kayda düşer.</p>
        <div style="height:10px;background:#2a3942;border-radius:99px;overflow:hidden;margin:10px 0"><div id="historyBar" style="height:100%;width:0;background:var(--green)"></div></div>
        <div class="sub" id="historyStatus">Hazır</div>
        <button id="startHistory" class="btn primary" style="margin-top:8px">Pasif history dinlemeyi aç</button>
      </div>

      <div class="card">
        <h3>Renk rehberi</h3>
        <div class="legend">
          <div><span class="sw" style="background:var(--in)"></span>Müşteri mesajı</div>
          <div><span class="sw" style="background:var(--manual)"></span>Senin manuel cevabın</div>
          <div><span class="sw" style="background:var(--bot)"></span>Bot otomatik cevabı</div>
          <div><span class="sw" style="background:var(--warn)"></span>Görsel/ek bilgisi</div>
        </div>
      </div>
    </div>
  </section>
</div>

<div class="modalBg" id="settingsModal">
  <div class="modal">
    <div class="bar" style="margin:-18px -18px 12px -18px;border-radius:16px 16px 0 0">
      <b>Ayarlar</b><div class="spacer"></div><button class="icon" id="closeSettings">×</button>
    </div>
    <div class="toggle"><div><b>Tarayıcı bildirimi</b><div class="sub">Yeni gelen mesajlarda Chrome/macOS bildirimi</div></div><button class="btn primary" id="enableNotifications">Aç</button></div>
    <div class="toggle"><div><b>Otomatik yenileme</b><div class="sub">Konuşma ve mesajları 3 sn'de bir günceller</div></div><span>Aktif</span></div>
    <div class="toggle"><div><b>Görsel ekleme</b><div class="sub">PNG/JPEG/WebP dosyası seçip WhatsApp'a gönderebilirsin</div></div><span>Aktif</span></div>
  </div>
</div>

<div class="modalBg" id="detailModal">
  <div class="modal">
    <div class="bar" style="margin:-18px -18px 12px -18px;border-radius:16px 16px 0 0">
      <b>Kişi detayı</b><div class="spacer"></div><button class="icon" id="closeDetail">×</button>
    </div>
    <div class="detailHero"><div class="avatar" id="detailAvatar">?</div><div><div class="brand" id="detailName">—</div><div class="sub" id="detailPhone">—</div></div></div>
    <div class="notice">LID ve telefon JID kayıtları aynı kişi adıyla eşleşirse bu panelde tek konuşma olarak birleştirilir. Aşağıda en güncel chat kimliği gösterilir.</div>
    <div class="detailRow"><div class="k">Chat ID</div><div class="v" id="detailChatId">—</div></div>
    <div class="detailRow"><div class="k">Son mesaj</div><div class="v" id="detailLatest">—</div></div>
    <div class="detailRow"><div class="k">Son zaman</div><div class="v" id="detailLatestAt">—</div></div>
    <div class="detailRow"><div class="k">Okunmamış</div><div class="v" id="detailUnread">0</div></div>
    <div class="detailRow"><div class="k">Bot durumu</div><div class="v" id="detailBot">—</div></div>
    <div class="detailRow"><div class="k">Etiketler</div><div class="v" id="detailTags">—</div></div>
    <div class="detailRow"><div class="k">Not</div><div class="v" id="detailNote">—</div></div>
  </div>
</div>

<script>
(function(){
  var selectedChatId = null;
  var selectedConversation = null;
  var lastSeenLatestAt = {};
  var attachedData = null, attachedName = '', attachedKind = null;

  var QUICK_REPLIES = [
    { label: 'Selamlama', text: 'Merhaba 👋 Ben MURTAZA. Size nasıl yardımcı olabilirim?' },
    { label: 'Fiyat/teklif', text: 'Detaylı fiyat teklifi için ihtiyacınızı kısa bir açıklamayla iletir misiniz?' },
    { label: 'Destek', text: 'Yaşadığınız konuyu kısaca yazarsanız hemen ekibimize ileteyim.' },
    { label: 'Mesai dışı', text: 'Şu anda mesai saatleri dışındayız. Mesajınızı aldım, en kısa sürede dönüş yapacağım.' }
  ];
  var EMOJIS = ['👍','🙏','😊','😂','❤️','🔥','✅','📞','👋','🤝','📎','🎉','💬','⏰','📷','📍'];

  function $(id){ return document.getElementById(id); }
  function fmtDateTime(v){ try { return new Date(v).toLocaleString('tr-TR'); } catch(e){ return ''; } }
  function fmtTime(v){ try { return new Date(v).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}); } catch(e){ return ''; } }
  function initials(name){ return (name||'?').trim().slice(0,1).toUpperCase(); }

  function getToken(){
    if (${noAuth ? 'true' : 'false'}) return '';
    var u = new URL(window.location.href);
    var fromUrl = u.searchParams.get('token');
    if (fromUrl) {
      sessionStorage.setItem('operatorToken', fromUrl);
      u.searchParams.delete('token');
      window.history.replaceState({}, '', u.pathname + (u.search || '') + u.hash);
      return fromUrl;
    }
    var cached = sessionStorage.getItem('operatorToken');
    if (cached) return cached;
    var entered = window.prompt('Operatör token (data/operator-token.txt veya BOT_OPERATOR_TOKEN):');
    if (entered) { sessionStorage.setItem('operatorToken', entered); return entered; }
    return '';
  }

  async function api(path, options){
    options = options || {};
    var headers = new Headers(options.headers || {});
    var token = sessionStorage.getItem('operatorToken') || getToken();
    if (token) headers.set('Authorization', 'Bearer ' + token);
    options.headers = headers;
    var r = await fetch(path, options);
    if (r.status === 401) {
      sessionStorage.removeItem('operatorToken');
      throw new Error('unauthorized — token hatalı, sayfayı yenile ve tekrar gir');
    }
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  function setSaveStatus(el, kind, text){
    el.className = 'saveStatus' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
    if (kind === 'ok') setTimeout(function(){ if (el.textContent === text) { el.textContent=''; el.className='saveStatus'; } }, 2200);
  }

  async function loadConversations(){
    var data = await api('/api/conversations');
    var conversations = data.conversations || [];
    var q = $('search').value.toLowerCase();
    var root = $('conversations');
    root.innerHTML = '';
    for (var i=0; i<conversations.length; i++) {
      var c = conversations[i];
      var blob = ((c.displayName||'') + (c.phone||'') + (c.latestText||'')).toLowerCase();
      if (q && blob.indexOf(q) === -1) continue;

      if (lastSeenLatestAt[c.chatId] && lastSeenLatestAt[c.chatId] !== c.latestAt && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('Yeni WhatsApp mesajı', { body: (c.displayName||c.phone) + ': ' + (c.latestText||'') }); } catch(e){}
      }
      lastSeenLatestAt[c.chatId] = c.latestAt;

      if (c.chatId === selectedChatId) selectedConversation = c;

      var el = document.createElement('div');
      el.className = 'conv' + (c.chatId === selectedChatId ? ' active' : '');
      el.innerHTML = '<div class="avatar"></div><div class="meta"><div class="name"></div><div class="last"></div></div><div style="text-align:right"><div class="time"></div><div class="badgeWrap"></div></div>';
      el.querySelector('.avatar').textContent = initials(c.displayName || c.phone);
      el.querySelector('.name').textContent = c.displayName || c.phone;
      el.querySelector('.last').textContent = c.latestText || '';
      el.querySelector('.time').textContent = fmtTime(c.latestAt);
      if (c.unreadCount && c.unreadCount > 0) {
        var b = document.createElement('span');
        b.className = 'badge';
        b.textContent = String(c.unreadCount);
        el.querySelector('.badgeWrap').appendChild(b);
      }
      (function(conv){
        el.onclick = function(){
          selectedChatId = conv.chatId;
          selectedConversation = conv;
          $('chatTitle').textContent = conv.displayName || conv.phone;
          $('chatAvatar').textContent = initials(conv.displayName || conv.phone);
          $('chatSub').innerHTML = '<span class="statusDot"></span> ' + (conv.phone || conv.chatId);
          loadMessages(true);
          loadConversationSettings();
          loadConversations();
        };
      })(c);
      root.appendChild(el);
    }
  }

  async function loadConversationSettings(){
    if (!selectedChatId) {
      $('convSettingsStatus').textContent = 'Konuşma seçilmedi';
      $('convSummary').textContent = '';
      return;
    }
    var data = await api('/api/conversation-settings?chatId=' + encodeURIComponent(selectedChatId));
    var settings = data.settings || { botEnabled: true, tags: [] };
    $('convBotEnabled').checked = settings.botEnabled !== false;
    $('convTags').value = (settings.tags || []).join(', ');
    $('convNote').value = settings.note || '';
    var tagText = (settings.tags || []).join(', ') || 'etiket yok';
    $('convSettingsStatus').textContent = (settings.botEnabled === false ? 'Bot kapalı' : 'Bot açık') + ' · ' + tagText;
    if (selectedConversation) {
      $('convSummary').innerHTML = '';
      var name = document.createElement('div'); name.style.fontWeight='700'; name.textContent = selectedConversation.displayName || selectedConversation.phone;
      var phone = document.createElement('div'); phone.className='sub'; phone.textContent = selectedConversation.phone || selectedConversation.chatId;
      $('convSummary').appendChild(name); $('convSummary').appendChild(phone);
    }
  }

  async function loadMessages(forceBottom){
    if (!selectedChatId) return;
    var data = await api('/api/messages?chatId=' + encodeURIComponent(selectedChatId));
    var messages = data.messages || [];
    var root = $('messages');
    var prevTop = root.scrollTop;
    var nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 90;
    root.innerHTML = '';
    for (var i=0; i<messages.length; i++) {
      var m = messages[i];
      var origin = m.direction === 'outbound' ? (m.origin || 'manual') : '';
      var el = document.createElement('div');
      el.className = 'msg ' + m.direction + ' ' + origin;
      var label = m.direction === 'inbound' ? 'Müşteri' : (origin === 'bot' ? 'MURTAZA Bot' : origin === 'self' ? 'Sen (telefon)' : 'Sen / Operatör');

      var labelEl = document.createElement('span'); labelEl.className='label'; labelEl.textContent = label;
      el.appendChild(labelEl);

      if (m.mediaKind) {
        var icon = m.mediaKind === 'image' ? '🖼' : '📎';
        if (m.mediaData) {
          var a = document.createElement('a');
          a.className = 'mediaBadge';
          a.href = m.mediaData;
          a.download = m.mediaName || 'dosya';
          a.target = '_blank';
          a.textContent = icon + ' ' + (m.mediaName || m.mediaKind) + ' · aç/indir';
          el.appendChild(a);
          el.appendChild(document.createElement('br'));
        } else {
          var b = document.createElement('span');
          b.className = 'mediaBadge';
          b.textContent = icon + ' ' + (m.mediaName || m.mediaKind);
          el.appendChild(b);
          el.appendChild(document.createElement('br'));
        }
      }

      var body = document.createElement('span'); body.className='body'; body.textContent = m.text || '';
      el.appendChild(body);

      var when = m.receivedAt || m.sentAt;
      if (when) {
        var t = document.createElement('span'); t.className='time'; t.textContent = fmtTime(when);
        el.appendChild(t);
      }
      root.appendChild(el);
    }
    if (forceBottom || nearBottom) root.scrollTop = root.scrollHeight;
    else root.scrollTop = prevTop;
  }

  async function loadWhitelist(){
    var data = await api('/api/whitelist');
    var root = $('whitelist');
    root.innerHTML = '';
    (data.phones || []).forEach(function(p){
      var el = document.createElement('span');
      el.className = 'pill';
      el.textContent = p + ' ×';
      el.onclick = async function(){
        await api('/api/whitelist/' + encodeURIComponent(p), { method: 'DELETE' });
        loadWhitelist();
      };
      root.appendChild(el);
    });
  }

  function fileToDataUrl(file){
    return new Promise(function(resolve, reject){
      var r = new FileReader();
      r.onload = function(){ resolve(String(r.result)); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function insertAtCursor(textarea, value){
    var start = textarea.selectionStart || 0;
    var end = textarea.selectionEnd || 0;
    var before = textarea.value.slice(0, start);
    var after = textarea.value.slice(end);
    textarea.value = before + value + after;
    var pos = start + value.length;
    textarea.focus();
    try { textarea.setSelectionRange(pos, pos); } catch(e){}
  }

  function buildQuickReplies(){
    var root = $('quickReplies');
    root.innerHTML = '';
    QUICK_REPLIES.forEach(function(q){
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = q.label;
      b.title = q.text;
      b.onclick = function(){
        var ta = $('messageText');
        if (ta.value.trim().length > 0 && !confirm('Mevcut metnin üzerine yazılsın mı?')) return;
        ta.value = q.text;
        ta.focus();
      };
      root.appendChild(b);
    });
  }

  function buildEmojiPicker(){
    var root = $('emojiPicker');
    root.innerHTML = '';
    EMOJIS.forEach(function(e){
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.onclick = function(){
        insertAtCursor($('messageText'), e);
      };
      root.appendChild(b);
    });
  }

  function openDetail(){
    if (!selectedChatId || !selectedConversation) {
      alert('Önce bir konuşma seç.');
      return;
    }
    var c = selectedConversation;
    $('detailAvatar').textContent = initials(c.displayName || c.phone);
    $('detailName').textContent = c.displayName || c.phone || '—';
    $('detailPhone').textContent = c.phone || '—';
    $('detailChatId').textContent = c.chatId || '—';
    $('detailLatest').textContent = c.latestText || '—';
    $('detailLatestAt').textContent = c.latestAt ? fmtDateTime(c.latestAt) : '—';
    $('detailUnread').textContent = String(c.unreadCount || 0);
    var s = c.settings || { botEnabled: true, tags: [] };
    $('detailBot').textContent = s.botEnabled === false ? 'Kapalı' : 'Açık';
    var tagsRoot = $('detailTags');
    tagsRoot.innerHTML = '';
    if (s.tags && s.tags.length) {
      s.tags.forEach(function(t){
        var sp = document.createElement('span'); sp.className='tagPill'; sp.textContent = t; tagsRoot.appendChild(sp);
      });
    } else {
      tagsRoot.textContent = '—';
    }
    $('detailNote').textContent = s.note || '—';
    $('detailModal').classList.add('open');
  }

  // Wire-up
  $('sendForm').onsubmit = async function(e){
    e.preventDefault();
    if (!selectedChatId) { alert('Önce konuşma seç'); return; }
    var text = $('messageText').value.trim();
    if (!text && !attachedData) { alert('Mesaj veya dosya ekle'); return; }
    var body = { chatId: selectedChatId, text: text };
    if (attachedKind === 'image') { body.imageData = attachedData; body.imageName = attachedName; }
    else if (attachedKind === 'document') { body.documentData = attachedData; body.documentName = attachedName; }
    try {
      await api('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (err) {
      alert('Gönderim hatası: ' + err.message);
      return;
    }
    $('messageText').value = '';
    attachedData = null; attachedName = ''; attachedKind = null;
    $('attachName').textContent = '';
    await loadMessages(true);
    await loadConversations();
  };

  $('attachBtn').onclick = function(){ $('fileInput').click(); };
  $('fileInput').onchange = async function(e){
    var file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { alert('Max 10 MB'); return; }
    attachedData = await fileToDataUrl(file);
    attachedName = file.name;
    attachedKind = file.type.indexOf('image/') === 0 ? 'image' : 'document';
    $('attachName').textContent = 'Ekli ' + (attachedKind === 'image' ? 'görsel' : 'dosya') + ': ' + file.name;
  };

  $('emojiBtn').onclick = function(){ $('emojiPicker').classList.toggle('open'); };
  document.addEventListener('click', function(ev){
    var picker = $('emojiPicker');
    if (!picker.classList.contains('open')) return;
    if (ev.target === $('emojiBtn') || picker.contains(ev.target)) return;
    picker.classList.remove('open');
  });

  $('addPhone').onclick = async function(){
    var phone = $('phoneInput').value.trim();
    if (!phone) return;
    await api('/api/whitelist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: phone }) });
    $('phoneInput').value = '';
    loadWhitelist();
  };

  $('saveAudience').onclick = async function(){
    var autoReplyAudience = $('audienceSelect').value;
    await api('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autoReplyAudience: autoReplyAudience }) });
    alert('Kaydedildi: ' + autoReplyAudience);
  };

  $('saveConvSettings').onclick = async function(){
    if (!selectedChatId) { alert('Önce konuşma seç'); return; }
    var tags = $('convTags').value.split(',').map(function(x){ return x.trim(); }).filter(Boolean);
    var note = $('convNote').value;
    var botEnabled = $('convBotEnabled').checked;
    var status = $('convSaveStatus');
    setSaveStatus(status, '', 'Kaydediliyor…');
    try {
      await api('/api/conversation-settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: selectedChatId, botEnabled: botEnabled, tags: tags, note: note }) });
      setSaveStatus(status, 'ok', 'Kaydedildi');
    } catch (err) {
      setSaveStatus(status, 'err', 'Hata: ' + err.message);
    }
    await loadConversationSettings();
    await loadConversations();
  };

  async function loadSettings(){
    var s = await api('/api/settings');
    $('audienceSelect').value = s.autoReplyAudience || 'whitelist';
  }
  async function loadHistoryStatus(){
    var s = await api('/api/history-import');
    $('historyBar').style.width = (s.progress || 0) + '%';
    $('historyStatus').textContent = (s.status || 'idle') + ' · ' + (s.progress || 0) + '% · ' + (s.imported || 0) + ' kayıt · ' + (s.note || '');
    var btn = $('startHistory');
    if (s.status === 'completed') { btn.disabled = true; btn.textContent = 'Pasif event tamamlandı'; }
    else if (s.status === 'listening') { btn.disabled = true; btn.textContent = 'Pasif dinleme açık (beklemede)'; }
  }
  $('startHistory').onclick = async function(){
    try { await api('/api/history-import/start', { method: 'POST' }); await loadHistoryStatus(); }
    catch(e){ alert('Geçmiş dinleme başlatılamadı: ' + e.message); await loadHistoryStatus(); }
  };

  $('settingsBtn').onclick = function(){ $('settingsModal').classList.add('open'); };
  $('closeSettings').onclick = function(){ $('settingsModal').classList.remove('open'); };
  $('chatHead').onclick = function(ev){
    if (ev.target.closest('#notifyBtn')) return;
    openDetail();
  };
  $('detailBtn').onclick = function(ev){ ev.stopPropagation(); openDetail(); };
  $('closeDetail').onclick = function(){ $('detailModal').classList.remove('open'); };

  document.querySelectorAll('.modalBg').forEach(function(bg){
    bg.addEventListener('click', function(ev){ if (ev.target === bg) bg.classList.remove('open'); });
  });

  $('notifyBtn').onclick = $('enableNotifications').onclick = async function(){
    if (!('Notification' in window)) { alert('Tarayıcı bildirimi desteklemiyor'); return; }
    var p = await Notification.requestPermission();
    alert('Bildirim izni: ' + p);
  };
  $('search').oninput = loadConversations;

  buildQuickReplies();
  buildEmojiPicker();
  loadConversations();
  loadWhitelist();
  loadSettings();
  loadHistoryStatus();
  setInterval(function(){ loadConversations(); loadMessages(); loadHistoryStatus(); }, 3000);
})();
</script>
</body>
</html>`;
}
