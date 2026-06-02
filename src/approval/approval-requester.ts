import { spawn } from 'node:child_process';

// request_approval.py --from-stdin STDOUT sözleşmesi (son JSON satırı):
//   {"ok": true, "job_id": "...", "telegram": {"sent": true, ...}}
//   veya {"ok": false, "error": "<sebep>"}
// Payload PII içerebileceği için args'ta DEĞİL, STDIN'den (JSON) geçer.
export interface ApprovalPayload {
  kind: string;
  title: string;
  body?: string;
  on_approve: Record<string, unknown>;
  customer_slug?: string;
}

export interface ApprovalResult {
  ok: boolean;
  jobId?: string;
  telegramSent?: boolean;
  error?: string;
}

export interface ApprovalRequester {
  // Onay isteğini request_approval.py'ye STDIN üzerinden iletir (PII args'ta sızmaz).
  // Hata/timeout durumunda ASLA throw etmez; { ok:false, error } döner (bot çökmesin).
  requestApproval(payload: ApprovalPayload): Promise<ApprovalResult>;
}

export interface ApprovalRequesterConfig {
  python: string;
  scriptPath: string;
  timeoutMs?: number;
}

function errorResult(message: string): ApprovalResult {
  return { ok: false, error: message };
}

// stdout'un SON dolu JSON satırını parse eder. Script garanti tek satır JSON basar;
// yine de defansif olarak (uyarı/log satırı önde olabilir) son '{' başlangıçlı satırı alırız.
// (perfex-reader.ts / extraction-runner.ts ile aynı kalıp.)
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

// request_approval.py'nin snake_case JSON çıktısını ApprovalResult (camelCase) şekline çevirir.
function normalizeResult(parsed: Record<string, unknown>): ApprovalResult {
  if (parsed.ok === true) {
    const jobId = typeof parsed.job_id === 'string' ? parsed.job_id : undefined;
    const telegram = (parsed.telegram && typeof parsed.telegram === 'object')
      ? (parsed.telegram as Record<string, unknown>)
      : undefined;
    const telegramSent = telegram ? telegram.sent === true : undefined;
    return {
      ok: true,
      ...(jobId ? { jobId } : {}),
      ...(telegramSent !== undefined ? { telegramSent } : {})
    };
  }
  return errorResult(typeof parsed.error === 'string' && parsed.error ? parsed.error : 'approval_failed');
}

// request_approval.py'yi subprocess olarak çağırır; payload'ı STDIN'e JSON yazar,
// stdout'un son JSON satırını ApprovalResult'a parse eder.
// extraction-runner.ts kalıbına benzer ama PII STDIN gerektiği için execFile yerine spawn.
export function createApprovalRequester(config: ApprovalRequesterConfig): ApprovalRequester {
  const timeout = config.timeoutMs ?? 30000;

  return {
    requestApproval(payload: ApprovalPayload): Promise<ApprovalResult> {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (result: ApprovalResult): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };

        let child;
        try {
          child = spawn(config.python, [config.scriptPath, '--from-stdin'], {
            stdio: ['pipe', 'pipe', 'pipe']
          });
        } catch (error: unknown) {
          finish(errorResult(error instanceof Error ? error.message || 'spawn_failed' : 'spawn_failed'));
          return;
        }

        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        // stderr yutulur (PII/log gürültüsü result'a sızmasın); parse stdout'tan yapılır.
        child.stderr.on('data', () => { /* ignore */ });

        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* best effort */ }
          finish(errorResult('approval_timeout'));
        }, timeout);

        child.on('error', (error: Error) => {
          clearTimeout(timer);
          finish(errorResult(error.message || 'exec_failed'));
        });

        child.on('close', () => {
          clearTimeout(timer);
          const parsed = parseLastJsonLine(stdout);
          finish(parsed ? normalizeResult(parsed) : errorResult('no_json_output'));
        });

        // Payload STDIN'den (PII args'ta görünmesin). Yazma hatasında child.on('error') yakalar.
        try {
          child.stdin.write(JSON.stringify(payload));
          child.stdin.end();
        } catch (error: unknown) {
          clearTimeout(timer);
          try { child.kill('SIGKILL'); } catch { /* best effort */ }
          finish(errorResult(error instanceof Error ? error.message || 'stdin_failed' : 'stdin_failed'));
        }
      });
    }
  };
}
