import { beforeEach, describe, expect, it, vi } from 'vitest';

// node:child_process.execFile mock'lanır; gerçek subprocess çalışmaz.
// Her test execFileMock.mockImplementation ile kendi senaryosunu (başarı/hata/timeout) kurar.
const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (execFileMock as (...a: unknown[]) => void)(...args)
}));

const { createPerfexReader } = await import('../src/perfex/perfex-reader.js');

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

function lastArgIsCallback(args: unknown[]): ExecCb {
  return args[args.length - 1] as ExecCb;
}

const baseConfig = {
  python: '/usr/bin/python3',
  scriptPath: '/srv/scripts/perfex-query.py',
  opsEnvPath: '/home/murtaza/.config/murtaza-vps-ops.env'
};

describe('perfex reader', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('parses the single-line JSON envelope on success', async () => {
    const envelope = {
      tasks: [{ id: 5, name: 'Görev', priority: 4, status: 2, statusLabel: 'Devam Ediyor', dueDate: '2026-06-01' }],
      projects: [{ id: 42, name: 'Voice ID', status: 2 }],
      error: null
    };
    execFileMock.mockImplementation((...args: unknown[]) => {
      lastArgIsCallback(args)(null, JSON.stringify(envelope) + '\n', '');
    });

    const reader = createPerfexReader(baseConfig);
    const result = await reader.fetchClientStatus(24);

    expect(result.error).toBeNull();
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ id: 5, statusLabel: 'Devam Ediyor', dueDate: '2026-06-01' });
    expect(result.projects[0]).toMatchObject({ id: 42, name: 'Voice ID' });
  });

  it('passes the wave-0 CLI signature to execFile (--client-id, --ops-env)', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      lastArgIsCallback(args)(null, '{"tasks":[],"projects":[],"error":null}\n', '');
    });

    const reader = createPerfexReader(baseConfig);
    await reader.fetchClientStatus(24);

    const [python, argv] = execFileMock.mock.calls[0] as [string, string[]];
    expect(python).toBe('/usr/bin/python3');
    expect(argv).toEqual([
      '/srv/scripts/perfex-query.py',
      '--client-id',
      '24',
      '--ops-env',
      '/home/murtaza/.config/murtaza-vps-ops.env'
    ]);
  });

  it('takes the last JSON line when a warning line precedes it', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      lastArgIsCallback(args)(null, 'WARN: deprecated\n{"tasks":[],"projects":[],"error":null}\n', '');
    });

    const reader = createPerfexReader(baseConfig);
    const result = await reader.fetchClientStatus(7);

    expect(result.error).toBeNull();
    expect(result.tasks).toEqual([]);
  });

  it('prefers the parsed error envelope even when the process exits non-zero', async () => {
    // perfex-query.py exit 0 sözleşmesi olsa da, defansif: hata zarfı varsa onu döndür.
    execFileMock.mockImplementation((...args: unknown[]) => {
      const err = Object.assign(new Error('Command failed'), { code: 1 });
      lastArgIsCallback(args)(err, '{"tasks":[],"projects":[],"error":"Perfex SSH/MySQL zaman aşımı"}\n', '');
    });

    const reader = createPerfexReader(baseConfig);
    const result = await reader.fetchClientStatus(24);

    expect(result.error).toBe('Perfex SSH/MySQL zaman aşımı');
    expect(result.tasks).toEqual([]);
  });

  it('returns an error result (no throw) when exit non-zero with no parseable JSON', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const err = Object.assign(new Error('boom'), { code: 2 });
      lastArgIsCallback(args)(err, '', 'traceback...');
    });

    const reader = createPerfexReader(baseConfig);
    const result = await reader.fetchClientStatus(24);

    expect(result.error).toBe('boom');
    expect(result.tasks).toEqual([]);
    expect(result.projects).toEqual([]);
  });

  it('returns an error result when execFile reports a timeout with no output', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const err = Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' });
      lastArgIsCallback(args)(err, '', '');
    });

    const reader = createPerfexReader({ ...baseConfig, timeoutMs: 100 });
    const result = await reader.fetchClientStatus(24);

    expect(result.error).toBe('timeout');
    expect(result.tasks).toEqual([]);
  });

  it('returns no_json_output when stdout is empty and there is no error', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      lastArgIsCallback(args)(null, '', '');
    });

    const reader = createPerfexReader(baseConfig);
    const result = await reader.fetchClientStatus(24);

    expect(result.error).toBe('no_json_output');
  });

  it('rejects a non-integer clientId without spawning the process', async () => {
    const reader = createPerfexReader(baseConfig);
    const result = await reader.fetchClientStatus(3.5);

    expect(result.error).toBe('clientId tam sayı olmalı');
    expect(result.tasks).toEqual([]);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
