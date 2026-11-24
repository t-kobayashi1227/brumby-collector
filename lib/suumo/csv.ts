import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CSV_COLUMNS, type Row } from './parse';

const BOM = '﻿';
const LINE_ENDING = '\r\n';

export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function rowsToCsv(rows: Row[]): string {
  const header = CSV_COLUMNS.join(',');
  const lines = rows.map((row) =>
    CSV_COLUMNS.map((col) => escapeCsvField(row[col] ?? '')).join(',')
  );
  return [header, ...lines].join(LINE_ENDING) + LINE_ENDING;
}

export function writeCsvFile(filePath: string, rows: Row[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const csv = rowsToCsv(rows);
  writeFileSync(filePath, BOM + csv, 'utf8');
}
