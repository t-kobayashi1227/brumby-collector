import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRow,
  dedupeByListingId,
  extractTown,
  parseAreaM2,
  parseBuiltYm,
  parseLayout,
  parseListingPage,
  parsePriceMan,
  parseWalkMinutes,
  type RawListingItem,
} from '../lib/suumo/parse';

const BASE_URL = 'https://suumo.jp';
const LIST_PATH = '/chukoikkodate/niigata/sc_niigatashichuo/';
const FIXTURES_DIR = join(__dirname, 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

describe('parseListingPage', () => {
  it('通常の掲載一覧を解析できる', () => {
    const html = loadFixture('listing-normal.html');
    const result = parseListingPage(html, BASE_URL, LIST_PATH);

    expect(result.recognized).toBe(true);
    expect(result.noResults).toBe(false);
    expect(result.hasNextPage).toBe(true);
    expect(result.items).toHaveLength(5);

    const first = result.items[0];
    expect(first.listingId).toBe('1001');
    expect(first.listingUrl).toBe(
      'https://suumo.jp/chukoikkodate/niigata/sc_niigatashichuo/nc_1001/'
    );
    expect(first.addressRaw).toBe('新潟市中央区東大通1丁目1-1');
    expect(first.priceText).toBe('2,480万円');
    expect(first.landAreaText).toBe('150.5m²');
    expect(first.buildingAreaText).toBe('98.2m²');
    expect(first.layoutText).toBe('4LDK');
    expect(first.builtText).toBe('1998年5月');
    expect(first.stationText).toBe('JR白新線「新潟」徒歩12分');
  });

  it('沿線・駅が複数ある場合はまとめて抽出する', () => {
    const html = loadFixture('listing-normal.html');
    const result = parseListingPage(html, BASE_URL, LIST_PATH);
    const fourth = result.items[3];

    expect(fourth.stationText).toBe(
      'JR信越本線「新潟」徒歩20分／新潟交通バス「市役所前」徒歩2分'
    );
  });

  it('一部項目が欠損している掲載は欠損のまま抽出する', () => {
    const html = loadFixture('listing-normal.html');
    const result = parseListingPage(html, BASE_URL, LIST_PATH);
    const second = result.items[1];

    expect(second.buildingAreaText).toBeNull();
    expect(second.builtText).toBeNull();
    expect(second.landAreaText).toBe('0m²');
  });

  it('該当物件なしのページを正しく判定する', () => {
    const html = loadFixture('listing-no-results.html');
    const result = parseListingPage(html, BASE_URL, LIST_PATH);

    expect(result.recognized).toBe(true);
    expect(result.noResults).toBe(true);
    expect(result.items).toHaveLength(0);
  });

  it('認識できない構造のページは解析失敗として扱う', () => {
    const html = loadFixture('listing-unrecognized.html');
    const result = parseListingPage(html, BASE_URL, LIST_PATH);

    expect(result.recognized).toBe(false);
    expect(result.noResults).toBe(false);
    expect(result.items).toHaveLength(0);
  });

  it('次ページリンクがない場合は hasNextPage が false になる', () => {
    const html = loadFixture('listing-last-page.html');
    const result = parseListingPage(html, BASE_URL, LIST_PATH);

    expect(result.hasNextPage).toBe(false);
    expect(result.items).toHaveLength(1);
  });

  it('別区・別エリアへのおすすめウィジェットリンクは対象外として除外する', () => {
    const html = loadFixture('listing-with-widget-links.html');
    const result = parseListingPage(html, BASE_URL, LIST_PATH);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].listingId).toBe('3001');
  });
});

describe('parsePriceMan', () => {
  it('万円表記を整数に変換する', () => {
    expect(parsePriceMan('2,480万円')).toBe(2480);
  });

  it('億を含む価格を万円単位に変換する', () => {
    expect(parsePriceMan('1億2,000万円')).toBe(12000);
  });

  it('価格が確定できない表記は null を返す', () => {
    expect(parsePriceMan('応談')).toBeNull();
    expect(parsePriceMan(null)).toBeNull();
  });
});

describe('parseAreaM2', () => {
  it('㎡表記を数値に変換する', () => {
    expect(parseAreaM2('150.5m²')).toBe(150.5);
  });

  it('0は欠損ではなくそのまま保持する', () => {
    expect(parseAreaM2('0m²')).toBe(0);
  });

  it('値が取れない場合は null を返す', () => {
    expect(parseAreaM2(null)).toBeNull();
    expect(parseAreaM2('不明')).toBeNull();
  });
});

describe('parseBuiltYm', () => {
  it('年月を YYYY-MM 形式に変換する', () => {
    expect(parseBuiltYm('1998年5月')).toBe('1998-05');
  });

  it('年月が揃わない場合は null を返す', () => {
    expect(parseBuiltYm('新築')).toBeNull();
    expect(parseBuiltYm(null)).toBeNull();
  });
});

describe('parseLayout', () => {
  it('部屋数とタイプに分ける', () => {
    expect(parseLayout('4LDK')).toEqual({ rooms: 4, type: 'LDK', storage: 0 });
    expect(parseLayout('7DK')).toEqual({ rooms: 7, type: 'DK', storage: 0 });
    expect(parseLayout('3K')).toEqual({ rooms: 3, type: 'K', storage: 0 });
  });

  it('納戸（S）は部屋数に含めず納戸数として分ける', () => {
    expect(parseLayout('4LDK+S（納戸）')).toEqual({ rooms: 4, type: 'LDK', storage: 1 });
    expect(parseLayout('4LDK+2S（納戸）')).toEqual({ rooms: 4, type: 'LDK', storage: 2 });
  });

  it('二世帯向けの LLDDKK などはタイプをそのまま保持する', () => {
    expect(parseLayout('6LLDDKK+S（納戸）')).toEqual({ rooms: 6, type: 'LLDDKK', storage: 1 });
    expect(parseLayout('4LDKK+2S（納戸）')).toEqual({ rooms: 4, type: 'LDKK', storage: 2 });
  });

  it('ワンルームは1部屋・タイプRとして扱う', () => {
    expect(parseLayout('ワンルーム')).toEqual({ rooms: 1, type: 'R', storage: 0 });
    expect(parseLayout('ワンルーム+S（納戸）')).toEqual({ rooms: 1, type: 'R', storage: 1 });
  });

  it('全角表記も変換する', () => {
    expect(parseLayout('４ＬＤＫ＋Ｓ（納戸）')).toEqual({ rooms: 4, type: 'LDK', storage: 1 });
  });

  it('解釈できない表記は null を返す', () => {
    expect(parseLayout('その他')).toBeNull();
    expect(parseLayout(null)).toBeNull();
  });
});

describe('parseWalkMinutes', () => {
  it('徒歩の分数を返す', () => {
    expect(parseWalkMinutes('ＪＲ信越本線「新潟」徒歩42分')).toBe(42);
  });

  it('複数ある場合は最も短い徒歩分数を返す', () => {
    expect(parseWalkMinutes('JR白新線「新潟」徒歩12分／新潟交通バス「東大通」徒歩3分')).toBe(3);
  });

  it('バス利用・車での距離は徒歩分数として扱わない', () => {
    expect(parseWalkMinutes('ＪＲ越後線「新潟」バス20分停歩4分')).toBeNull();
    expect(parseWalkMinutes('ＪＲ白新線「新潟」車2.6km')).toBeNull();
    expect(parseWalkMinutes('ＪＲ越後線「新潟」バス20分停歩4分／新潟交通「白山前」徒歩9分')).toBe(9);
  });

  it('値が取れない場合は null を返す', () => {
    expect(parseWalkMinutes(null)).toBeNull();
    expect(parseWalkMinutes('')).toBeNull();
  });
});

describe('extractTown', () => {
  const prefix = '新潟市中央区';

  it('丁目表記があれば町名のみを抽出する', () => {
    expect(extractTown('新潟市中央区東大通1丁目1-1', prefix)).toBe('東大通');
  });

  it('漢数字など数字を含まない町名はそのまま抽出する', () => {
    expect(extractTown('新潟市中央区営所通二番町', prefix)).toBe('営所通二番町');
  });

  it('丁目表記がなく数字が末尾にある場合は町名か判断できないため空とする', () => {
    expect(extractTown('新潟市中央区上所2', prefix)).toBeNull();
  });

  it('対象の市区と異なる場合は null を返す', () => {
    expect(extractTown('新潟市東区山木戸1丁目', prefix)).toBeNull();
  });

  it('先頭に都道府県名が付いていても市区は無視して町名を抽出する', () => {
    expect(extractTown('新潟県新潟市中央区東大通1丁目1-1', prefix)).toBe('東大通');
  });
});

describe('buildRow', () => {
  const ctx = { fetchedOn: '2026-11-20', city: '新潟市', ward: '中央区' };

  it('IDが取れない掲載は skip_no_id を返す', () => {
    const item: RawListingItem = {
      listingId: null,
      listingUrl: null,
      addressRaw: '新潟市中央区東大通1丁目1-1',
      priceText: '2,480万円',
      landAreaText: '100m²',
      buildingAreaText: '80m²',
      layoutText: '3LDK',
      builtText: '2000年1月',
      stationText: 'JR信越本線「新潟」徒歩10分',
    };
    expect(buildRow(item, ctx)).toEqual({ status: 'skip_no_id' });
  });

  it('所在地も価格も取れないウィジェットリンク等は skip_no_data を返す', () => {
    const item: RawListingItem = {
      listingId: '9101',
      listingUrl: 'https://suumo.jp/chukoikkodate/niigata/sc_niigatashichuo/nc_9101/?fmlg=bo001',
      addressRaw: null,
      priceText: null,
      landAreaText: null,
      buildingAreaText: null,
      layoutText: null,
      builtText: null,
      stationText: null,
    };
    expect(buildRow(item, ctx)).toEqual({ status: 'skip_no_data' });
  });

  it('対象外の区の掲載は exclude_area を返す', () => {
    const item: RawListingItem = {
      listingId: '9001',
      listingUrl: 'https://suumo.jp/chukoikkodate/niigata/sc_higashi/nc_9001/',
      addressRaw: '新潟市東区山木戸1丁目',
      priceText: '1,800万円',
      landAreaText: '110m²',
      buildingAreaText: '75m²',
      layoutText: '3LDK',
      builtText: '2001年1月',
      stationText: 'JR白新線「東新潟」徒歩8分',
    };
    expect(buildRow(item, ctx)).toEqual({ status: 'exclude_area' });
  });

  it('所在地に都道府県名が前置されていても対象区として扱う', () => {
    const item: RawListingItem = {
      listingId: '9002',
      listingUrl: 'https://suumo.jp/chukoikkodate/niigata/sc_niigatashichuo/nc_9002/',
      addressRaw: '新潟県新潟市中央区浮洲町',
      priceText: '320万円',
      landAreaText: '80.53m²',
      buildingAreaText: '90.44m²',
      layoutText: '3LDK',
      builtText: '1929年1月',
      stationText: 'JR信越本線「新潟」徒歩42分',
    };
    const result = buildRow(item, ctx);
    expect(result.status).toBe('ok');
  });

  it('正常な掲載は行データを生成する', () => {
    const item: RawListingItem = {
      listingId: '1001',
      listingUrl: 'https://suumo.jp/chukoikkodate/niigata/sc_niigatashichuo/nc_1001/',
      addressRaw: '新潟市中央区東大通1丁目1-1',
      priceText: '2,480万円',
      landAreaText: '150.5m²',
      buildingAreaText: '98.2m²',
      layoutText: '4LDK',
      builtText: '1998年5月',
      stationText: 'JR白新線「新潟」徒歩12分／新潟交通バス「東大通」徒歩3分',
    };
    const result = buildRow(item, ctx);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.row).toEqual({
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
        station_raw: 'JR白新線「新潟」徒歩12分／新潟交通バス「東大通」徒歩3分',
        layout_rooms: '4',
        layout_type: 'LDK',
        layout_storage: '0',
        walk_minutes: '3',
      });
    }
  });
});

describe('dedupeByListingId', () => {
  it('同じIDの掲載は最初の1件だけ残す', () => {
    const items: RawListingItem[] = [
      {
        listingId: '1001',
        listingUrl: 'https://suumo.jp/.../nc_1001/',
        addressRaw: null,
        priceText: '2,480万円',
        landAreaText: null,
        buildingAreaText: null,
        layoutText: null,
        builtText: null,
        stationText: null,
      },
      {
        listingId: '1002',
        listingUrl: 'https://suumo.jp/.../nc_1002/',
        addressRaw: null,
        priceText: null,
        landAreaText: null,
        buildingAreaText: null,
        layoutText: null,
        builtText: null,
        stationText: null,
      },
      {
        listingId: '1001',
        listingUrl: 'https://suumo.jp/.../nc_1001/',
        addressRaw: null,
        priceText: '9,999万円',
        landAreaText: null,
        buildingAreaText: null,
        layoutText: null,
        builtText: null,
        stationText: null,
      },
    ];

    const result = dedupeByListingId(items);
    expect(result.duplicateCount).toBe(1);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].priceText).toBe('2,480万円');
  });
});
