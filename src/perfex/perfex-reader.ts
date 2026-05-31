import { execFile } from 'node:child_process';
import type { PerfexQueryResult } from '../types.js';

export interface PerfexReader {
  // Tek müşteri için açık görevler + projeleri Perfex'ten READ-ONLY çeker.
  // Hata durumunda ASLA throw etmez; { tasks:[], projects:[], error } döner (bot çökmesin).
  fetchClientStatus(clientId: number): Promise<PerfexQueryResult>;
}

export interface PerfexReaderConfig {
  python: string;
  scriptPath: string;
  opsEnvPath: string;
  timeoutMs?: number;
}

function errorResult(message: string): PerfexQueryResult {
  return { tasks: [], projects: [], error: message };
}

// stdout'un SON dolu JSON satırını parse eder. Script garanti tek satır JSON basar;
// yine de defansif olarak (uyarı/log satırı önde olabilir) son '{' başlangıçlı satırı alırız.
function parseLastJsonLine(stdout: string): PerfexQueryResult | undefined {
  const lines = (stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as PerfexQueryResult;
    } catch {
      // sonraki (daha üstteki) satırı dene
    }
  }
  return undefined;
}

// perfex-query.py'yi subprocess olarak çağırır; stdout'un son JSON satırını PerfexQueryResult'a parse eder.
// (media-archiver.ts'teki createDrivePythonRunner ile aynı execFile→JSON parse kalıbı.)
export function createPerfexReader(config: PerfexReaderConfig): PerfexReader {
  const timeout = config.timeoutMs ?? 20000;

  return {
    fetchClientStatus(clientId: number): Promise<PerfexQueryResult> {
      if (!Number.isInteger(clientId)) {
        return Promise.resolve(errorResult('clientId tam sayı olmalı'));
      }

      const args = [
        config.scriptPath,
        '--client-id',
        String(clientId),
        '--ops-env',
        config.opsEnvPath
      ];

      return new Promise((resolve) => {
        execFile(
          config.python,
          args,
          { timeout, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout) => {
            const parsed = parseLastJsonLine(stdout);
            if (parsed) {
              resolve(parsed);
              return;
            }
            resolve(errorResult(error ? error.message || 'exec_failed' : 'no_json_output'));
          }
        );
      });
    }
  };
}
