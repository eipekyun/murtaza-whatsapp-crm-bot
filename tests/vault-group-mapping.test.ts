import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseGroupMappings,
  upsertGroupMapping,
  type GroupMappingEntry
} from '../src/customer/vault-group-mapping.js';

const SAMPLE = `# WhatsApp Grup Eşlemesi

Açıklama satırı.

## Eşlemeler

- \`120363407358572607@g.us\` → **atolye-bambini** / proje **21** <!-- wa-map chat=120363407358572607@g.us slug=atolye-bambini client=7 project=21 -->
- \`120363400000000001@g.us\` → **lavanda-lavander** / proje **32** <!-- wa-map chat=120363400000000001@g.us slug=lavanda-lavander client=24 project=32 -->
`;

describe('parseGroupMappings', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'murtaza-wamap-'));
    file = join(dir, 'WhatsApp-Grup-Eslemesi.md');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty array when the file is missing (no throw)', () => {
    expect(parseGroupMappings(join(dir, 'nope.md'))).toEqual([]);
  });

  it('returns an empty array for a file with no wa-map comments', async () => {
    await writeFile(file, '# Boş dosya\n\nHiç eşleme yok.\n', 'utf8');
    expect(parseGroupMappings(file)).toEqual([]);
  });

  it('parses all wa-map comments into entries', async () => {
    await writeFile(file, SAMPLE, 'utf8');

    const entries = parseGroupMappings(file);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      chatId: '120363407358572607@g.us',
      slug: 'atolye-bambini',
      perfexClientId: 7,
      perfexProjectId: 21
    });
    expect(entries[1]).toEqual({
      chatId: '120363400000000001@g.us',
      slug: 'lavanda-lavander',
      perfexClientId: 24,
      perfexProjectId: 32
    });
  });

  it('parses an optional quoted project name', async () => {
    await writeFile(
      file,
      '## Eşlemeler\n\n- x <!-- wa-map chat=120363400000000009@g.us slug=durak-makine project=42 name="Dijital Pazarlama" -->\n',
      'utf8'
    );

    const entries = parseGroupMappings(file);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      chatId: '120363400000000009@g.us',
      slug: 'durak-makine',
      perfexProjectId: 42,
      projectName: 'Dijital Pazarlama'
    });
  });

  it('skips a comment whose chat is not a group jid', async () => {
    await writeFile(
      file,
      '## Eşlemeler\n\n- x <!-- wa-map chat=905551112233@s.whatsapp.net slug=foo project=1 -->\n',
      'utf8'
    );

    expect(parseGroupMappings(file)).toEqual([]);
  });
});

describe('upsertGroupMapping', () => {
  let dir: string;
  let file: string;

  const ENTRY: GroupMappingEntry = {
    chatId: '120363407358572607@g.us',
    slug: 'atolye-bambini',
    perfexClientId: 7,
    perfexProjectId: 21
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'murtaza-wamap-'));
    file = join(dir, 'WhatsApp-Grup-Eslemesi.md');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the file with scaffold and the new entry when it does not exist', async () => {
    expect(existsSync(file)).toBe(false);

    upsertGroupMapping(file, ENTRY);

    expect(existsSync(file)).toBe(true);
    const text = await readFile(file, 'utf8');
    expect(text).toContain('# WhatsApp Grup Eşlemesi');
    expect(text).toContain('## Eşlemeler');
    expect(text).toContain('wa-map chat=120363407358572607@g.us slug=atolye-bambini client=7 project=21');

    const entries = parseGroupMappings(file);
    expect(entries).toEqual([ENTRY]);
  });

  it('appends a second entry without dropping the first', async () => {
    upsertGroupMapping(file, ENTRY);
    upsertGroupMapping(file, {
      chatId: '120363400000000001@g.us',
      slug: 'lavanda-lavander',
      perfexClientId: 24,
      perfexProjectId: 32
    });

    const entries = parseGroupMappings(file);
    const byChat = new Map(entries.map((e) => [e.chatId, e]));
    expect(entries).toHaveLength(2);
    expect(byChat.get('120363407358572607@g.us')?.slug).toBe('atolye-bambini');
    expect(byChat.get('120363400000000001@g.us')?.slug).toBe('lavanda-lavander');
  });

  it('updates an existing entry in place (same chatId, no duplicate)', async () => {
    upsertGroupMapping(file, ENTRY);
    upsertGroupMapping(file, { ...ENTRY, slug: 'atolye-bambini', perfexProjectId: 99 });

    const entries = parseGroupMappings(file);
    expect(entries).toHaveLength(1);
    expect(entries[0].perfexProjectId).toBe(99);
  });

  it('preserves a non-mapping line already present in the section', async () => {
    await writeFile(file, SAMPLE, 'utf8');

    upsertGroupMapping(file, {
      chatId: '120363400000000002@g.us',
      slug: 'moda-sogutma',
      perfexClientId: 5,
      perfexProjectId: 11
    });

    const entries = parseGroupMappings(file);
    expect(entries).toHaveLength(3);
    const slugs = entries.map((e) => e.slug).sort();
    expect(slugs).toEqual(['atolye-bambini', 'lavanda-lavander', 'moda-sogutma']);
  });

  it('normalizes the slug before writing', async () => {
    upsertGroupMapping(file, { ...ENTRY, slug: '  Atölye-Bambini!  ' });

    const entries = parseGroupMappings(file);
    expect(entries[0].slug).toBe('atlye-bambini');
  });

  it('sanitizes a projectName that contains comment-breaking characters', async () => {
    upsertGroupMapping(file, { ...ENTRY, projectName: 'Reklam --> 2026 > Q1' });

    const entries = parseGroupMappings(file);
    expect(entries).toHaveLength(1);
    // Operasyonel alanlar '-->' enjeksiyonuna rağmen sağlam kalmalı (comment erken kapanmamalı).
    expect(entries[0].chatId).toBe('120363407358572607@g.us');
    expect(entries[0].slug).toBe('atolye-bambini');
    expect(entries[0].perfexProjectId).toBe(21);
    // projectName comment'i kırabilecek '>' içermemeli.
    expect(entries[0].projectName ?? '').not.toContain('>');
  });

  it('rejects a chatId that is not a group jid (throws)', () => {
    expect(() =>
      upsertGroupMapping(file, { ...ENTRY, chatId: '905551112233@s.whatsapp.net' })
    ).toThrow();
    expect(existsSync(file)).toBe(false);
  });

  it('rejects a slug that normalizes to empty (throws)', () => {
    expect(() => upsertGroupMapping(file, { ...ENTRY, slug: '@#$' })).toThrow();
  });
});
