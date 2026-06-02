import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExtractionRunner, type ExtractionResult } from '../src/candidate/extraction-runner.js';

// Gerçek subprocess yolu: mkdtemp'e küçük bir Python script yazıp execFile ile çalıştırırız.
// Mock yok — wa-extract.py STDOUT sözleşmesini (son satır tek JSON) gerçekten test ederiz.
let dir: string;
const PY = '/usr/bin/python3';

function writeScript(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'murtaza-extract-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('extraction runner', () => {
  it('parses an ok JSON envelope into ok=true with mapped tasks (snake_case → camelCase)', async () => {
    // Argümanları stderr'e basıp doğru CLI imzasını da görebiliriz; STDOUT sadece JSON.
    const scriptPath = writeScript(
      'ok.py',
      [
        'import json, sys',
        'env = {',
        '  "ok": True,',
        '  "summary": "Logo ve banner konuşuldu",',
        '  "tasks": [',
        '    {"title": "Logo revize", "description": "rengi koyulaştır", "priority": 4, "suggested_due": "2026-06-10", "source_message_ids": ["wamid-1", "wamid-2"]}',
        '  ],',
        '  "error": None',
        '}',
        'print(json.dumps(env))',
        'sys.exit(0)',
        ''
      ].join('\n')
    );

    const runner = createExtractionRunner({ python: PY, scriptPath, dbPath: join(dir, 'db.sqlite') });
    const result = await runner.extractGroup('120363000@g.us');

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Logo ve banner konuşuldu');
    expect(result.error).toBeUndefined();
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks?.[0]).toEqual({
      title: 'Logo revize',
      description: 'rengi koyulaştır',
      priority: 4,
      suggestedDue: '2026-06-10',
      sourceMessageIds: ['wamid-1', 'wamid-2']
    });
  });

  it('takes the last JSON line when a log/warning line precedes it', async () => {
    const scriptPath = writeScript(
      'warn.py',
      [
        'print("WARN: model fallback used")',
        'print(\'{"ok": true, "summary": "ok", "tasks": [], "error": null}\')',
        ''
      ].join('\n')
    );

    const runner = createExtractionRunner({ python: PY, scriptPath, dbPath: join(dir, 'db.sqlite') });
    const result = await runner.extractGroup('120363000@g.us');

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('ok');
    expect(result.tasks).toEqual([]);
  });

  it('returns ok=false with the script-reported error when ok:false envelope', async () => {
    const scriptPath = writeScript(
      'err.py',
      [
        'import json',
        'print(json.dumps({"ok": False, "summary": None, "tasks": [], "error": "grup boş"}))',
        ''
      ].join('\n')
    );

    const runner = createExtractionRunner({ python: PY, scriptPath, dbPath: join(dir, 'db.sqlite') });
    const result = await runner.extractGroup('120363000@g.us');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('grup boş');
  });

  it('returns ok=false (no_json_output) when stdout has no JSON line', async () => {
    const scriptPath = writeScript(
      'garbage.py',
      ['print("bu satır JSON değil")', 'print("ne de bu")', ''].join('\n')
    );

    const runner = createExtractionRunner({ python: PY, scriptPath, dbPath: join(dir, 'db.sqlite') });
    const result = await runner.extractGroup('120363000@g.us');

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('does not throw when the script path does not exist (returns ok=false)', async () => {
    const runner = createExtractionRunner({
      python: PY,
      scriptPath: join(dir, 'does-not-exist.py'),
      dbPath: join(dir, 'db.sqlite')
    });

    // Promise resolve eder, reject etmez (ASLA throw kontratı).
    const promise = runner.extractGroup('120363000@g.us');
    await expect(promise).resolves.toMatchObject({ ok: false });

    const result: ExtractionResult = await promise;
    expect(result.error).toBeTruthy();
  });

  it('returns ok=false without spawning when chatId is empty', async () => {
    const runner = createExtractionRunner({
      python: PY,
      scriptPath: join(dir, 'whatever.py'),
      dbPath: join(dir, 'db.sqlite')
    });

    const result = await runner.extractGroup('');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('chatId gerekli');
  });

  it('defaults invalid task priority to 2 and coerces missing fields safely', async () => {
    const scriptPath = writeScript(
      'partial.py',
      [
        'import json',
        'env = {"ok": True, "summary": "x", "tasks": [{"title": "t", "priority": 9, "source_message_ids": [1, 2]}], "error": None}',
        'print(json.dumps(env))',
        ''
      ].join('\n')
    );

    const runner = createExtractionRunner({ python: PY, scriptPath, dbPath: join(dir, 'db.sqlite') });
    const result = await runner.extractGroup('120363000@g.us');

    expect(result.ok).toBe(true);
    expect(result.tasks?.[0]).toEqual({
      title: 't',
      description: '',
      priority: 2,
      sourceMessageIds: ['1', '2']
    });
  });
});
