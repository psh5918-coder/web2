(() => {
  'use strict';

  const menu = document.body.dataset.menu;
  const mapMode = menu === 'map';
  const $ = id => document.getElementById(id);
  const province = $('province');
  const district = $('district');
  const status = $('status');
  const files = {
    stations: { input: $('stations-file'), status: $('stations-file-state'), label: '주유소 자료' },
    prices: { input: $('prices-file'), status: $('prices-file-state'), label: '판매가격 자료' }
  };
  const categories = Object.keys(files);
  const numberFormat = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 8 });
  const formatNumber = value => numberFormat.format(value);
  const formatCount = value => formatNumber(value) + '건';
  const fuelPrice = value => Number(value) > 0 ? formatNumber(value) + ' 원/L' : '—';
  const regionLabel = () => [FuelData.byCode.get(province.value)?.name, FuelData.byCode.get(district.value)?.name]
    .filter(Boolean).join(' ');
  const issueDetails = $('issues');
  let latestRender = 0;
  let selection;
  let entries;
  let selected;
  let issuePage = 0;
  const stationButtons = new Map();
  const priceButtons = new Map();

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function addOptions(select, label, options) {
    select.replaceChildren(new Option(label, ''));
    for (const { code, name } of options) select.add(new Option(name, code));
  }

  function setRegion(provinceCode, districtCode = '') {
    province.value = provinceCode;
    const region = FuelData.byCode.get(province.value);
    addOptions(district, '전체', region?.districts ?? []);
    district.disabled = province.disabled || !region;
    if (region?.districts.some(option => option.code === districtCode)) district.value = districtCode;
  }

  function saveSession() {
    const inputs = {};
    for (const [kind, { filename, text }] of Object.entries(files)) {
      if (text !== undefined) inputs[kind] = { filename, text };
    }
    FuelSession.save(menu, { inputs, province: province.value, district: district.value });
  }

  function parseFile(file, kind, input) {
    file.text = input;
    try {
      file.dataset = FuelData.parseDataset(input, kind);
      file.status.textContent = `${file.filename} · ${formatCount(file.dataset.rows.length)} 불러옴`;
    } catch (error) {
      file.dataset = undefined;
      file.status.textContent = '⚠ ' + error.message;
      file.status.setAttribute('data-error', '');
    }
  }

  async function readFile(kind) {
    const file = files[kind];
    const input = file.input.files[0];
    if (!input) return;
    Object.assign(file, { request: input, dataset: undefined, filename: input.name, text: undefined, loading: true });
    file.status.removeAttribute('data-error');
    file.status.textContent = `${input.name} 처리 중…`;
    render();
    try {
      const bytes = await input.arrayBuffer();
      if (file.request !== input) return;
      const text = FuelData.decodeCsv(bytes);
      parseFile(file, kind, text);
    } catch {
      if (file.request !== input) return;
      file.status.textContent = `⚠ ${file.label} 파일을 읽을 수 없습니다. UTF-8 또는 CP949 CSV를 다시 선택하세요.`;
      file.status.setAttribute('data-error', '');
    } finally {
      if (file.request === input) {
        file.loading = false;
        if (mapMode && categories.every(category => files[category].dataset)) autoSelectRegion();
        issuePage = 0;
        renderIssues();
        saveSession();
        render();
      }
    }
  }

  function autoSelectRegion() {
    const regions = new Set();
    for (const { dataset } of Object.values(files)) {
      for (const { region } of dataset.rows) if (region) regions.add(region);
    }
    if (regions.size === 1) {
      const [region] = regions;
      setRegion(region.province, region.code);
      return;
    }
    const codes = new Set([...regions].map(region => region.parent ?? region.code));
    if (codes.size === 1 && [...regions].some(region => region.parts.length > 1)) {
      const region = FuelData.byCode.get([...codes][0]);
      setRegion(region.province, region.code);
    }
  }

  function renderIssues() {
    const issues = categories.flatMap(kind => (files[kind].dataset?.issues ?? [])
      .map(issue => ({ ...issue, label: files[kind].label })));
    $('issues-summary').textContent = `제외한 CSV 행 ${formatCount(issues.length)}`;
    issueDetails.hidden = !issues.length;
    const list = $('issue-list');
    list.replaceChildren();
    if (!issueDetails.open || !issues.length) return;
    const pageSize = 100;
    const start = issuePage * pageSize;
    const fragment = document.createDocumentFragment();
    for (const { label, line, reason } of issues.slice(start, start + pageSize)) {
      fragment.append(element('p', `${label} ${formatNumber(line)}행 · ${reason}`));
    }
    if (issues.length > pageSize) {
      const actions = element('div', undefined, 'actions');
      for (const [caption, difference, disabled] of [
        ['이전 오류', -1, start === 0], ['다음 오류', 1, start + pageSize >= issues.length]
      ]) {
        const button = element('button', caption);
        button.type = 'button';
        button.disabled = disabled;
        button.addEventListener('click', () => {
          issuePage += difference;
          renderIssues();
          list.scrollTop = 0;
          (list.querySelectorAll('button:enabled')[0] ?? $('issues-summary')).focus();
        });
        actions.append(button);
      }
      fragment.append(element('p', `${formatNumber(start + 1)}–${formatNumber(Math.min(issues.length, start + pageSize))} / ${formatNumber(issues.length)}`), actions);
    }
    list.append(fragment);
  }

  function periodFor(rows, metadata) {
    let first;
    let last;
    for (const { date } of rows) {
      if (!first || date < first) first = date;
      if (!last || date > last) last = date;
    }
    if (!first) {
      const dates = metadata?.[0].match(/\d{8}/g);
      [first, last] = dates ?? [];
    }
    if (!first) return '—';
    return last && last !== first ? `${FuelData.dateLabel(first)} ~ ${FuelData.dateLabel(last)}` : FuelData.dateLabel(first);
  }

  function renderExtraction() {
    $('station-count').textContent = selection ? formatCount(selection.stations.length) : '—';
    $('price-count').textContent = selection ? formatCount(selection.prices.length) : '—';
    $('price-period').textContent = selection ? periodFor(selection.prices, files.prices.dataset.metadata) : '—';
    $('save-stations').disabled = $('save-prices').disabled = !selection;
  }

  function saveCsv(kind) {
    if (!selection) return;
    const content = FuelData.serializeCsv(files[kind].dataset, selection[kind]);
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const link = element('a');
    const prefix = kind === 'stations' ? '주유소' : '판매가격';
    const name = [prefix, FuelData.byCode.get(province.value).name, FuelData.byCode.get(district.value)?.name ?? '전체'];
    link.download = name.join('_').replace(/[<>:"/\\|?*]/g, '_') + '.csv';
    link.href = url;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function render() {
    const revision = ++latestRender;
    const ready = categories.every(kind => files[kind].dataset);
    const loading = categories.some(kind => files[kind].loading);
    province.disabled = !ready;
    district.disabled = !ready || !province.value;
    selection = ready && province.value ? Object.fromEntries(categories.map(kind => [
      kind, FuelData.filterRows(files[kind].dataset, province.value, district.value)
    ])) : undefined;
    const notice = loading ? 'CSV 파일을 처리하는 중입니다.'
      : !ready ? '주유소 자료와 판매가격 자료를 선택하세요.'
        : selection ? regionLabel() + ' 자료를 표시합니다.' : '시·도와 필요한 경우 시·군·구를 선택하세요.';
    const unknowns = ready ? Object.values(files).filter(({ dataset }) => dataset.unknown)
      .map(({ label, dataset }) => `${label} ${formatCount(dataset.unknown)}`) : [];
    status.textContent = notice + (unknowns.length ? ` 지역 미확정 · ${unknowns.join(', ')}.` : '');
    if (mapMode) renderMap(revision);
    else renderExtraction();
  }

  function recordButton(list, title, secondary, callback) {
    const item = element('li');
    const button = element('button', title);
    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');
    if (secondary) button.append(element('span', secondary, 'record-secondary'));
    button.addEventListener('click', callback);
    item.append(button);
    list.append(item);
    return button;
  }

  async function renderMap(revision) {
    const stationList = $('station-list');
    const unlinkedList = $('unlinked-list');
    stationList.replaceChildren();
    unlinkedList.replaceChildren();
    stationButtons.clear();
    priceButtons.clear();
    selected = undefined;
    entries = selection ? FuelData.priceMatches(selection.stations, selection.prices) : undefined;
    renderDetails();
    const stationSummary = $('station-summary');
    const unlinkedSummary = $('unlinked-summary');
    if (!selection) {
      stationSummary.textContent = unlinkedSummary.textContent = '지역을 선택하세요.';
      FuelMap.showMessage('지역을 선택하면 지도가 표시됩니다.');
      return;
    }
    const { stations } = selection;
    const coordinatesMissing = stations.reduce((total, row) => total + Number(!row.point), 0);
    stationSummary.textContent = stations.length
      ? `주유소 ${formatCount(stations.length)} · 좌표 없음 또는 오류 ${formatCount(coordinatesMissing)}${coordinatesMissing === stations.length ? ' · 지도에 표시할 주유소가 없습니다.' : ''}`
      : '지도에 표시할 주유소가 없습니다. 주유소 자료 0건';
    unlinkedSummary.textContent = entries.unlinked.length
      ? `가격을 확인할 수 있는 주유소 ${formatCount(entries.unlinked.length)}`
      : '지도에 연결되지 않은 가격 자료가 없습니다.';
    const stationItems = document.createDocumentFragment();
    for (const station of stations) {
      const button = recordButton(stationItems, station.name || '이름 없는 주유소',
        station.address || station.alternate, () => chooseStation(station, true));
      stationButtons.set(station, button);
    }
    stationList.append(stationItems);
    const priceItems = document.createDocumentFragment();
    for (const id of entries.unlinked) {
      const latest = latestRow(entries.histories.get(id));
      const button = recordButton(priceItems, latest.name || id, latest.address, () => choosePrice(id));
      priceButtons.set(id, button);
    }
    unlinkedList.append(priceItems);
    FuelMap.showMessage('지도 경계를 불러오는 중입니다.');
    const region = FuelData.byCode.get(province.value);
    const parts = FuelData.byCode.get(district.value)?.parts
      ?? region.districts.filter(item => item.parts.length === 1).map(item => item.code);
    try {
      const boundaries = await FuelMap.loadProvince(region.code);
      if (revision !== latestRender) return;
      FuelMap.show(parts.map(code => boundaries[code]).filter(Boolean), stations, station => chooseStation(station, false));
      if (selected?.station) FuelMap.select(selected.station, true);
    } catch (error) {
      if (revision === latestRender) FuelMap.showMessage(error.message);
    }
  }

  function latestRow(history) {
    if (!history?.size) return undefined;
    const latest = [...history.keys()].sort().at(-1);
    return history.get(latest)[0];
  }

  function clearSelectedButton() {
    const old = selected?.station ? stationButtons.get(selected.station) : priceButtons.get(selected?.id);
    old?.setAttribute('aria-pressed', 'false');
  }

  function chooseStation(station, recenter) {
    if (selected?.station === station) return;
    clearSelectedButton();
    const { id, count } = entries.matches.get(station);
    selected = { station, id, count, history: entries.histories.get(id) };
    const button = stationButtons.get(station);
    button.setAttribute('aria-pressed', 'true');
    if (!recenter) {
      const list = $('station-list');
      const difference = button.getBoundingClientRect().top - list.getBoundingClientRect().top;
      if (difference < 0 || difference + button.offsetHeight > list.clientHeight) list.scrollTop += difference;
    }
    FuelMap.select(station, recenter);
    renderDetails();
  }

  function choosePrice(id) {
    if (!selected?.station && selected?.id === id) return;
    clearSelectedButton();
    selected = { id, history: entries.histories.get(id) };
    priceButtons.get(id).setAttribute('aria-pressed', 'true');
    FuelMap.select(undefined, false);
    renderDetails();
  }

  function renderDetails() {
    const detail = $('station-detail');
    const dateInput = $('price-date');
    const latest = latestRow(selected?.history);
    dateInput.value = latest ? FuelData.dateLabel(latest.date) : '';
    dateInput.disabled = !latest;
    detail.replaceChildren();
    if (!selected) {
      detail.append(element('p', '지도나 목록에서 주유소를 선택하세요.'));
    } else {
      const record = selected.station ?? latest;
      detail.append(element('h3', record.name || selected.id || '이름 없는 주유소'));
      detail.append(element('p', record.address || record.alternate || '주소 자료 없음'));
      detail.append(element('p', `상표 ${record.brand || latest?.brand || '—'} · 셀프 여부 ${latest?.self || '—'}`));
    }
    renderPrices();
  }

  function renderPrices() {
    const output = $('price-detail');
    output.replaceChildren();
    if (!selected) return;
    if (!selected.history) {
      output.append(element('p', selected.count > 1 ? '후보 여러 건' : '연결할 가격 자료 없음', 'status'));
      return;
    }
    const date = $('price-date').value;
    if (!date) {
      output.append(element('p', '조회 날짜를 선택하세요.'));
      return;
    }
    const day = selected.history.get(date.replaceAll('-', ''));
    if (!day) {
      output.append(element('p', `${date} 판매가격 자료가 없습니다.`));
      return;
    }
    output.append(element('p', `가격 기준일 ${date}`, 'file-state'));
    const conflict = FuelData.fuels.some((_, index) => new Set(day.map(row => Number(row.prices[index]))).size > 1);
    if (conflict) output.append(element('p', '⚠ 같은 날짜에 서로 다른 판매가격이 있습니다.', 'status'));
    const table = element('dl', undefined, 'results');
    FuelData.fuels.forEach((fuel, index) => {
      const item = element('div');
      const values = [...new Set(day.map(row => fuelPrice(row.prices[index])))];
      item.append(element('dt', fuel), element('dd', values.join(' / ')));
      table.append(item);
    });
    output.append(table);
  }

  addOptions(province, '시·도를 선택하세요', [...FuelRegions].sort((a, b) => a.name.localeCompare(b.name, 'ko')));
  province.addEventListener('change', () => {
    setRegion(province.value);
    saveSession();
    render();
  });
  district.addEventListener('change', () => {
    saveSession();
    render();
  });
  issueDetails.addEventListener('toggle', renderIssues);
  for (const kind of categories) files[kind].input.addEventListener('change', () => readFile(kind));
  if (mapMode) $('price-date').addEventListener('input', renderPrices);
  else for (const kind of categories) $(`save-${kind}`).addEventListener('click', () => saveCsv(kind));

  const restored = FuelSession.get(menu);
  for (const kind of categories) {
    const file = files[kind];
    file.input.value = '';
    const cached = restored?.inputs?.[kind];
    if (!cached) continue;
    file.filename = cached.filename;
    parseFile(file, kind, cached.text);
  }
  if (restored?.province) setRegion(restored.province, restored.district);
  renderIssues();
  render();
})();
