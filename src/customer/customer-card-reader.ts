import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CustomerCardInfo } from '../types.js';
import { normalizeSlug } from './slug.js';

// Bold label değerinden int yakalayan ortak regex: hem '`24`' hem '24' eşleşir.
// '**Label:**' sonrasında opsiyonel backtick + sayı.
const PERFEX_USERID_RE = /\*\*Perfex userid:\*\*\s*`?(\d+)`?/i;
const PERFEX_LEADID_RE = /\*\*Perfex lead id:\*\*\s*`?(\d+)`?/i;
// '**Repo path:**' satırından path; backtick'li veya çıplak. Placeholder '-' atlanır.
const REPO_PATH_RE = /\*\*Repo path:\*\*\s*`?([^`\n]+?)`?\s*$/i;
// 'Perfex project ID:' sonrasında satırın tamamı; içinde birden fazla
// `id` (`name`) çifti olabilir (çoklu projeli müşteri tek satırda listeler).
const PERFEX_PROJECT_LINE_RE = /\*\*Perfex project ID:\*\*(.*)$/i;
// Tek bir proje girişi: backtick'li/çıplak id + opsiyonel (`Ad`) ya da (Ad).
const PROJECT_ENTRY_RE = /`?(\d+)`?(?:\s*\((?:`([^`]+)`|([^)]+))\))?/g;

// '## Başlık' satırından bölüm adını döndürür; başlık değilse undefined.
function sectionHeading(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('##')) return undefined;
  return trimmed.replace(/^#+\s*/, '').trim();
}

function parseProjectIds(line: string): { id: number; name?: string }[] {
  const m = PERFEX_PROJECT_LINE_RE.exec(line);
  if (!m) return [];
  const rest = m[1];
  const out: { id: number; name?: string }[] = [];
  PROJECT_ENTRY_RE.lastIndex = 0;
  for (let match = PROJECT_ENTRY_RE.exec(rest); match; match = PROJECT_ENTRY_RE.exec(rest)) {
    const id = Number.parseInt(match[1], 10);
    if (!Number.isFinite(id)) continue;
    const rawName = (match[2] ?? match[3])?.trim();
    out.push(rawName ? { id, name: rawName } : { id });
  }
  return out;
}

// Kart metnini ayrıştırıp CustomerCardInfo döndürür. Slug + name çağıran tarafça verilir.
function parseCardText(text: string, slug: string, name: string): CustomerCardInfo {
  let perfexClientId: number | undefined;
  let perfexLeadId: number | undefined;
  let repoPath: string | undefined;
  const perfexProjectIds: { id: number; name?: string }[] = [];

  let inAktifProjeler = false;
  for (const line of text.split('\n')) {
    const heading = sectionHeading(line);
    if (heading !== undefined) {
      inAktifProjeler = heading.toLowerCase().startsWith('aktif projeler');
      continue;
    }

    if (perfexClientId === undefined) {
      const userMatch = PERFEX_USERID_RE.exec(line);
      if (userMatch) perfexClientId = Number.parseInt(userMatch[1], 10);
    }
    if (perfexLeadId === undefined) {
      const leadMatch = PERFEX_LEADID_RE.exec(line);
      if (leadMatch) perfexLeadId = Number.parseInt(leadMatch[1], 10);
    }

    const projectIds = parseProjectIds(line);
    for (const entry of projectIds) perfexProjectIds.push(entry);

    // repoPath yalnız '## Aktif Projeler' altında; placeholder '-' kabul edilmez.
    if (inAktifProjeler && repoPath === undefined) {
      const repoMatch = REPO_PATH_RE.exec(line);
      if (repoMatch) {
        const candidate = repoMatch[1].trim();
        if (candidate && candidate !== '-') repoPath = candidate;
      }
    }
  }

  return {
    slug,
    name,
    ...(perfexClientId !== undefined ? { perfexClientId } : {}),
    perfexProjectIds,
    ...(repoPath !== undefined ? { repoPath } : {}),
    ...(perfexLeadId !== undefined ? { perfexLeadId } : {})
  };
}

// İlk '# Başlık' satırından firma adı; yoksa slug'a düşer.
function extractName(text: string, slug: string): string {
  const heading = text.split('\n').find((line) => line.trim().startsWith('# '));
  if (!heading) return slug;
  return heading.replace(/^#\s+/, '').trim() || slug;
}

// Tek bir müşteri kartını okur. Dosya yoksa undefined döner (throw yok).
export function readCustomerCard(slug: string, customersDir: string): CustomerCardInfo | undefined {
  const safe = normalizeSlug(slug);
  if (!safe) return undefined;
  const path = join(customersDir, `${safe}.md`);
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const name = extractName(text, safe);
  return parseCardText(text, safe, name);
}

// customersDir'deki tüm *.md kartlarını okur (_ veya . ile başlayanlar hariç).
// Okuma/parse hatası olan kart atlanır; Örnek/şablon kartları graceful geçer.
export function listCustomerCards(customersDir: string): CustomerCardInfo[] {
  if (!existsSync(customersDir)) return [];
  let files: string[];
  try {
    files = readdirSync(customersDir);
  } catch {
    return [];
  }
  const out: CustomerCardInfo[] = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    if (file.startsWith('_') || file.startsWith('.')) continue;
    const slug = file.slice(0, -3);
    const card = readCustomerCard(slug, customersDir);
    if (card) out.push(card);
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  return out;
}
