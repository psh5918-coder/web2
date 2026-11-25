(() => {
  'use strict';

  const view = document.querySelector('#map-view');
  const canvas = document.querySelector('#map-canvas');
  const markers = document.querySelector('#map-markers');
  const message = document.querySelector('#map-message');
  const context = canvas.getContext('2d');
  const controls = ['zoom-in', 'zoom-out', 'map-reset'].map(id => document.getElementById(id));
  const markerButtons = new Map();
  const pending = new Map();
  let boundary, stations, selected, selectStation, drag;
  let centerX = 0, centerY = 0, zoom = 1;
  let frame = 0;

  function loadProvince(code) {
    if (FuelBoundaries[code]) return Promise.resolve(FuelBoundaries[code]);
    if (!pending.has(code)) {
      const work = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `boundaries/${code}.js`;
        script.onload = () => FuelBoundaries[code]
          ? resolve(FuelBoundaries[code]) : reject(new Error('지도 경계 데이터가 비어 있습니다.'));
        script.onerror = () => {
          script.remove();
          reject(new Error('지도 경계 파일을 열 수 없습니다.'));
        };
        document.head.append(script);
      }).finally(() => pending.delete(code));
      pending.set(code, work);
    }
    return pending.get(code);
  }

  function scale() {
    const [left, top, right, bottom] = boundary.bounds;
    return zoom * Math.min(Math.max(1, view.clientWidth - 52) / Math.max(right - left, 1),
      Math.max(1, view.clientHeight - 52) / Math.max(bottom - top, 1));
  }

  function redraw() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function draw() {
    frame = 0;
    const width = view.clientWidth;
    const height = view.clientHeight;
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    const visible = new Set();
    if (boundary) {
      const factor = scale();
      const offsetX = width / 2 - centerX * factor;
      const offsetY = height / 2 - centerY * factor;
      context.setTransform(factor * pixelRatio, 0, 0, factor * pixelRatio, offsetX * pixelRatio, offsetY * pixelRatio);
      context.lineWidth = 0.7 / factor;
      context.fillStyle = '#f0eceb';
      context.strokeStyle = '#69798e';
      for (const { path, bounds: [left, top, right, bottom] } of boundary.layers) {
        if (right * factor + offsetX < 0 || left * factor + offsetX > width
            || bottom * factor + offsetY < 0 || top * factor + offsetY > height) continue;
        context.fill(path, 'evenodd');
        context.stroke(path);
      }
      for (const station of stations) {
        if (!station.point) continue;
        const x = station.point[0] * factor + offsetX;
        const y = station.point[1] * factor + offsetY;
        if (x < 0 || x > width || y < 0 || y > height) continue;
        visible.add(station);
        if (!markerButtons.has(station)) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'map-marker';
          button.title = station.name;
          button.setAttribute('aria-label', station.name);
          button.addEventListener('click', () => selectStation(station));
          markers.append(button);
          markerButtons.set(station, button);
        }
        const button = markerButtons.get(station);
        button.style.left = `${x}px`;
        button.style.top = `${y}px`;
        button.setAttribute('aria-pressed', station === selected);
      }
    }
    for (const [station, button] of markerButtons) {
      if (visible.has(station)) continue;
      if (document.activeElement === button) view.focus();
      button.remove();
      markerButtons.delete(station);
    }
  }

  function reset() {
    if (!boundary) return;
    const [left, top, right, bottom] = boundary.bounds;
    centerX = (left + right) / 2;
    centerY = (top + bottom) / 2;
    zoom = 1;
    redraw();
  }

  function zoomBy(amount, x = view.clientWidth / 2, y = view.clientHeight / 2) {
    if (!boundary) return;
    const oldScale = scale();
    zoom = Math.max(0.65, Math.min(40, zoom * amount));
    const difference = 1 / oldScale - 1 / scale();
    centerX += (x - view.clientWidth / 2) * difference;
    centerY += (y - view.clientHeight / 2) * difference;
    redraw();
  }

  function move(dx, dy) {
    centerX += dx / scale();
    centerY += dy / scale();
    redraw();
  }

  function showMessage(text) {
    boundary = undefined;
    view.removeAttribute('data-ready');
    for (const control of controls) control.disabled = true;
    message.textContent = text;
    message.hidden = false;
    redraw();
  }

  controls[0].addEventListener('click', () => zoomBy(1.35));
  controls[1].addEventListener('click', () => zoomBy(1 / 1.35));
  controls[2].addEventListener('click', reset);
  view.addEventListener('pointerdown', event => {
    if (!boundary || event.button !== 0 || event.target.closest('button')) return;
    drag = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
    view.setPointerCapture(event.pointerId);
  });
  view.addEventListener('pointermove', event => {
    if (!boundary || drag?.id !== event.pointerId) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    drag.moved = true;
    view.setAttribute('data-dragging', '');
    move(drag.x - event.clientX, drag.y - event.clientY);
    Object.assign(drag, { x: event.clientX, y: event.clientY });
  });
  view.addEventListener('pointerup', event => {
    if (!boundary || drag?.id !== event.pointerId || drag.moved) return;
    let nearest;
    let distance = 22;
    for (const [station, button] of markerButtons) {
      const rect = button.getBoundingClientRect();
      const current = Math.hypot(event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
      if (current >= distance) continue;
      nearest = station;
      distance = current;
    }
    if (nearest) selectStation(nearest);
  });
  view.addEventListener('lostpointercapture', () => {
    drag = undefined;
    view.removeAttribute('data-dragging');
  });
  view.addEventListener('keydown', event => {
    if (!boundary || event.target !== view) return;
    const moves = { ArrowLeft: [-45, 0], ArrowRight: [45, 0], ArrowUp: [0, -45], ArrowDown: [0, 45] };
    if (moves[event.key]) move(...moves[event.key]);
    else if (event.key === '+' || event.key === '=') zoomBy(1.35);
    else if (event.key === '-') zoomBy(1 / 1.35);
    else if (event.key === 'Home') reset();
    else return;
    event.preventDefault();
  });
  new ResizeObserver(redraw).observe(view);

  globalThis.FuelMap = {
    loadProvince,
    showMessage,
    show(districts, regionStations, onSelect) {
      const layers = districts.map(({ bounds, paths }) => ({ bounds, path: new Path2D(paths.join('')) }));
      const bounds = [Infinity, Infinity, -Infinity, -Infinity];
      for (const { bounds: [left, top, right, bottom] } of layers) {
        bounds[0] = Math.min(bounds[0], left);
        bounds[1] = Math.min(bounds[1], top);
        bounds[2] = Math.max(bounds[2], right);
        bounds[3] = Math.max(bounds[3], bottom);
      }
      if (!layers.length) {
        showMessage('선택한 지역의 지도 경계가 없습니다.');
        return;
      }
      boundary = { layers, bounds };
      stations = regionStations;
      selected = undefined;
      selectStation = onSelect;
      message.hidden = true;
      view.setAttribute('data-ready', '');
      for (const control of controls) control.disabled = false;
      reset();
    },
    select(station, recenter) {
      selected = station;
      if (boundary && recenter && station?.point) {
        const factor = scale();
        const [x, y] = station.point;
        if (Math.abs(x - centerX) * factor > view.clientWidth / 2 - 15
            || Math.abs(y - centerY) * factor > view.clientHeight / 2 - 15) {
          centerX = x;
          centerY = y;
        }
      }
      redraw();
    }
  };
})();
