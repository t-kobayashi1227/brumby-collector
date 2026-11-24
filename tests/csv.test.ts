import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeCsvField, rowsToCsv, writeCsvFile } from '../lib/suumo/csv';
import type { Row } from '../lib/suumo/parse';

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    fetched_on: '2026-11-20',
    listing_id: '1001',
    listing_url: 'https://suumo.jp/chukoikkodate/niigata/sc_niigatashichuo/nc_1001/',
    city: '新潟市',
    ward: '中央区',
    town: '東大通',
    address_raw: '新潟市中央区東大通1丁目1-1',
    price_man: '2480',
    land_area_m2: '150.5',
    building_area_m2: '98.2',
    layout: '4LDK',
    built_ym: '1998-05',
    station_raw: 'JR信越本線「新潟」徒歩15分',
    ...overrides,
  };
}

describe('escapeCsvField', () => {
  it('カンマを含む値は引用符で囲む', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
  });

  it('ダブルクォートを含む値はエスケープして引用符で囲む', () => {
    expect(escapeCsvField('a"b')).toBe('"a""b"');
  });

  it('改行を含む値は引用符で囲む', () => {
    expect(escapeCsvField('a\nb')).toBe('"a\nb"');
  });

  it('特殊文字がない値はそのまま返す', () => {
    expect(escapeCsvField('abc')).toBe('abc');
  });

  it('空文字はそのまま空文字を返す', () => {
    expect(escapeCsvField('')).toBe('');
  });
});

describe('rowsToCsv', () => {
  it('ヘッダー行と指定した列順でCSVを生成する', () => {
    const csv = rowsToCsv([makeRow()]);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(
      'fetched_on,listing_id,listing_url,city,ward,town,address_raw,price_man,land_area_m2,building_area_m2,layout,built_ym,station_raw'
    );
    expect(lines[1]).toContain('2480');
  });

  it('欠損値は0に変換せず空文字のまま出力する', () => {
    const csv = rowsToCsv([makeRow({ building_area_m2: '', built_ym: '' })]);
    const fields = csv.split('\r\n')[1].split(',');
    // building_area_m2 is the 10th column (index 9), built_ym is the last (index 11)
    expect(fields[9]).toBe('');
    expect(fields[11]).toBe('');
  });

  it('0は欠損と区別して出力する', () => {
    const csv = rowsToCsv([makeRow({ land_area_m2: '0' })]);
    const fields = csv.split('\r\n')[1].split(',');
    expect(fields[8]).toBe('0');
  });

  it('カンマや改行を含む所在地もCSVとして正しくエスケープする', () => {
    const csv = rowsToCsv([
      makeRow({ address_raw: '新潟市中央区東大通1丁目1-1、2号棟\n（角地）' }),
    ]);
    expect(csv).toContain('"新潟市中央区東大通1丁目1-1、2号棟\n（角地）"');
  });

  it('ヘッダーのみの場合は0件でも正常にCSVを生成する', () => {
    const csv = rowsToCsv([]);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(1);
  });
});

describe('writeCsvFile', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('BOM付きUTF-8でファイルを書き出す', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'suumo-csv-test-'));
    const filePath = join(tmpDir, 'out.csv');
    writeCsvFile(filePath, [makeRow()]);

    const buffer = readFileSync(filePath);
    expect(buffer[0]).toBe(0xef);
    expect(buffer[1]).toBe(0xbb);
    expect(buffer[2]).toBe(0xbf);

    const text = readFileSync(filePath, 'utf8');
    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain('listing_id');
  });
});
