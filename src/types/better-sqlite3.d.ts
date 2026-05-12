declare module 'better-sqlite3' {
  export interface Statement<BindParameters extends unknown[] = unknown[], Result = unknown> {
    run(...params: BindParameters): { changes: number; lastInsertRowid: number | bigint };
    all(...params: BindParameters): Result[];
  }

  export default class Database {
    constructor(filename: string);
    pragma(source: string): unknown;
    exec(source: string): unknown;
    prepare<BindParameters extends unknown[] = unknown[], Result = unknown>(source: string): Statement<BindParameters, Result>;
    close(): void;
  }
}
