(() => {
  'use strict';

  const stationHeaders = '주유소명,시도명,시군구명,소재지도로명주소,소재지지번주소,전화번호,위도,경도,상표구분명,대표자명,총직원수,데이터기준일자,제공기관코드,제공기관명'.split(',');
  const fuels = ['고급휘발유', '휘발유', '경유', '실내등유'];
  const priceHeaders = ['번호', '지역', '상호', '주소', '기간', '상표', '셀프여부', ...fuels];
  const aliases = {
    11: '서울', 12: '전남광주 전라남도 전남 광주 광주광역시', 26: '부산', 27: '대구',
    28: '인천', 30: '대전', 31: '울산', 36: '세종 세종시', 41: '경기',
    43: '충북', 44: '충남', 47: '경북', 48: '경남', 50: '제주 제주도',
    51: '강원 강원도', 52: '전북 전라북도'
  };
  const compact = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '');
  const dateLabel = date => date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const byCode = new Map();
  const byAlias = new Map();
  const districtsByProvince = new Map();
  const regionCache = new Map();

  for (const province of FuelRegions) {
    byCode.set(province.code, province);
    const names = [province.name, ...aliases[province.code].split(' ')];
    for (const name of names) byAlias.set(compact(name), province);
    const districts = new Map();
    const parents = new Map();
    for (const district of [...province.districts]) {
      const parentName = district.name.match(/^(.+?시)\s*.+구$/)?.[1];
      Object.assign(district, { province: province.code, parts: [district.code] });
      if (parentName) {
        if (!parents.has(parentName)) {
          parents.set(parentName, {
            code: `${province.code}-${parentName}`, name: parentName, province: province.code, parts: []
          });
        }
        const parent = parents.get(parentName);
        parent.parts.push(district.code);
        district.parent = parent.code;
      }
    }
    province.districts.push(...parents.values());
    for (const district of province.districts) {
      districts.set(compact(district.name), district);
      byCode.set(district.code, district);
    }
    province.districts.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    districtsByProvince.set(province.code, districts);
  }

  const allPrefixes = [...byAlias.keys()].sort((a, b) => b.length - a.length);

  function districtFor(province, name, address) {
    if (!province) return undefined;
    if (province.code === '36' && ['', '없음', '세종시'].includes(name)) {
      return province.districts[0];
    }
    const districts = districtsByProvince.get(province.code);
    const district = districts.get(name);
    if (!district || district.parts.length < 2) return district;
    const addressKey = compact(address);
    const prefix = allPrefixes.find(candidate => addressKey.startsWith(candidate));
    const locality = prefix ? addressKey.slice(prefix.length) : addressKey;
    return district.parts.map(code => byCode.get(code))
      .find(child => locality.startsWith(compact(child.name))) ?? district;
  }

  function resolveRegion(kind, values, address) {
    const station = kind === 'stations';
    const provinceName = station ? compact(values('시도명')) : '';
    const districtName = station ? compact(values('시군구명')) : '';
    const priceRegion = station ? '' : compact(values('지역'));
    const key = station ? `s:${provinceName}|${districtName}` : `p:${priceRegion}`;
    if (!regionCache.has(key)) {
      const prefix = station ? provinceName : allPrefixes.find(name => priceRegion.startsWith(name));
      const province = byAlias.get(prefix);
      const name = station ? districtName : priceRegion.slice(prefix?.length ?? 0);
      regionCache.set(key, districtFor(province, name, ''));
    }
    const district = regionCache.get(key);
    if (district?.parts.length > 1) {
      return districtFor(byCode.get(district.province), compact(district.name), address);
    }
    return district;
  }

  function decodeCsv(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('euc-kr', { fatal: true }).decode(bytes);
    }
  }

  function* csvRows(text) {
    let values = [];
    let field = '';
    let line = 1;
    let startLine = 1;
    let quoted = false;
    let closed = false;
    let invalid = false;
    for (let offset = 0; offset < text.length; offset++) {
      const character = text[offset];
      if (quoted) {
        if (character === '"' && text[offset + 1] === '"') {
          field += '"';
          offset++;
        } else if (character === '"') {
          quoted = false;
          closed = true;
        } else {
          field += character;
          if (character === '\n' || (character === '\r' && text[offset + 1] !== '\n')) line++;
        }
      } else if (character === ',' || character === '\r' || character === '\n') {
        values.push(field);
        field = '';
        closed = false;
        if (character === ',') continue;
        yield { values, line: startLine, invalid };
        if (character === '\r' && text[offset + 1] === '\n') offset++;
        startLine = ++line;
        values = [];
        invalid = false;
      } else if (character === '"' && !field && !closed) {
        quoted = true;
      } else {
        if (closed || character === '"') invalid = true;
        field += character;
      }
    }
    if (values.length || field || closed || quoted) {
      yield { values: [...values, field], line: startLine, invalid: invalid || quoted };
    }
  }

  function validDate(value) {
    if (!/^\d{8}$/.test(value)) return false;
    const iso = dateLabel(value);
    const date = new Date(iso + 'T00:00:00Z');
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso;
  }

  function coordinates(longitude, latitude) {
    const lon = Number(longitude);
    const lat = Number(latitude);
    if (!longitude.trim() || !latitude.trim() || !Number.isFinite(lon) || !Number.isFinite(lat)
        || Math.abs(lon) > 180 || Math.abs(lat) > 90 || (lon === 0 && lat === 0)) return undefined;
    return [lon * Math.cos(Math.PI / 5) * 10000, -lat * 10000];
  }

  function parseDataset(input, kind) {
    const station = kind === 'stations';
    const label = station ? '주유소 자료' : '판매가격 자료';
    const oppositeLabel = station ? '판매가격 자료' : '주유소 자료';
    const required = station ? stationHeaders : priceHeaders;
    const opposite = station ? priceHeaders : stationHeaders;
    const records = csvRows(input.replace(/^\uFEFF/, ''));
    const first = records.next().value;
    if (!first || first.invalid) throw new Error(`${label}의 CSV 헤더를 읽을 수 없습니다.`);
    const header = first.values;
    const fields = header.map(value => value.trim());
    if (opposite.every(name => fields.includes(name))) {
      throw new Error(`${label} 입력란에서 ${oppositeLabel}를 읽었습니다. ${label} CSV를 다시 선택하세요.`);
    }
    const missing = required.filter(name => !fields.includes(name));
    if (missing.length) throw new Error(`${label} 필수 열 누락 — ${missing.join(', ')}`);
    if (new Set(fields).size !== fields.length) throw new Error(`${label}에 중복 열 이름이 있습니다.`);
    const indexes = new Map(fields.map((name, index) => [name, index]));
    const rows = [];
    const issues = [];
    let metadata;
    let unknown = 0;
    let noCoordinates = 0;
    for (const record of records) {
      const { values, line } = record;
      if (values.length === 1 && !values[0].trim()) continue;
      if (!station && !record.invalid && values.length === 1 && /^\s*기준\s*:/.test(values[0]) && !rows.length && !metadata) {
        metadata = values;
        continue;
      }
      if (record.invalid || values.length !== header.length) {
        issues.push({ line, reason: 'CSV 따옴표 또는 열 개수 오류' });
        continue;
      }
      const get = name => values[indexes.get(name)];
      const name = get(station ? '주유소명' : '상호');
      const address = station ? get('소재지도로명주소') : get('주소');
      const alternate = station ? get('소재지지번주소') : '';
      const brand = get(station ? '상표구분명' : '상표');
      const region = resolveRegion(kind, get, address.trim() ? address : alternate);
      const row = { values, line, name, address, alternate, brand, region };
      if (station) {
        row.point = coordinates(get('경도'), get('위도'));
        if (!row.point) noCoordinates++;
      } else {
        const id = get('번호').trim();
        const date = get('기간').trim();
        const prices = fuels.map(fuel => get(fuel).trim());
        const invalidFuel = prices.findIndex(price => price && (!/^\d+(?:\.\d+)?$/.test(price) || !Number.isFinite(Number(price))));
        const reason = !id ? '주유소 번호 누락'
          : !validDate(date) ? '기간 날짜 형식 오류'
            : invalidFuel !== -1 ? `${fuels[invalidFuel]} 가격 형식 오류` : '';
        if (reason) {
          issues.push({ line, reason });
          continue;
        }
        Object.assign(row, { id, date, prices, self: get('셀프여부') });
      }
      if (!region) unknown++;
      rows.push(row);
    }
    return { header, metadata, rows, issues, unknown, noCoordinates };
  }

  function filterRows(dataset, province, district) {
    return dataset.rows.filter(({ region }) => region?.province === province
      && (!district || region.code === district || region.parent === district));
  }

  function serializeCsv(dataset, rows) {
    const escape = value => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    const records = [dataset.header, ...(dataset.metadata ? [dataset.metadata] : []), ...rows.map(row => row.values)];
    return '\uFEFF' + records.map(record => record.map(escape).join(',')).join('\r\n') + '\r\n';
  }

  function normalizeAddress(value, region) {
    let address = compact(value.replace(/\([^)]*\)/g, ''));
    const province = byCode.get(region.province);
    const names = [province.name, ...aliases[province.code].split(' ')].map(compact)
      .sort((a, b) => b.length - a.length);
    const prefix = names.find(name => address.startsWith(name));
    if (prefix) address = address.slice(prefix.length);
    const parent = byCode.get(region.parent);
    const districtNames = region.province === '36' ? ['세종시'] : [compact(region.name)];
    if (parent) districtNames.push(compact(parent.name), compact(region.name).slice(compact(parent.name).length));
    const district = districtNames.find(name => address.startsWith(name));
    return district ? address.slice(district.length) : address;
  }

  function priceMatches(stations, prices) {
    const histories = new Map();
    const candidates = new Map();
    const normalizeName = value => compact(value.normalize('NFKC').replace(/㈜|\(주\)|주식회사|\(유\)|유한회사/g, ''));
    const keyFor = (row, address) => [row.region.code, normalizeName(row.name), normalizeAddress(address, row.region)].join('\0');
    for (const row of prices) {
      if (!histories.has(row.id)) histories.set(row.id, new Map());
      const dates = histories.get(row.id);
      if (!dates.has(row.date)) dates.set(row.date, []);
      const day = dates.get(row.date);
      if (!day.some(item => item.values.every((value, index) => value === row.values[index]))) day.push(row);
      if (!row.address.trim() || !normalizeName(row.name) || !normalizeAddress(row.address, row.region)) continue;
      const key = keyFor(row, row.address);
      if (!candidates.has(key)) candidates.set(key, new Set());
      candidates.get(key).add(row.id);
    }
    const linked = new Set();
    const matches = new Map();
    for (const station of stations) {
      const ids = new Set();
      for (const address of [station.address, station.alternate]) {
        if (!address.trim() || !normalizeName(station.name) || !normalizeAddress(address, station.region)) continue;
        for (const id of candidates.get(keyFor(station, address)) ?? []) ids.add(id);
      }
      const id = ids.size === 1 ? [...ids][0] : undefined;
      if (id) linked.add(id);
      matches.set(station, { id, count: ids.size });
    }
    return { histories, matches, unlinked: [...histories.keys()].filter(id => !linked.has(id)) };
  }

  globalThis.FuelData = { byCode, fuels, dateLabel, decodeCsv, parseDataset, filterRows, serializeCsv, priceMatches };
})();
