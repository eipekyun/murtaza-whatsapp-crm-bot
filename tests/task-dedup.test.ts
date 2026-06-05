import { describe, expect, it } from 'vitest';
import { normalizeTaskKey, filterUnwrittenTasks } from '../src/candidate/task-dedup.js';
import type { CandidateTask } from '../src/types.js';

function task(title: string): CandidateTask {
  return { title, description: '', priority: 2, sourceMessageIds: [] };
}

describe('normalizeTaskKey', () => {
  it('lowercases (tr), strips punctuation, collapses whitespace', () => {
    expect(normalizeTaskKey('  Logo  Revize! ')).toBe('logo revize');
    expect(normalizeTaskKey('Banner, hazırla.')).toBe('banner hazırla');
  });

  it('treats punctuation/case variants of the same title as equal key', () => {
    expect(normalizeTaskKey('Logo revize')).toBe(normalizeTaskKey('logo  revize.'));
  });
});

describe('filterUnwrittenTasks', () => {
  it('drops tasks whose normalized title matches a written title', () => {
    const tasks = [task('Logo revize'), task('Yeni görev'), task('Banner hazırla')];
    const written = ['logo  revize!', 'Banner hazırla'];
    const fresh = filterUnwrittenTasks(tasks, written);
    expect(fresh.map((t) => t.title)).toEqual(['Yeni görev']);
  });

  it('returns all tasks when there are no written titles', () => {
    const tasks = [task('A'), task('B')];
    expect(filterUnwrittenTasks(tasks, [])).toHaveLength(2);
  });

  it('returns empty when every task is already written', () => {
    const tasks = [task('A'), task('B')];
    expect(filterUnwrittenTasks(tasks, ['a', 'b'])).toHaveLength(0);
  });
});
