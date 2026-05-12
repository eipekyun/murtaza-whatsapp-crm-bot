import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeQrArtifacts } from '../src/whatsapp/qr-artifacts.js';

describe('QR artifacts', () => {
  it('writes raw, terminal, and png QR artifacts for easy scanning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'murtaza-qr-'));
    try {
      const result = await writeQrArtifacts('test-whatsapp-qr-payload', dir);

      expect(result.rawPath).toBe(join(dir, 'latest-qr.txt'));
      expect(result.terminalPath).toBe(join(dir, 'latest-qr-terminal.txt'));
      expect(result.pngPath).toBe(join(dir, 'latest-qr.png'));

      const raw = await readFile(result.rawPath, 'utf8');
      const terminal = await readFile(result.terminalPath, 'utf8');
      const png = await readFile(result.pngPath);

      expect(raw).toBe('test-whatsapp-qr-payload');
      expect(terminal).toContain('█');
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
