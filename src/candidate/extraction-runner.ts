import { execFile } from 'node:child_process';
import type { CandidateTask } from '../types.js';

// wa-extract.py STDOUT sözleşmesi (son JSON satırı):
//   {"ok": true, "summary": "...", "tasks": [{title,description,priority,suggested_due,source_message_ids}], "error": null}
//   veya {"ok": false, "summary": null, "tasks": [], "error": "<sebep>"}
export interface ExtractionResult {
  ok: boolean;
  summary?: string;
  tasks?: CandidateTask[];
  error?: string;
}

export interface ExtractionRunnerConfig {
  python: string;
  scriptPath: string;
  dbPath: string;
  timeoutMs?: number;
}

export interface ExtractionRunner {
  // Bir WhatsApp grubunu wa-extract.py ile özetler + görev adaylarını çıkarır.
  // Hata durumunda ASLA throw etmez; { ok:false, error } döner (bot çökmesin).
  extractGroup(chatId: string): Promise<ExtractionResult>;
}

function errorResult(message: string): ExtractionResult {
  return { ok: false, error: message };
}

// wa-extract.py'nin snake_case JSON çıktısını CandidateTask (camelCase) şekline çevirir.
// Defansif: alanlar eksik/yanlış tipte olabilir; güvenli default'lara düşülür.
function toCandidateTask(raw: unknown): CandidateTask {
  const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const priorityRaw = Number(obj.priority);
  const priority = Number.isInteger(priorityRaw) && priorityRaw >= 1 && priorityRaw <= 4 ? priorityRaw : 2;
  const sourceIds = Array.isArray(obj.source_message_ids)
    ? obj.source_message_ids.map((v) => String(v)).filter(Boolean)
    : [];
  const suggestedDue = typeof obj.suggested_due === 'string' && obj.suggested_due.trim()
    ? obj.suggested_due.trim()
    : undefined;
  return {
    title: typeof obj.title === 'string' ? obj.title : '',
    description: typeof obj.description === 'string' ? obj.description : '',
    priority,
    ...(suggestedDue ? { suggestedDue } : {}),
    sourceMessageIds: sourceIds
  };
}

function normalizeResult(parsed: Record<string, unknown>): ExtractionResult {
  if (parsed.ok === true) {
    return {
      ok: true,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map(toCandidateTask) : []
    };
  }
  return errorResult(typeof parsed.error === 'string' && parsed.error ? parsed.error : 'extraction_failed');
}

// stdout'un SON dolu JSON satırını parse eder. Script garanti tek satır JSON basar;
// yine de defansif olarak (uyarı/log satırı önde olabilir) son '{' başlangıçlı satırı alırız.
function parseLastJsonLine(stdout: string): Record<string, unknown> | undefined {
  const lines = (stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // sonraki (daha üstteki) satırı dene
    }
  }
  return undefined;
}

// wa-extract.py'yi subprocess olarak çağırır; stdout'un son JSON satırını ExtractionResult'a parse eder.
// (perfex-reader.ts'teki execFile→son-JSON-satırı parse kalıbıyla aynı; ASLA throw etmez.)
export function createExtractionRunner(config: ExtractionRunnerConfig): ExtractionRunner {
  const timeout = config.timeoutMs ?? 120000;

  return {
    extractGroup(chatId: string): Promise<ExtractionResult> {
      if (!chatId) {
        return Promise.resolve(errorResult('chatId gerekli'));
      }

      const args = [config.scriptPath, '--db', config.dbPath, '--chat-id', chatId];

      return new Promise((resolve) => {
        execFile(
          config.python,
          args,
          { timeout, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout) => {
            const parsed = parseLastJsonLine(stdout);
            if (parsed) {
              resolve(normalizeResult(parsed));
              return;
            }
            resolve(errorResult(error ? error.message || 'exec_failed' : 'no_json_output'));
          }
        );
      });
    }
  };
}
