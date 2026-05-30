import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import type { MediaKind } from '../types.js';
import type { MessageStore } from '../store/sqlite-message-store.js';

// Drive script JSON çıktısı (wa_drive_upload.py). status alanına göre dallanır.
export interface DriveResult {
  status: string;
  drive_id?: string;
  link?: string;
  folder_id?: string;
  root_id?: string;
  path?: string;
  name?: string;
  mime?: string;
  error?: string;
}

export interface DrivePythonRunner {
  upload(slug: string, kind: MediaKind, file: string, name?: string): Promise<DriveResult>;
  uploadInbox(sender: string, kind: MediaKind, file: string, name?: string): Promise<DriveResult>;
  download(driveId: string, outPath: string): Promise<DriveResult>;
  resolve(slug: string): Promise<DriveResult>;
}

export interface DrivePythonRunnerConfig {
  python: string;
  script: string;
  tokenPath: string;
  customersDir: string;
  timeoutMs?: number;
}

export interface IncomingMediaInfo {
  chatId: string;
  messageId: string;
  mediaKind: MediaKind;
  mediaMime?: string;
  mediaName?: string;
  localPath: string;
}

export interface MediaArchiverDeps {
  store: MessageStore;
  tenantId: string;
  runner: DrivePythonRunner;
  logger?: { info?: (msg: string) => void; error?: (msg: string) => void };
}

export interface MediaArchiver {
  onIncomingMedia(info: IncomingMediaInfo): Promise<void>;
  onCustomerAssigned(chatId: string, slug: string): Promise<void>;
  // Restart recovery: bekleyen/başarısız tüm medyayı (firma vs inbox kararıyla) yeniden kuyruğa al.
  requeuePending(): Promise<void>;
  downloadDriveFile(driveId: string, outPath: string): Promise<DriveResult>;
}

// Python script'i subprocess olarak çağırır; stdout'un SON satırını JSON parse eder.
// (Script garanti tek satır JSON basar; yine de defansif olarak son dolu satırı alırız.)
export function createDrivePythonRunner(config: DrivePythonRunnerConfig): DrivePythonRunner {
  const env = {
    ...process.env,
    BOT_DRIVE_TOKEN_PATH: config.tokenPath,
    BOT_CUSTOMERS_DIR: config.customersDir
  };
  const timeout = config.timeoutMs ?? 120000;

  function run(args: string[]): Promise<DriveResult> {
    return new Promise((resolve) => {
      execFile(config.python, [config.script, ...args], { env, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        const parsed = parseLastJsonLine(stdout);
        if (parsed) {
          resolve(parsed);
          return;
        }
        resolve({ status: 'error', error: error ? (error.message || 'exec_failed') : 'no_json_output' });
      });
    });
  }

  return {
    upload(slug, kind, file, name) {
      const args = ['upload', '--slug', slug, '--kind', kind, '--file', file];
      if (name) args.push('--name', name);
      return run(args);
    },
    uploadInbox(sender, kind, file, name) {
      const args = ['upload-inbox', '--sender', sender, '--kind', kind, '--file', file];
      if (name) args.push('--name', name);
      return run(args);
    },
    download(driveId, outPath) {
      return run(['download', '--id', driveId, '--out', outPath]);
    },
    resolve(slug) {
      return run(['resolve', '--slug', slug]);
    }
  };
}

function parseLastJsonLine(stdout: string): DriveResult | undefined {
  const lines = (stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as DriveResult;
    } catch {
      // sonraki satırı dene
    }
  }
  return undefined;
}

// Gelen medya arşivleyici: seri kuyruk. Aynı anda tek upload çalışır,
// böylece Drive subprocess'leri ve quota'yı kontrol altında tutarız.
export function createMediaArchiver(deps: MediaArchiverDeps): MediaArchiver {
  const { store, tenantId, runner, logger } = deps;
  let queue: Promise<void> = Promise.resolve();

  function enqueue(task: () => Promise<void>): Promise<void> {
    queue = queue.then(task, task);
    return queue;
  }

  // Tek upload'ı yürütür: status'u 'uploading' yapar, verilen Drive çağrısını çalıştırır,
  // sonuca göre done (+yerel temizlik) ya da error işaretler. Hedef (firma vs inbox)
  // call closure'ında kapsüllenir; bu fonksiyon hedeften bağımsızdır.
  // Tüm gövde try-catch ile sarılı: beklenmeyen throw (better-sqlite3 sync hatası vb.)
  // kuyruğu kirletmesin, kayıt en kötü 'error'da kalsın.
  async function runUpload(messageId: string, localPath: string, label: string, call: () => Promise<DriveResult>): Promise<void> {
    try {
      await store.setMediaUploadStatus(tenantId, messageId, 'uploading');
      const result = await call();
      if ((result.status === 'uploaded' || result.status === 'skip') && result.drive_id) {
        await store.markMediaDone(tenantId, messageId, result.drive_id, result.link ?? '');
        try {
          await rm(localPath, { force: true });
        } catch {
          // yerel temizlik başarısızsa kritik değil (status zaten done)
        }
        logger?.info?.(`Medya Drive'a yüklendi (${label}): msg=${messageId} status=${result.status} drive=${result.drive_id}`);
      } else {
        await store.setMediaUploadStatus(tenantId, messageId, 'error');
        logger?.error?.(`Medya upload hatası (${label}): msg=${messageId} ${result.error ?? result.status}`);
      }
    } catch (error) {
      logger?.error?.(`Medya upload beklenmeyen hata (${label}): msg=${messageId} ${error instanceof Error ? error.message : String(error)}`);
      try { await store.setMediaUploadStatus(tenantId, messageId, 'error'); } catch { /* status yazımı da başarısızsa yapacak bir şey yok */ }
    }
  }

  // Firma atanmışsa firmanın Drive'ına, değilse kullanıcının kendi Drive'ında
  // MURTAZA/WhatsApp/Gelen-Kutusu/<gönderen>/ fallback'ine yönlendirir. onIncomingMedia
  // ve requeuePending ortak kullanır (tek karar noktası).
  async function dispatchUpload(messageId: string, chatId: string, kind: MediaKind, localPath: string, name?: string): Promise<void> {
    const settings = await store.getConversationSettings(tenantId, chatId);
    const slug = settings.customerSlug;
    if (slug) {
      await enqueue(() => runUpload(messageId, localPath, `firma:${slug}`,
        () => runner.upload(slug, kind, localPath, name)));
    } else {
      const sender = senderFromChatId(chatId);
      await enqueue(() => runUpload(messageId, localPath, `inbox:${sender}`,
        () => runner.uploadInbox(sender, kind, localPath, name)));
    }
  }

  return {
    async onIncomingMedia(info: IncomingMediaInfo): Promise<void> {
      await store.markMediaPending(tenantId, info.messageId, info.localPath);
      await dispatchUpload(info.messageId, info.chatId, info.mediaKind, info.localPath, info.mediaName);
    },

    async onCustomerAssigned(chatId: string, slug: string): Promise<void> {
      const normalized = (slug || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!normalized) return;
      const pending = await store.listPendingMediaByChat(tenantId, chatId);
      for (const item of pending) {
        if (!item.localPath || !item.mediaKind) continue;
        const kind = item.mediaKind;
        await enqueue(() => runUpload(item.messageId, item.localPath, `firma:${normalized}`,
          () => runner.upload(normalized, kind, item.localPath, item.mediaName)));
      }
    },

    async requeuePending(): Promise<void> {
      const items = await store.listAllPendingMedia(tenantId);
      for (const item of items) {
        if (!item.localPath || !item.mediaKind) continue;
        await dispatchUpload(item.messageId, item.chatId, item.mediaKind, item.localPath, item.mediaName);
      }
    },

    downloadDriveFile(driveId: string, outPath: string): Promise<DriveResult> {
      return runner.download(driveId, outPath);
    }
  };
}

// WhatsApp JID'inden inbox klasör adı için gönderen kimliğini çıkarır.
// '<numara>@s.whatsapp.net', '<numara>:<device>@s.whatsapp.net', '<lid>@lid' → '@' öncesi,
// ':' device eki atılır, rakam-dışı temizlenir. Saf @lid (rakamsız) ise sanitize edilmiş yerel kısım.
// Gruplar '<id>@g.us' → 'grup-<id>' ile prefixlenir; grup ve bireysel klasörleri çakışmaz.
export function senderFromChatId(chatId: string): string {
  const isGroup = (chatId ?? '').endsWith('@g.us');
  const local = (chatId.split('@')[0] ?? '').split(':')[0] ?? '';
  const digits = local.replace(/[^0-9]/g, '');
  const base = digits || local.replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40) || 'bilinmeyen';
  return isGroup ? `grup-${base}` : base;
}
