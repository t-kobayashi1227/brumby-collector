import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

export interface RawListingItem {
  listingId: string | null;
  listingUrl: string | null;
  addressRaw: string | null;
  priceText: string | null;
  landAreaText: string | null;
  buildingAreaText: string | null;
  layoutText: string | null;
  builtText: string | null;
  stationText: string | null;
}

export interface ParsedPage {
  recognized: boolean;
  noResults: boolean;
  items: RawListingItem[];
  hasNextPage: boolean;
}

export interface Row {
  fetched_on: string;
  listing_id: string;
  listing_url: string;
  city: string;
  ward: string;
  town: string;
  address_raw: string;
  price_man: string;
  land_area_m2: string;
  building_area_m2: string;
  layout: string;
  built_ym: string;
  station_raw: string;
  layout_rooms: string;
  layout_type: string;
  layout_storage: string;
  walk_minutes: string;
}

export const CSV_COLUMNS: (keyof Row)[] = [
  'fetched_on',
  'listing_id',
  'listing_url',
  'city',
  'ward',
  'town',
  'address_raw',
  'price_man',
  'land_area_m2',
  'building_area_m2',
  'layout',
  'built_ym',
  'station_raw',
  'layout_rooms',
  'layout_type',
  'layout_storage',
  'walk_minutes',
];

const NO_RESULTS_PHRASES = [
  '該当する物件はありませんでした',
  '該当する物件が見つかりませんでした',
  '条件に一致する物件が見つかりませんでした',
  '該当件数0件',
];

const LISTING_HREF_PATTERN = /\/nc_([A-Za-z0-9]+)\/?/;
const NEXT_PAGE_SELECTOR_TEXT = /^(次へ|次の\d+件|next)$/i;

const LABELS = {
  address: /^(所在地)$/,
  price: /^(価格|販売価格)$/,
  landArea: /^土地面積/,
  buildingArea: /^建物面積/,
  layout: /^間取り?$/,
  built: /^築年月$/,
  station: /^沿線[・･]?駅$|^最寄り?駅$/,
};

function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function findItemScope($: cheerio.CheerioAPI, anchor: AnyNode) {
  let current = $(anchor);
  let best = current;

  while (true) {
    const parent = current.parent();
    if (parent.length === 0 || parent.get(0)?.type !== 'tag') break;

    const distinctUrlsInParent = new Set<string>();
    parent.find('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const match = href.match(LISTING_HREF_PATTERN);
      if (match) distinctUrlsInParent.add(match[0]);
    });

    if (distinctUrlsInParent.size > 1) break;

    best = parent;
    current = parent;
    if (parent.get(0)?.tagName?.toLowerCase() === 'body') break;
  }

  return best;
}

function extractLabeledValue(
  $: cheerio.CheerioAPI,
  scope: cheerio.Cheerio<AnyNode>,
  labelPattern: RegExp
): string | null {
  let found: string | null = null;
  scope.find('dt, th').each((_, el) => {
    if (found !== null) return;
    const label = $(el).text().trim();
    if (!labelPattern.test(label)) return;
    const value = $(el).nextAll('dd, td').first();
    const text = value.length > 0 ? value.text().trim() : null;
    if (text) found = text;
  });
  return found;
}

// Some fields (e.g. 沿線・駅) can appear as several dt/dd pairs sharing the same
// label when a listing has multiple nearest stations, so collect all of them.
function extractAllLabeledValues(
  $: cheerio.CheerioAPI,
  scope: cheerio.Cheerio<AnyNode>,
  labelPattern: RegExp
): string[] {
  const values: string[] = [];
  scope.find('dt, th').each((_, el) => {
    const label = $(el).text().trim();
    if (!labelPattern.test(label)) return;
    const value = $(el).nextAll('dd, td').first();
    const text = value.length > 0 ? value.text().trim() : '';
    if (text) values.push(text);
  });
  return values;
}

export function parseListingPage(html: string, baseUrl: string, listPathPrefix: string): ParsedPage {
  const $ = cheerio.load(html);
  const bodyText = $('body').text();

  const noResults = NO_RESULTS_PHRASES.some((phrase) => bodyText.includes(phrase));

  // Pages also surface "recommended for you" widgets linking to unrelated
  // wards/areas that happen to match the nc_ID href pattern. Only hrefs under
  // this page's own list path are genuine items of the requested listing.
  const anchors = $('a[href]')
    .toArray()
    .filter((el) => {
      const href = $(el).attr('href');
      if (!href || !LISTING_HREF_PATTERN.test(href)) return false;
      const absolute = resolveUrl(href, baseUrl);
      if (!absolute) return false;
      return new URL(absolute).pathname.startsWith(listPathPrefix);
    });

  const seenUrls = new Set<string>();
  const uniqueAnchors: AnyNode[] = [];

  for (const el of anchors) {
    const href = $(el).attr('href')!;
    const absolute = resolveUrl(href, baseUrl);
    if (!absolute) continue;
    if (seenUrls.has(absolute)) continue;
    seenUrls.add(absolute);
    uniqueAnchors.push(el);
  }

  const items: RawListingItem[] = uniqueAnchors.map((anchor) => {
    const href = $(anchor).attr('href')!;
    const absoluteUrl = resolveUrl(href, baseUrl);
    const idMatch = href.match(LISTING_HREF_PATTERN);
    const listingId = idMatch ? idMatch[1] : null;

    const scope = findItemScope($, anchor);

    const addressRaw = extractLabeledValue($, scope, LABELS.address);
    const priceText = extractLabeledValue($, scope, LABELS.price);
    const landAreaText = extractLabeledValue($, scope, LABELS.landArea);
    const buildingAreaText = extractLabeledValue($, scope, LABELS.buildingArea);
    const layoutText = extractLabeledValue($, scope, LABELS.layout);
    const builtText = extractLabeledValue($, scope, LABELS.built);
    const stationValues = extractAllLabeledValues($, scope, LABELS.station);
    const stationText = stationValues.length > 0 ? stationValues.join('／') : null;

    return {
      listingId,
      listingUrl: absoluteUrl,
      stationText,
      addressRaw,
      priceText,
      landAreaText,
      buildingAreaText,
      layoutText,
      builtText,
    };
  });

  const hasNextPage =
    $('a')
      .toArray()
      .some((el) => NEXT_PAGE_SELECTOR_TEXT.test($(el).text().trim())) ||
    $('a[rel="next"]').length > 0;

  const recognized = items.length > 0 || noResults;

  return { recognized, noResults, items, hasNextPage };
}

const FULLWIDTH_DIGITS = '０１２３４５６７８９';

function toHalfWidthDigits(input: string): string {
  return input.replace(/[０-９]/g, (ch) => String(FULLWIDTH_DIGITS.indexOf(ch)));
}

export function parsePriceMan(text: string | null): number | null {
  if (!text) return null;
  const normalized = toHalfWidthDigits(text).replace(/,/g, '');
  const match = normalized.match(/(?:(\d+)億)?(?:(\d+)万)?円/);
  if (!match) return null;
  const oku = match[1] ? parseInt(match[1], 10) : 0;
  const man = match[2] ? parseInt(match[2], 10) : 0;
  if (!match[1] && !match[2]) return null;
  return oku * 10000 + man;
}

export function parseAreaM2(text: string | null): number | null {
  if (!text) return null;
  const normalized = toHalfWidthDigits(text).replace(/,/g, '');
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(?:m2|m²|㎡)/i);
  if (!match) return null;
  return parseFloat(match[1]);
}

export function parseBuiltYm(text: string | null): string | null {
  if (!text) return null;
  const normalized = toHalfWidthDigits(text);
  const match = normalized.match(/(\d{4})年\s*(\d{1,2})月/);
  if (!match) return null;
  const year = match[1];
  const month = match[2].padStart(2, '0');
  return `${year}-${month}`;
}

export interface Layout {
  rooms: number;
  type: string;
  storage: number;
}

// NFKC folds full-width forms (４ＬＤＫ＋Ｓ) into ASCII so one pattern covers both.
// "S" counts 納戸 separately: it is not a legal living room, so it is kept out of rooms.
const LAYOUT_PATTERN = /^(?:(\d+)([LDK]+)|ワンルーム)(?:\+(\d*)S)?/;

export function parseLayout(text: string | null): Layout | null {
  if (!text) return null;
  const match = text.normalize('NFKC').trim().match(LAYOUT_PATTERN);
  if (!match) return null;
  const storage = match[3] === undefined ? 0 : match[3] === '' ? 1 : parseInt(match[3], 10);
  if (match[1] === undefined) {
    return { rooms: 1, type: 'R', storage };
  }
  return { rooms: parseInt(match[1], 10), type: match[2], storage };
}

// Only plain 徒歩 entries count. "バスN分停歩N分" (walk from a bus stop after a ride)
// and "車Nkm" are not walking distance from the station, so they are ignored.
// Note: entries for bus lines (e.g. 新潟交通「…」徒歩3分) are included as SUUMO lists them.
export function parseWalkMinutes(text: string | null): number | null {
  if (!text) return null;
  let best: number | null = null;
  for (const entry of text.normalize('NFKC').split('/')) {
    const match = entry.match(/徒歩(\d+)分/);
    if (!match) continue;
    const minutes = parseInt(match[1], 10);
    if (best === null || minutes < best) best = minutes;
  }
  return best;
}

const DIGIT_PATTERN = /[0-9０-９]/;

export function extractTown(addressRaw: string | null, cityWardPrefix: string): string | null {
  if (!addressRaw) return null;
  const prefixIndex = addressRaw.indexOf(cityWardPrefix);
  if (prefixIndex === -1) return null;
  const remainder = addressRaw.slice(prefixIndex + cityWardPrefix.length).trim();
  if (!remainder) return null;

  const chomeMatch = remainder.match(/^(.+?)[0-9０-９]+丁目/);
  if (chomeMatch) {
    const town = chomeMatch[1].trim();
    return town || null;
  }

  if (!DIGIT_PATTERN.test(remainder)) {
    return remainder;
  }

  // Digits present but no explicit 丁目 marker: cannot safely tell whether the
  // digit belongs to the town name or is a block/lot number, so leave blank.
  return null;
}

export function matchesCityWard(addressRaw: string | null, cityWardPrefix: string): boolean {
  if (!addressRaw) return false;
  return addressRaw.includes(cityWardPrefix);
}

export interface BuildRowContext {
  fetchedOn: string;
  city: string;
  ward: string;
}

export type BuildRowResult =
  | { status: 'ok'; row: Row }
  | { status: 'skip_no_id' }
  | { status: 'skip_no_data' }
  | { status: 'exclude_area' };

export function buildRow(item: RawListingItem, ctx: BuildRowContext): BuildRowResult {
  if (!item.listingId || !item.listingUrl) {
    return { status: 'skip_no_id' };
  }

  // Recommendation-widget links (e.g. "こんな物件も見られています") match the same
  // detail-link pattern but carry no address/price text at all, so they are not
  // genuine entries of the requested listing.
  if (!item.addressRaw && !item.priceText) {
    return { status: 'skip_no_data' };
  }

  const cityWardPrefix = `${ctx.city}${ctx.ward}`;
  if (item.addressRaw && !matchesCityWard(item.addressRaw, cityWardPrefix)) {
    return { status: 'exclude_area' };
  }

  const town = extractTown(item.addressRaw, cityWardPrefix);
  const priceMan = parsePriceMan(item.priceText);
  const landArea = parseAreaM2(item.landAreaText);
  const buildingArea = parseAreaM2(item.buildingAreaText);
  const builtYm = parseBuiltYm(item.builtText);
  const layout = parseLayout(item.layoutText);
  const walkMinutes = parseWalkMinutes(item.stationText);

  const row: Row = {
    fetched_on: ctx.fetchedOn,
    listing_id: item.listingId,
    listing_url: item.listingUrl,
    city: ctx.city,
    ward: ctx.ward,
    town: town ?? '',
    address_raw: item.addressRaw ?? '',
    price_man: priceMan !== null ? String(priceMan) : '',
    land_area_m2: landArea !== null ? String(landArea) : '',
    building_area_m2: buildingArea !== null ? String(buildingArea) : '',
    layout: item.layoutText ?? '',
    built_ym: builtYm ?? '',
    station_raw: item.stationText ?? '',
    layout_rooms: layout ? String(layout.rooms) : '',
    layout_type: layout ? layout.type : '',
    layout_storage: layout ? String(layout.storage) : '',
    walk_minutes: walkMinutes !== null ? String(walkMinutes) : '',
  };

  return { status: 'ok', row };
}

export interface DedupeResult {
  items: RawListingItem[];
  duplicateCount: number;
}

export function dedupeByListingId(items: RawListingItem[]): DedupeResult {
  const seen = new Set<string>();
  const result: RawListingItem[] = [];
  let duplicateCount = 0;

  for (const item of items) {
    if (!item.listingId) {
      result.push(item);
      continue;
    }
    if (seen.has(item.listingId)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(item.listingId);
    result.push(item);
  }

  return { items: result, duplicateCount };
}
