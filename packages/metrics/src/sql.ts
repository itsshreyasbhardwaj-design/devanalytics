import type { SqlParam } from '@devanalytics/db';

/** Positional parameter builder. Nothing user-supplied is ever interpolated. */
export class Params {
  private readonly values: SqlParam[] = [];

  add(value: SqlParam): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  get all(): SqlParam[] {
    return [...this.values];
  }
}

export interface FactQuery {
  text: string;
  params: SqlParam[];
}

export const HOURS = (a: string, b: string) => `(extract(epoch from (${a} - ${b})) / 3600.0)`;
export const MINUTES = (a: string, b: string) => `(extract(epoch from (${a} - ${b})) / 60.0)`;
