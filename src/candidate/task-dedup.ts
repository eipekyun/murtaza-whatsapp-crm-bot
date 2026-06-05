import type { CandidateTask } from '../types.js';

// Görev başlığını dedup için normalize eder: Türkçe küçük harf, noktalama/sembol → boşluk,
// fazla boşluk sadeleştir, kırp. İki taraf (yazılmış başlıklar + yeni çıkarılan görevler) aynı
// fonksiyondan geçtiği için küçük yazım/noktalama farkları eşleşmeyi bozmaz.
export function normalizeTaskKey(title: string): string {
  return title
    .toLocaleLowerCase('tr')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Zaten Perfex'e yazılmış ('written') başlıklarla eşleşen görevleri eler. Cron her çalıştığında
// aynı mesaj penceresini yeniden çıkarınca, daha önce işlenmiş görev tekrar aday/onaya düşmesin.
// Sadece 'written' filtrelenir: 'sent' (onay bekleyen/reddedilen) hariç tutulmaz, yoksa reddedilmiş
// görev kalıcı kaybolurdu (reject yolu bot DB'sini güncellemez, aday 'sent' kalır).
export function filterUnwrittenTasks(
  tasks: readonly CandidateTask[],
  writtenTitles: readonly string[]
): CandidateTask[] {
  if (writtenTitles.length === 0) return [...tasks];
  const writtenKeys = new Set(writtenTitles.map(normalizeTaskKey));
  return tasks.filter((t) => !writtenKeys.has(normalizeTaskKey(t.title)));
}
