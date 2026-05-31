import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeSlug } from './slug.js';

// Vault'taki WhatsApp grup→firma/proje eşleme dosyasının okuyucu/yazıcısı.
// Authoritative dosya: 02-Temel/WhatsApp-Grup-Eslemesi.md. Her eşleme tek satır,
// hem insan-okunur hem makine-parse'lı bir '<!-- wa-map ... -->' HTML comment'i taşır.

export interface GroupMappingEntry {
  chatId: string;
  slug: string;
  perfexClientId?: number;
  perfexProjectId?: number;
  projectName?: string;
}

// Eşleme satırlarına gömülü makine-okunur blok: '<!-- wa-map key=val ... -->'.
const WA_MAP_COMMENT_RE = /<!--\s*wa-map\s+([^>]*?)\s*-->/i;
// Tek key=value çifti; value ya tırnaklı ('a b') ya tırnaksız (boşluğa kadar).
const KV_RE = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;

const SECTION_HEADING = '## Eşlemeler';

function isGroupChatId(chatId: string): boolean {
  return chatId.endsWith('@g.us');
}

// HTML comment gövdesine güvenli yazım: '>' karakteri (ve dolayısıyla '-->')
// comment'i erken kapatabileceğinden çift tırnakla birlikte elenir.
function commentSafe(value: string): string {
  return value.replace(/[">]/g, ' ').trim();
}

// Bir 'wa-map' comment gövdesini key=value sözlüğüne çevirir.
function parseKeyValues(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  KV_RE.lastIndex = 0;
  for (let m = KV_RE.exec(body); m; m = KV_RE.exec(body)) {
    const key = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    out[key] = value;
  }
  return out;
}

// Tek satırdaki 'wa-map' comment'ini GroupMappingEntry'ye çevirir; yoksa undefined.
function parseLine(line: string): GroupMappingEntry | undefined {
  const commentMatch = WA_MAP_COMMENT_RE.exec(line);
  if (!commentMatch) return undefined;
  const kv = parseKeyValues(commentMatch[1]);

  const chatId = (kv.chat ?? kv.chatId ?? '').trim();
  const slug = normalizeSlug(kv.slug ?? '');
  if (!isGroupChatId(chatId) || !slug) return undefined;

  const client = Number.parseInt(kv.client ?? '', 10);
  const project = Number.parseInt(kv.project ?? '', 10);
  const projectName = (kv.name ?? '').trim();

  return {
    chatId,
    slug,
    ...(Number.isFinite(client) ? { perfexClientId: client } : {}),
    ...(Number.isFinite(project) ? { perfexProjectId: project } : {}),
    ...(projectName ? { projectName } : {})
  };
}

// Eşleme dosyasını okuyup tüm geçerli satırları döndürür. Dosya yoksa [] (throw YOK).
export function parseGroupMappings(filePath: string): GroupMappingEntry[] {
  if (!existsSync(filePath)) return [];
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: GroupMappingEntry[] = [];
  for (const line of text.split('\n')) {
    const entry = parseLine(line);
    if (entry) out.push(entry);
  }
  return out;
}

// Bir entry'den tek satırlık eşleme metnini üretir (insan-okunur + makine-parse'lı).
function renderLine(entry: GroupMappingEntry): string {
  const projectLabel = entry.projectName
    ? `proje **${entry.perfexProjectId ?? '-'}** (${entry.projectName})`
    : entry.perfexProjectId !== undefined
      ? `proje **${entry.perfexProjectId}**`
      : 'proje **-**';

  const kv: string[] = [`slug=${entry.slug}`];
  if (entry.perfexClientId !== undefined) kv.push(`client=${entry.perfexClientId}`);
  if (entry.perfexProjectId !== undefined) kv.push(`project=${entry.perfexProjectId}`);
  // projectName comment gövdesine yazılır; '>' / '-->' comment sınırını kırabileceğinden temizlenir.
  if (entry.projectName) kv.push(`name="${commentSafe(entry.projectName)}"`);

  return `- \`${entry.chatId}\` → **${entry.slug}** / ${projectLabel} <!-- wa-map chat=${entry.chatId} ${kv.join(' ')} -->`;
}

// Dosya yoksa başlık + açıklama + bölüm iskeletini üretir.
function scaffold(): string {
  return [
    '# WhatsApp Grup Eşlemesi',
    '',
    'WhatsApp gruplarının MURTAZA firma slug ve Perfex projesine eşlemesi.',
    'Her satır hem insan-okunur hem makine-parse\'lıdır: satır sonundaki',
    '`<!-- wa-map ... -->` comment\'i bot tarafından parse edilir.',
    'Bu dosya bot tarafından otomatik güncellenir; satırları elle düzenlerken',
    'comment bloğunu bozma.',
    '',
    SECTION_HEADING,
    ''
  ].join('\n');
}

// Atomik yazım: aynı dizinde tmp dosyaya yaz, sonra rename (aynı fs içinde atomik).
// Aynı dizin şart — cross-device rename EXDEV ile patlar.
function writeAtomic(filePath: string, content: string): void {
  const tmpPath = join(dirname(filePath), `.${process.pid}-${Date.now()}.wa-map.tmp`);
  writeFileSync(tmpPath, content, { encoding: 'utf8' });
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    // rename başarısızsa artık tmp dosyasını bırakma (vault dizinine sızar, auto-sync commit'leyebilir).
    try { unlinkSync(tmpPath); } catch { /* tmp zaten yoksa yut */ }
    throw err;
  }
}

// '## Eşlemeler' bölümünün satır index'ini bulur; yoksa -1.
function findSectionIndex(lines: readonly string[]): number {
  return lines.findIndex((line) => line.trim() === SECTION_HEADING);
}

// Aynı chatId'yi taşıyan satırın index'ini bulur; yoksa -1.
function findEntryLineIndex(lines: readonly string[], chatId: string): number {
  return lines.findIndex((line) => {
    const entry = parseLine(line);
    return entry?.chatId === chatId;
  });
}

// Bir grup eşlemesini ekler veya günceller. chatId varsa o satır değiştirilir,
// yoksa '## Eşlemeler' bölümüne eklenir. Dosya yoksa iskeletle OLUŞTURULUR.
// Atomik yazım (tmp + rename). GİT ÇALIŞTIRMAZ — 10dk auto-sync cron commitler.
// GÜVENLİK: chatId '@g.us' formatında değilse reddeder; sadece verilen dosyaya yazar.
export function upsertGroupMapping(filePath: string, entry: GroupMappingEntry): void {
  if (!isGroupChatId(entry.chatId)) {
    throw new Error(`Geçersiz grup chatId (beklenen '@g.us'): ${entry.chatId}`);
  }
  const slug = normalizeSlug(entry.slug);
  if (!slug) {
    throw new Error('Geçersiz slug: normalize sonrası boş');
  }
  const normalized: GroupMappingEntry = { ...entry, slug };
  const newLine = renderLine(normalized);

  const existing = existsSync(filePath) ? safeRead(filePath) : scaffold();
  // Sondaki newline'ı koru/normalize et: önce trailing'i ayır, sonunda tek '\n' bırak.
  const lines = existing.replace(/\n+$/, '').split('\n');

  const matchIndex = findEntryLineIndex(lines, normalized.chatId);
  let nextLines: string[];
  if (matchIndex >= 0) {
    nextLines = lines.map((line, i) => (i === matchIndex ? newLine : line));
  } else {
    const sectionIndex = findSectionIndex(lines);
    if (sectionIndex < 0) {
      // Bölüm yoksa sona başlık + yeni satır ekle (immutable: yeni dizi).
      nextLines = [...lines, '', SECTION_HEADING, '', newLine];
    } else {
      // Yeni eşlemeyi bölümün başına (heading sonrası ilk satır olarak) ekle.
      // Heading'i hemen izleyen blank satır varsa onu koru, çift blank üretme.
      const after = lines.slice(sectionIndex + 1);
      const insertAt = after[0]?.trim() === '' ? sectionIndex + 2 : sectionIndex + 1;
      nextLines = [...lines.slice(0, insertAt), newLine, ...lines.slice(insertAt)];
    }
  }

  writeAtomic(filePath, `${nextLines.join('\n')}\n`);
}

function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return scaffold();
  }
}
