import { join } from 'node:path';
import {
  checkRobotsAllowed,
  fetchPage,
  getUserAgent,
  FETCH_UA_EXAMPLE,
} from '../lib/suumo/fetch';
import {
  buildRow,
  dedupeByListingId,
  parseListingPage,
  CSV_COLUMNS,
  type RawListingItem,
  type Row,
} from '../lib/suumo/parse';
import { writeCsvFile } from '../lib/suumo/csv';

const BASE_URL = 'https://suumo.jp';
const LIST_PATH = '/chukoikkodate/niigata/sc_niigatashichuo/';
const CITY = '新潟市';
const WARD = '中央区';
const DATA_DIR = join(__dirname, '..', 'data');

const MAX_PAGES_DEFAULT = 10;

function getMaxPages(): number {
  const raw = process.env.MAX_PAGES;
  if (!raw) return MAX_PAGES_DEFAULT;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return MAX_PAGES_DEFAULT;
  return parsed;
}

function getJstDateString(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function pageUrl(page: number): string {
  if (page <= 1) return new URL(LIST_PATH, BASE_URL).toString();
  return new URL(`${LIST_PATH}?page=${page}`, BASE_URL).toString();
}

type StopReason =
  | 'max_pages_reached'
  | 'last_page_reached'
  | 'no_results'
  | 'blocked'
  | 'fetch_error'
  | 'parse_unrecognized'
  | 'robots_disallowed'
  | 'robots_unreachable'
  | 'missing_ua';

interface RunSummary {
  pagesFetched: number;
  stopReason: StopReason;
  stopDetail?: string;
  rawItems: RawListingItem[];
  sawNoResults: boolean;
}

async function runCollection(userAgent: string): Promise<RunSummary> {
  const maxPages = getMaxPages();
  const rawItems: RawListingItem[] = [];
  let sawNoResults = false;
  let pagesFetched = 0;
  let stopReason: StopReason = 'last_page_reached';
  let stopDetail: string | undefined;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = pageUrl(page);
    const result = await fetchPage(url, userAgent);

    if (result.status === 'blocked') {
      stopReason = 'blocked';
      stopDetail = result.reason;
      break;
    }
    if (result.status === 'error') {
      stopReason = 'fetch_error';
      stopDetail = result.reason;
      break;
    }

    pagesFetched += 1;
    const parsed = parseListingPage(result.html, BASE_URL, LIST_PATH);

    if (!parsed.recognized) {
      stopReason = 'parse_unrecognized';
      stopDetail = `${page}ページ目の一覧構造を認識できませんでした`;
      break;
    }

    if (parsed.noResults) {
      sawNoResults = true;
      stopReason = 'no_results';
      break;
    }

    rawItems.push(...parsed.items);

    if (!parsed.hasNextPage) {
      stopReason = 'last_page_reached';
      break;
    }
    if (page === maxPages) {
      stopReason = 'max_pages_reached';
      break;
    }
  }

  return { pagesFetched, stopReason, stopDetail, rawItems, sawNoResults };
}

function formatStopReason(reason: StopReason, detail?: string): string {
  switch (reason) {
    case 'max_pages_reached':
      return 'MAX_PAGESの上限に到達しました';
    case 'last_page_reached':
      return '最終ページに到達しました（次ページなし）';
    case 'no_results':
      return '先頭ページで「該当物件なし」と判定されました';
    case 'blocked':
      return `403/429/CAPTCHA等を検知したため中止しました（${detail ?? ''}）`;
    case 'fetch_error':
      return `通信エラーのため中止しました（${detail ?? ''}）`;
    case 'parse_unrecognized':
      return `一覧構造を認識できなかったため中止しました（${detail ?? ''}）`;
    case 'robots_disallowed':
      return `robots.txtにより対象パスが禁止されています（${detail ?? ''}）`;
    case 'robots_unreachable':
      return `robots.txtを取得できずルールを確認できませんでした（${detail ?? ''}）`;
    case 'missing_ua':
      return 'FETCH_UAが未設定のため通信しませんでした';
    default:
      return reason;
  }
}

async function main(): Promise<number> {
  const userAgent = getUserAgent();
  if (!userAgent) {
    console.log('環境変数 FETCH_UA が未設定です。通信は行いません。');
    console.log('設定例:');
    console.log(`  ${FETCH_UA_EXAMPLE}`);
    return 1;
  }

  const robotsCheck = await checkRobotsAllowed(BASE_URL, [LIST_PATH], userAgent);
  if (!robotsCheck.allowed) {
    const reason = robotsCheck.reason === 'disallowed' ? 'robots_disallowed' : 'robots_unreachable';
    console.log(formatStopReason(reason, robotsCheck.detail));
    return 1;
  }

  const summary = await runCollection(userAgent);

  const dedup = dedupeByListingId(summary.rawItems);
  const fetchedOn = getJstDateString();
  const ctx = { fetchedOn, city: CITY, ward: WARD };

  const rows: Row[] = [];
  let skippedNoId = 0;
  let skippedNoData = 0;
  let excludedArea = 0;

  for (const item of dedup.items) {
    const result = buildRow(item, ctx);
    if (result.status === 'ok') {
      rows.push(result.row);
    } else if (result.status === 'skip_no_id') {
      skippedNoId += 1;
    } else if (result.status === 'skip_no_data') {
      skippedNoData += 1;
    } else if (result.status === 'exclude_area') {
      excludedArea += 1;
    }
  }

  const hadAnyRawItems = summary.rawItems.length > 0;
  const zeroValidDespiteListings = hadAnyRawItems && rows.length === 0 && !summary.sawNoResults;
  const NORMAL_STOP_REASONS: StopReason[] = ['max_pages_reached', 'last_page_reached', 'no_results'];
  const stoppedNormally = NORMAL_STOP_REASONS.includes(summary.stopReason);

  const missingCounts: Record<string, number> = {
    town: 0,
    price_man: 0,
    land_area_m2: 0,
    building_area_m2: 0,
    layout: 0,
    built_ym: 0,
    station_raw: 0,
    layout_rooms: 0,
    walk_minutes: 0,
  };
  for (const row of rows) {
    for (const key of Object.keys(missingCounts)) {
      if (row[key as keyof Row] === '') missingCounts[key] += 1;
    }
  }

  console.log('--- 実行結果 ---');
  console.log(`取得ページ数: ${summary.pagesFetched}`);
  console.log(`出力件数: ${rows.length}`);
  console.log(`重複件数: ${dedup.duplicateCount}`);
  console.log(`スキップ件数（ID不明）: ${skippedNoId}`);
  console.log(`スキップ件数（データなし・ウィジェットリンク等）: ${skippedNoData}`);
  console.log(`除外件数（対象区外）: ${excludedArea}`);
  console.log('出力行の項目別欠損数:');
  for (const [key, count] of Object.entries(missingCounts)) {
    console.log(`  ${key}: ${count}`);
  }
  console.log(`終了理由: ${formatStopReason(summary.stopReason, summary.stopDetail)}`);

  const success = stoppedNormally && !zeroValidDespiteListings;

  if (success) {
    const fileName = `niigata_used_houses_${fetchedOn}.csv`;
    const filePath = join(DATA_DIR, fileName);
    writeCsvFile(filePath, rows);
    console.log(`出力先: ${filePath}`);
    console.log(`CSV列: ${CSV_COLUMNS.join(',')}`);
    return 0;
  }

  if (rows.length > 0) {
    const fileName = `niigata_used_houses_${fetchedOn}_partial.csv`;
    const filePath = join(DATA_DIR, fileName);
    writeCsvFile(filePath, rows);
    console.log(`途中失敗のため部分出力しました: ${filePath}`);
  } else {
    console.log('有効な行が1件もないため、CSVは出力しませんでした。');
  }
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('予期しないエラーが発生しました:', err);
    process.exitCode = 1;
  });
