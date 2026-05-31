import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCustomerCards, readCustomerCard } from '../src/customer/customer-card-reader.js';

const SINGLE_PROJECT = `# Lavanda Lavander

## Perfex Bağlantısı (sync edilen)

- **Perfex userid:** \`24\`
- **company (Perfex):** Lavanda Lavander

## Aktif Projeler

- **Kanonik web/deploy repo:** GitHub github.com/lavandalavenderltt/website
- **Perfex project ID:** \`32\`
- **Son durum özeti:** medya Drive'a alındı.
`;

const MULTI_PROJECT = `# Atölye Bambini

## Perfex Bağlantısı (sync edilen)

- **Perfex userid:** \`7\`

## Aktif Projeler

- **Repo path:** \`-\`
- **Prod URL:** https://atolyebambini.com.tr/
- **Perfex project ID:** \`9\` (\`Hosting Hizmeti\`), \`21\` (\`Dijital Pazarlama\`)
`;

const LEAD_CARD = `# Durak Makine Otomasyon

## Perfex Lead Bağlantısı

- **Perfex lead id:** \`4\`
- **status:** \`5\` — Teklif Verildi

## Veri Kaynakları

- **Repo path:** \`/Users/mone/dev/durakmakine\`
`;

const NO_PERFEX = `# Örnek Müşteri — ABC Restoran

## Aktif Projeler
- Meta reklam kampanyası — Yaz menüsü
`;

const BARE_INT_CARD = `# Bare Int Müşteri

## Perfex Bağlantısı

- **Perfex userid:** 88

## Aktif Projeler

- **Repo path:** /home/dev/bare-repo
- **Perfex project ID:** 12 (Web), 13 (Reklam)
`;

describe('readCustomerCard', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'murtaza-cards-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses a single-project card with backtick-wrapped ids', async () => {
    await writeFile(join(dir, 'lavanda-lavander.md'), SINGLE_PROJECT, 'utf8');

    const card = readCustomerCard('lavanda-lavander', dir);

    expect(card).toBeDefined();
    expect(card?.slug).toBe('lavanda-lavander');
    expect(card?.name).toBe('Lavanda Lavander');
    expect(card?.perfexClientId).toBe(24);
    expect(card?.perfexProjectIds).toEqual([{ id: 32 }]);
    expect(card?.perfexLeadId).toBeUndefined();
  });

  it('parses multiple project ids with names from a single line', async () => {
    await writeFile(join(dir, 'atolye-bambini.md'), MULTI_PROJECT, 'utf8');

    const card = readCustomerCard('atolye-bambini', dir);

    expect(card?.perfexClientId).toBe(7);
    expect(card?.perfexProjectIds).toEqual([
      { id: 9, name: 'Hosting Hizmeti' },
      { id: 21, name: 'Dijital Pazarlama' }
    ]);
    // '-' placeholder repo path göz ardı edilir
    expect(card?.repoPath).toBeUndefined();
  });

  it('parses a lead card (lead id, no userid)', async () => {
    await writeFile(join(dir, 'durak-makine-otomasyon.md'), LEAD_CARD, 'utf8');

    const card = readCustomerCard('durak-makine-otomasyon', dir);

    expect(card?.perfexLeadId).toBe(4);
    expect(card?.perfexClientId).toBeUndefined();
    expect(card?.perfexProjectIds).toEqual([]);
    // Repo path 'Aktif Projeler' bölümünde değil -> yok sayılır
    expect(card?.repoPath).toBeUndefined();
  });

  it('handles a card with no Perfex fields gracefully', async () => {
    await writeFile(join(dir, 'ornek-musteri.md'), NO_PERFEX, 'utf8');

    const card = readCustomerCard('ornek-musteri', dir);

    expect(card).toBeDefined();
    expect(card?.name).toBe('Örnek Müşteri — ABC Restoran');
    expect(card?.perfexClientId).toBeUndefined();
    expect(card?.perfexLeadId).toBeUndefined();
    expect(card?.perfexProjectIds).toEqual([]);
  });

  it('captures bare (non-backtick) ints and a non-placeholder repo path', async () => {
    await writeFile(join(dir, 'bare-int-musteri.md'), BARE_INT_CARD, 'utf8');

    const card = readCustomerCard('bare-int-musteri', dir);

    expect(card?.perfexClientId).toBe(88);
    expect(card?.perfexProjectIds).toEqual([
      { id: 12, name: 'Web' },
      { id: 13, name: 'Reklam' }
    ]);
    expect(card?.repoPath).toBe('/home/dev/bare-repo');
  });

  it('normalizes the slug before resolving the file', async () => {
    await writeFile(join(dir, 'lavanda-lavander.md'), SINGLE_PROJECT, 'utf8');

    const card = readCustomerCard('  Lavanda-Lavander!  ', dir);

    expect(card?.perfexClientId).toBe(24);
  });

  it('returns undefined for a missing card (no throw)', () => {
    expect(readCustomerCard('does-not-exist', dir)).toBeUndefined();
  });

  it('returns undefined when the slug normalizes to empty', () => {
    expect(readCustomerCard('@#$', dir)).toBeUndefined();
  });
});

describe('listCustomerCards', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'murtaza-cards-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads all .md cards and skips _ / . prefixed files', async () => {
    await writeFile(join(dir, 'lavanda-lavander.md'), SINGLE_PROJECT, 'utf8');
    await writeFile(join(dir, 'atolye-bambini.md'), MULTI_PROJECT, 'utf8');
    await writeFile(join(dir, '_Index.md'), '# Index\n', 'utf8');
    await writeFile(join(dir, '.hidden.md'), '# Hidden\n', 'utf8');
    await writeFile(join(dir, 'notes.txt'), 'not a card', 'utf8');

    const cards = listCustomerCards(dir);

    expect(cards).toHaveLength(2);
    // tr-locale sort: Atölye Bambini < Lavanda Lavander
    expect(cards.map((c) => c.name)).toEqual(['Atölye Bambini', 'Lavanda Lavander']);
  });

  it('returns an empty array for a missing directory', () => {
    expect(listCustomerCards(join(dir, 'nope'))).toEqual([]);
  });
});
