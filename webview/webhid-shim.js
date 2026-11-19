/*
 * WebHID shim over the native Rust HID bridge.
 *
 * The IO Hub web app uses `navigator.hid` exactly as a Chromium browser exposes it.
 * WebView2 does not implement WebHID, so this file re-creates the same object model on top of
 * the Tauri commands implemented in src/main.rs. Loaded as a plain <script> before the app
 * bundle, so `navigator.hid` is already in place when the app runs its feature check.
 *
 * Naming follows the WebHID spec:
 *   getDevices() / requestDevice({filters})            -> navigator.hid
 *   open() close() sendReport() sendFeatureReport()    -> HIDDevice
 *   receiveFeatureReport()                             -> DataView, first byte = report id
 *   events: inputreport (device) / connect, disconnect (navigator.hid)
 *
 * Report sizes in `collections` are in bits, like the real API.
 */
(function installWebHidShim() {
  'use strict';

  var TAURI = window.__TAURI__;
  if (!TAURI || !TAURI.core || !TAURI.event) {
    console.warn('[webhid-shim] window.__TAURI__ not found; native HID bridge disabled');
    return;
  }
  var invoke = TAURI.core.invoke;
  var listen = TAURI.event.listen;

  // WebView2 does expose a navigator.hid object, but device access there is granted by the host
  // application through an event Tauri does not raise, so it can only ever return an empty list.
  // The native bridge is therefore the default; set window.__preferBrowserHid before this script to
  // hand control back to the browser API if that ever changes.
  var hasRealHid = typeof navigator.hid !== 'undefined' && navigator.hid !== null;
  if (hasRealHid && window.__preferBrowserHid) {
    console.info('[webhid-shim] browser already provides navigator.hid, shim not installed');
    window.__iohubHidMode = 'browser';
    return;
  }

  function log(msg) {
    if (window.__IOHUB_DEBUG) {
      console.info('[webhid-shim] ' + msg);
    }
    invoke('debug_log', { msg: 'webhid: ' + msg }).catch(function () {});
  }

  // Трассировка пакетов и снимки экрана нужны только при разборках. Включаются файлом
  // debug.on в папке данных или переменной окружения IOHUB_DEBUG=1.
  var traceOn = false;
  invoke('debug_flag')
    .then(function (on) {
      traceOn = on === true;
      if (traceOn) log('трассировка включена');
    })
    .catch(function () {});

  // Адрес списка прошивок. Берётся из файла firmware.url в папке данных программы;
  // без него вкладка «Обслуживание» работает как в веб-версии — прошивка из файла .hex.
  invoke('firmware_link')
    .then(function (url) {
      if (url) {
        window.__iohubFirmwareLink = url;
        log('список прошивок: ' + url);
      }
    })
    .catch(function () {});

  function bytesToUint8(value) {
    if (value == null) return new Uint8Array(0);
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (Array.isArray(value)) return Uint8Array.from(value);
    throw new TypeError('HID data must be a buffer or byte array');
  }

  // Devices that this app is allowed to see, mirroring the browser permission prompt.
  var allowedIds = new Set();
  var allowPromise = invoke('hid_list_allowed')
    .then(function (list) {
      (list || []).forEach(function (id) { allowedIds.add(id); });
      log('разрешённые устройства: ' + ((list || []).join(', ') || 'нет'));
      return list;
    })
    .catch(function (e) {
      log('список разрешений не получен: ' + e);
      return [];
    });

  function makeCollection(c) {
    // Chrome gives each report an `items` list of field declarations, and the web app multiplies
    // reportSize * reportCount over them to work out the frame size, so they have to be passed on.
    var wrap = function (r) {
      return {
        reportId: r.reportId,
        reportSize: r.reportSize,
        items: (r.items || []).map(function (i) {
          return { reportSize: i.reportSize, reportCount: i.reportCount };
        }),
      };
    };
    return {
      usagePage: c.usagePage,
      usage: c.usage,
      collectionType: c.collectionType,
      inputReports: (c.inputReports || []).map(wrap),
      outputReports: (c.outputReports || []).map(wrap),
      featureReports: (c.featureReports || []).map(wrap),
      children: (c.children || []).map(makeCollection),
    };
  }

  // Every collection, nested ones included — the descriptor can hide the vendor channel inside a
  // physical collection.
  function allCollections(collections) {
    var out = [];
    (collections || []).forEach(function (c) {
      out.push(c);
      out = out.concat(allCollections(c.children));
    });
    return out;
  }

  var devicesById = new Map();
  var emptyReports = 0;

  // Право доступа храним по паре VID:PID, а не по пути Windows: путь меняется,
  // когда кабель перетыкают в другой порт, а устройство остаётся тем же.
  function permissionKey(info) {
    return hex(info.vendorId) + ':' + hex(info.productId);
  }

  // Производители из каталога интерфейса: 0x05AC и 0x0C45 — клавиатуры IO/Alumix/RSQ,
  // 0x3554 — мыши Red Square. Если интерфейс спрашивает «любое устройство» (так делает
  // справка на экране подключения), разрешаем только их, а не веб-камеру с мышкой.
  var ALLOWED_VENDORS = [0x05ac, 0x0c45, 0x3554];

  function vendorAllowed(info) {
    return ALLOWED_VENDORS.indexOf(info.vendorId) >= 0;
  }

  function deviceFor(info) {
    var existing = devicesById.get(info.id);
    if (existing) {
      existing._apply(info);
      return existing;
    }
    var dev = new NativeHIDDevice(info);
    devicesById.set(info.id, dev);
    return dev;
  }

  class NativeHIDDevice extends EventTarget {
    constructor(info) {
      super();
      this.opened = false;
      this._apply(info);
    }

    _apply(info) {
      this.vendorId = info.vendorId;
      this.productId = info.productId;
      this.productName = info.productName || '';
      this.manufacturerName = info.manufacturerName || '';
      this.serialNumber = info.serialNumber || '';
      this.usagePage = info.usagePage;
      this.usage = info.usage;
      // Undocumented but handy: the hidapi path is the only stable key we have.
      this.devicePath = info.id;
      this.permissionKey = permissionKey(info);
      this.collections = (info.collections || []).map(makeCollection);
      this.opened = !!info.opened;
    }

    open() {
      if (this.opened) return Promise.resolve();
      return invoke('hid_open', { deviceId: this.devicePath }).then((info) => {
        this._apply(info);
        this.opened = true;
        log('opened ' + hex(this.vendorId) + ':' + hex(this.productId) + ' ' + this.productName);
      });
    }

    close() {
      if (!this.opened) return Promise.resolve();
      const self = this;
      return invoke('hid_close', { deviceId: this.devicePath }).then(() => {
        self.opened = false;
        log('closed ' + hex(self.vendorId) + ':' + hex(self.productId));
      });
    }

    forget() {
      const self = this;
      return invoke('hid_forget_device', { deviceId: this.permissionKey }).then(() => {
        allowedIds.delete(self.permissionKey);
        self.opened = false;
      });
    }

    // WebHID: data excludes the report id byte, which the transport prepends.
    sendReport(reportId, data) {
      const payload = bytesToUint8(data);
      if (traceOn) {
        log('→ output ' + hex(this.vendorId) + ':' + hex(this.productId) + '/' + this.interfaceTag() +
            ' id=' + reportId + ' [' + hexDump(payload) + ']');
      }
      return invoke('hid_send_report', {
        deviceId: this.devicePath,
        reportId: reportId & 0xff,
        data: Array.from(payload),
      }).catch((e) => {
        log('✕ output не отправлен: ' + e);
        throw e;
      });
    }

    sendFeatureReport(reportId, data) {
      // With reportId 0 the spec puts the id inside `data` already.
      let payload = bytesToUint8(data);
      let id = reportId & 0xff;
      if (id === 0) {
        if (payload.length === 0) throw new TypeError('sendFeatureReport(0, ...) needs the report id in data');
        id = payload[0];
        payload = payload.subarray(1);
      }
      if (traceOn) log('→ feature id=' + id + ' [' + hexDump(payload) + ']');
      return invoke('hid_send_feature_report', {
        deviceId: this.devicePath,
        reportId: id,
        data: Array.from(payload),
      }).catch((e) => {
        log('✕ feature не отправлен: ' + e);
        throw e;
      });
    }

    receiveFeatureReport(reportId) {
      const id = reportId & 0xff;
      return invoke('hid_receive_feature_report', {
        deviceId: this.devicePath,
        reportId: id,
        length: this._featureReportLength(id),
      }).then((bytes) => {
        const arr = Uint8Array.from(bytes || []);
        if (traceOn) log('← feature id=' + id + ' [' + hexDump(arr) + ']');
        return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
      }).catch((e) => {
        log('✕ feature не прочитан: ' + e);
        throw e;
      });
    }

    interfaceTag() {
      const c = (this.collections || [])[0];
      return c ? '0x' + c.usagePage.toString(16) + '/0x' + c.usage.toString(16) : '?';
    }

    _featureReportLength(reportId) {
      let best = 0;
      allCollections(this.collections).forEach((c) => {
        (c.featureReports || []).forEach((r) => {
          if (r.reportId === reportId) {
            best = Math.max(best, Math.ceil(r.reportSize / 8) + 1);
          }
        });
      });
      return Math.max(best || 65, 1);
    }
  }

  function hex(n) {
    return (n || 0).toString(16).padStart(4, '0');
  }

  // Пакеты в лог коротко: первые 12 байт и общая длина, иначе лог не прочитать.
  function hexDump(bytes) {
    const a = Array.from(bytes || []);
    const head = a.slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return a.length > 12 ? head + ' … (' + a.length + ')' : head;
  }

  function fire(target, type, props) {
    var ev = new Event(type);
    Object.assign(ev, props || {});
    try {
      target.dispatchEvent(ev);
    } catch (e) {
      console.warn('[webhid-shim] dispatch ' + type + ' failed: ' + e);
    }
  }

  function matchesFilter(device, filter) {
    if (!filter) return true;
    if (typeof filter.vendorId === 'number' && filter.vendorId !== device.vendorId) return false;
    if (typeof filter.productId === 'number' && filter.productId !== device.productId) return false;
    if (typeof filter.usagePage === 'number' || typeof filter.usage === 'number') {
      var page = typeof filter.usagePage === 'number' ? filter.usagePage : device.usagePage;
      var usage = typeof filter.usage === 'number' ? filter.usage : device.usage;
      var hit = allCollections(device.collections).some(function (c) {
        return c.usagePage === page && c.usage === usage;
      });
      if (!hit && device.usagePage === page && device.usage === usage) hit = true;
      if (!hit) return false;
    }
    return true;
  }

  function fetchDevices() {
    return invoke('hid_list_devices').then(function (infos) {
      var byKey = new Map();
      var out = [];
      (infos || []).forEach(function (info) {
        var key = permissionKey(info);
        byKey.set(key, info);
        var dev = deviceFor(info);
        // Как в Chrome: на каждую коллекцию (интерфейс) свой HIDDevice.
        // Служебный канал клавиатуры живёт в своей коллекции, поэтому схлопывать их нельзя.
        if (allowedIds.has(key)) out.push(dev);
      });
      devicesById.forEach(function (dev, id) {
        if (!byKey.has(dev.permissionKey)) {
          dev.opened = false;
          fire(dev, 'disconnect', {});
          fire(hid, 'disconnect', { device: dev });
          devicesById.delete(id);
        }
      });
      if (!out.length && emptyReports++ < 3) {
        log('нет разрешённых среди ' + (infos || []).length + ' устройств (' + allowedIds.size + ' в списке прав)');
      }
      return out;
    });
  }

  function matchesAnyFilter(info, filters) {
    if (!filters.length) return true;
    return filters.some((f) =>
      matchesFilter(
        {
          vendorId: info.vendorId,
          productId: info.productId,
          usagePage: info.usagePage,
          usage: info.usage,
          collections: info.collections || [],
        },
        f,
      ),
    );
  }

  class NativeHID extends EventTarget {
    getDevices() {
      return allowPromise.then(fetchDevices);
    }

    // The browser would show a picker here. For a personal offline tool the click that leads
    // to this call is the consent, so matching devices are remembered in hid-allow.json.
    requestDevice(options) {
      const filters = (options && options.filters) || [];
      return allowPromise
        .then(fetchDevices)
        .then(() => invoke('hid_list_devices'))
        .then((infos) => {
          const seen = new Set();
          const skipped = [];
          const wanted = (infos || []).filter((info) => {
            const key = permissionKey(info);
            if (seen.has(key)) return false;
            if (!vendorAllowed(info) && !allowedIds.has(key)) {
              skipped.push(key + ' ' + (info.productName || ''));
              return false;
            }
            if (!matchesAnyFilter(info, filters)) return false;
            seen.add(key);
            allowedIds.add(key);
            return true;
          });
          if (skipped.length) log('пропущено (не клавиатура IO): ' + skipped.join(', '));
          const grants = wanted.map((info) =>
            invoke('hid_allow_device', { deviceId: permissionKey(info) }).catch((e) => {
              console.warn('[webhid-shim] cannot store permission: ' + e);
            }),
          );
          return Promise.all(grants).then(() => {
            log('requestDevice разрешил ' + wanted.map((i) => permissionKey(i)).join(', '));
            return wanted.map(deviceFor);
          });
        });
    }
  }

  const hid = new NativeHID();

  Object.defineProperty(window.navigator, 'hid', {
    value: hid,
    writable: false,
    enumerable: true,
    configurable: true,
  });

  window.__iohubHidMode = 'native';
  log('шим WebHID установлен, мост: hidapi');

  // The page itself must stay untouched, but a failure inside it is invisible from the outside,
  // so anything it throws or rejects is forwarded to the host log.
  window.addEventListener('error', function (e) {
    log('ошибка страницы: ' + (e.message || 'без сообщения') + ' @ ' + (e.filename || '?') + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    log('отклонённый промис: ' + (r && (r.message || r.stage || r.name) ? JSON.stringify({ msg: r.message, stage: r.stage, code: r.code || r.name }) : String(r)));
  });

  // Экран приложения виден только пользователю, поэтому в лог попадает маршрут
  // и первые строки видимого текста — по ним видно, до какой страницы дошло.
  var lastSnap = '';
  // Что приложение считает кликабельным: по ссылкам видно маршруты, по кнопкам — экран.
  function uiRoutes(tag) {
    try {
      var links = Array.prototype.slice.call(document.querySelectorAll('a[href]'))
        .map(function (a) { return a.getAttribute('href'); }).filter(Boolean);
      var buttons = Array.prototype.slice.call(document.querySelectorAll('button'))
        .map(function (b) { return (b.innerText || '').replace(/\s+/g, ' ').trim(); })
        .filter(Boolean);
      log(tag + ' маршруты: ' + links.slice(0, 20).join(', '));
      log(tag + ' кнопки: ' + buttons.slice(0, 25).join(' | '));
    } catch (e) {
      log('список элементов не удался: ' + e);
    }
  }
  function uiSnapshot(tag) {
    try {
      var text = (document.body && document.body.innerText) || '';
      text = text.replace(/\s+/g, ' ').trim().slice(0, 500);
      if (tag === 'экран@опрос' && text === lastSnap) return;
      lastSnap = text;
      log(tag + ': #' + (location.hash || '/') + ' | ' + (text || 'пусто'));
      uiRoutes(tag);
    } catch (e) {
      log('снимок экрана не удался: ' + e);
    }
  }
  // Временная навигация: самопроизвольно открываем экран устройства, чтобы проверить,
  // собирается ли редактор раскладки без сети. Кнопки прошивки не трогаем.
  function clickByText(word, allowAll) {
    var want = word.toLowerCase();
    var els = Array.prototype.slice.call(document.querySelectorAll('button, a, [role=button]'));
    var hit = els.find(function (el) {
      var t = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).replace(/\s+/g, ' ').toLowerCase();
      if (t.indexOf(want) === -1) return false;
      if (allowAll) return true;
      return t.indexOf('firmware') === -1 && t.indexOf('прошивк') === -1;
    });
    if (!hit) {
      log('кнопка не найдена: ' + word);
      return false;
    }
    log('клик по «' + (hit.innerText || hit.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40) + '»');
    hit.click();
    return true;
  }
  // Подробный список видимых элементов: по нему подбираются шаги сценария.
  function dumpControls(tag) {
    try {
      var els = Array.prototype.slice.call(document.querySelectorAll('button, a, [role=button], input, select, [tabindex]'));
      var out = [];
      els.forEach(function (el, n) {
        var r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        var cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).slice(0, 2).join('.');
        var t = ((el.innerText || el.value || '') || (el.getAttribute('aria-label') || '') || (el.getAttribute('title') || '')).replace(/\s+/g, ' ').trim().slice(0, 22);
        out.push(n + ':' + el.tagName.toLowerCase() + '.' + cls + (el.disabled ? '!' : '') + '«' + t + '»');
      });
      for (var i = 0; i < out.length; i += 9) {
        log(tag + ' эл' + Math.floor(i / 9) + ': ' + out.slice(i, i + 9).join(' ; '));
      }
    } catch (e) {
      log('список элементов не удался: ' + e);
    }
  }
  // Где в окне есть свободное место: углы, служебные контейнеры и верхний уровень #app.
  // Нужено только при разборе интерфейса — экран виден только пользователю.
  function describe(node) {
    var cls = (typeof node.className === 'string' ? node.className : '').trim().split(/\s+/).slice(0, 2).join('.');
    var r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    return node.tagName.toLowerCase() + (cls ? '.' + cls : '')
      + (r ? '[' + Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.x) + ',' + Math.round(r.y) + ']' : '');
  }
  function probeLayout(tag) {
    try {
      var w = window.innerWidth, h = window.innerHeight;
      log(tag + ' окно: ' + w + 'x' + h + ' ; детей у body: ' + document.body.children.length);
      var pts = [[16, 16], [w - 16, 16], [16, h - 16], [w - 16, h - 16], [16, Math.round(h / 2)]];
      pts.forEach(function (p) {
        var chain = [];
        for (var n = document.elementFromPoint(p[0], p[1]); n && n !== document.documentElement && chain.length < 4; n = n.parentElement) {
          chain.push(describe(n));
        }
        log(tag + ' точка ' + p[0] + ',' + p[1] + ': ' + (chain.join(' < ') || 'пусто'));
      });
      ['header', 'footer', 'nav', 'aside', 'main'].forEach(function (sel) {
        var n = document.querySelector(sel);
        log(tag + ' контейнер ' + sel + ': ' + (n ? describe(n) + ' «' + (n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50) + '»' : 'нет'));
      });
      var app = document.querySelector('#app');
      Array.prototype.slice.call((app && app.children) || []).forEach(function (c, i) {
        log(tag + ' app[' + i + ']: ' + describe(c));
      });
      var bar = document.querySelector('header');
      Array.prototype.slice.call((bar && bar.children) || []).forEach(function (c, i) {
        log(tag + ' header[' + i + ']: ' + describe(c) + ' «' + (c.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 26) + '»');
      });
      log(tag + ' прокрутка: окно ' + window.scrollY + ' ; body ' + document.body.scrollTop
        + ' ; высота документа ' + document.documentElement.scrollHeight);
    } catch (e) {
      log(tag + ' разбор не удался: ' + e);
    }
  }
  // Сценарий проверки: файл autotask.txt в папке данных, по одному шагу в строке.
  // Шаги: wait:мс, click:текст, click!:текст (можно и по кнопке прошивки), dump:подпись.
  function runSteps(steps, i) {
    if (i >= steps.length) {
      log('сценарий завершён');
      uiSnapshot('экран@финал');
      return;
    }
    var line = String(steps[i] || '').trim();
    if (!line || line.charAt(0) === '#') {
      runSteps(steps, i + 1);
      return;
    }
    var k = line.indexOf(':');
    var cmd = (k < 0 ? line : line.slice(0, k)).toLowerCase();
    var arg = k < 0 ? '' : line.slice(k + 1).trim();
    var delay = 1500;
    if (cmd === 'wait') {
      delay = parseInt(arg, 10) || 0;
    } else if (cmd === 'click' || cmd === 'click!') {
      clickByText(arg, cmd === 'click!');
      uiSnapshot('после «' + arg + '»');
    } else if (cmd === 'pick') {
      // pick:селектор::текст — ищет элемент внутри панели, чтобы не промахнуться по клавише корпуса.
      var parts = arg.split('::');
      var nodes = Array.prototype.slice.call(document.querySelectorAll(parts[0] || 'button'));
      var want = (parts[1] || '').toLowerCase();
      var found = nodes.find(function (el) {
        return (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase() === want;
      }) || nodes.find(function (el) {
        return (el.innerText || el.getAttribute('aria-label') || '').toLowerCase().indexOf(want) !== -1;
      });
      if (found) {
        log('выбор «' + (found.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40) + '»');
        found.click();
      } else {
        log('в панели не найдено: ' + arg);
      }
      uiSnapshot('после выбора «' + (parts[1] || '') + '»');
    } else if (cmd === 'keys') {
      var keys = Array.prototype.slice.call(document.querySelectorAll('button.key')).map(function (el) {
        return (el.innerText || '').replace(/\s+/g, ' ').trim();
      });
      log('клавиши@' + arg + '(' + keys.length + '): ' + keys.join('|'));
    } else if (cmd === 'text') {
      var node = document.querySelector(arg);
      log('текст@' + arg + ': ' + (((node && node.innerText) || 'нет узла').replace(/\s+/g, ' ').slice(0, 800)));
      uiRoutes('текст@' + arg);
    } else if (cmd === 'dump') {
      dumpControls('раскоп@' + (arg || i) + ' маршруты:');
      uiRoutes('раскоп@' + (arg || i));
      uiSnapshot('раскоп@' + (arg || i));
    } else if (cmd === 'layout') {
      probeLayout('разбор@' + (arg || i));
    } else if (cmd === 'scroll') {
      // Прокрутка страницы: по положению шапки видно, приклеена ли она к верху.
      var to = arg === 'top' ? 0 : (arg === 'bottom' ? document.documentElement.scrollHeight : (parseInt(arg, 10) || 0));
      window.scrollTo(0, to);
      var sc = document.scrollingElement || document.documentElement;
      sc.scrollTop = to;
      log('прокрутка задана ' + to + ' ; стало ' + window.scrollY + '/' + sc.scrollTop);
    } else {
      log('неизвестный шаг: ' + line);
    }
    setTimeout(function () { runSteps(steps, i + 1); }, delay);
  }
  window.addEventListener('load', function () {
    setTimeout(function () { if (traceOn) uiSnapshot('экран@старт'); }, 2500);
    window.addEventListener('hashchange', function () {
      setTimeout(function () { if (traceOn) uiSnapshot('экран@переход'); }, 900);
    });
    // Приложение меняет экран без смены адреса, поэтому снимаем интерфейс по таймеру.
    setInterval(function () { if (traceOn) uiSnapshot('экран@опрос'); }, 4000);
    invoke('autotask')
      .then(function (steps) {
        if (!traceOn || !Array.isArray(steps) || !steps.length) return;
        log('сценарий: ' + steps.length + ' шагов');
        setTimeout(function () { runSteps(steps, 0); }, 6000);
      })
      .catch(function () {});
  });
  // Временная проверка автономности: записываем каждую попытку страницы уйти наружу.
  // Служебные адреса самого приложения (ipc.localhost, tauri.localhost) не трогаем —
  // иначе собственный лог зацикливается на себе.
  // Если страница попытается уйти по адресу, который не разрешён политикой, это видно в логе.
  document.addEventListener('securitypolicyviolation', function (e) {
    log('запрещено политикой: ' + (e.blockedURI || '?') + ' (' + (e.violatedDirective || '?') + ')');
  });
  function external(url) {
    var u = String(url || '');
    if (!/^https?:/i.test(u)) return false;
    return !/^https?:\/\/(ipc|tauri)\.localhost/i.test(u);
  }
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url) || '?';
      if (traceOn && external(url)) log('наружу fetch: ' + url);
      return nativeFetch.apply(window, arguments);
    };
  }
  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (traceOn && external(url)) log('наружу xhr: ' + method + ' ' + url);
    return xhrOpen.apply(this, arguments);
  };

  window.__iohubHidDiagnostics = {
    listAll: function () { return invoke('hid_list_devices'); },
    status: function () { return invoke('hid_status'); },
    appInfo: function () { return invoke('app_info'); },
    logs: function (limit) { return invoke('debug_logs', { limit: limit || 200 }); },
    allowed: function () { return Array.from(allowedIds); },
  };

  // ---------------------------------------------------------------- отчёт о проблеме
  //
  // В веб-версии форма «Сообщить об ошибке» уходит на сервер. Сервера у нас нет, поэтому
  // по нажатию открывается своя панель: текст проблемы, собранный журнал и два выхода —
  // письмо на почту поддержки или задача на GitHub. Никуда сама программа ничего не
  // отправляет: только сохраняет файл или открывает письмо/браузер по команде пользователя.

  var support = { email: '', repo: '', issues: '', logPath: '', version: '', dataPath: '' };
  var supportReady = invoke('support_info')
    .then(function (info) {
      if (!info) return support;
      support = info;
      window.__iohubSupportEmail = info.email || '';
      if (info.email) log('почта поддержки: ' + info.email);
      return support;
    })
    // Ошибка не должна мешать: справка и кнопки GitHub работают и без этих строк.
    .catch(function () { return support; });

  function reportFileName() {
    // Имя файла заканчивается теми же восемью символами, что и номер отчёта: по ним файл
    // и письмо из одной истории находятся без сверки.
    if (!reportTicket) reportTicket = newTicket();
    var d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return 'iohub-report-' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate())
      + '-' + reportTicket.slice(-8);
  }

  // Номер отчёта. У веб-версии свой формат «IO-20261119-2CA14D0F»; берём ту же форму,
  // но с нашим префиксом: по нему сразу видно, откуда пришёл отчёт. Номер выдаётся один
  // раз на открытое окно, чтобы «Обновить отчёт», письмо и задача на GitHub говорили об
  // одном и том же случае.
  var reportTicket = '';

  function newTicket() {
    function dec(n) { return (n < 10 ? '0' : '') + n; }
    function hex8(n) { var s = (n >>> 0).toString(16).toUpperCase(); while (s.length < 8) s = '0' + s; return s; }
    var d = new Date();
    var rand = (hex8(Math.floor(Math.random() * 0x100000000))
      + hex8(Math.floor(Math.random() * 0x100000000))).slice(0, 8);
    // Дата в номере — по UTC, как и штамп времени в самом отчёте: иначе у отчёта,
    // составленного поздно вечером, номер и дата расходились бы на сутки.
    return 'HUB-' + d.getUTCFullYear() + dec(d.getUTCMonth() + 1) + dec(d.getUTCDate()) + '-' + rand;
  }

  // Что происходило на экране перед проблемой. Сама страница ведёт свой журнал действий
  // (переключатель «Действия на сайте» в настройках), но он лежит внутри неё и выключен
  // по умолчанию, поэтому держим короткий свой список: последние 60 нажатий кнопок и ссылок.
  var actions = [];
  var ACTIONS_MAX = 60;

  function actionLabel(target) {
    var hit = target && target.closest ? target.closest('button,a,[role="button"],select,input') : null;
    if (!hit) return '';
    if ((reportPanel && reportPanel.contains(hit)) || (helpPanel && helpPanel.contains(hit))
        || (toastBox && toastBox.contains(hit))) return '';
    var text = (hit.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) text = hit.getAttribute('aria-label') || hit.getAttribute('title') || '';
    if (!text && hit.tagName === 'SELECT' && hit.options) {
      text = 'переключатель: ' + (hit.getAttribute('aria-label') || '')
        + ' = ' + (hit.options[hit.selectedIndex] ? hit.options[hit.selectedIndex].textContent.trim() : '?');
    }
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > 60 ? text.slice(0, 60) + '…' : text;
  }

  function recordAction(target) {
    var label = actionLabel(target);
    if (!label) return;
    var last = actions[actions.length - 1];
    var now = Date.now();
    // Двойной клик и клик с удержанием рисуют одно и то же действие несколько раз подряд.
    if (last && last.label === label && now - last.at < 700) return;
    actions.push({ label: label, at: now });
    if (actions.length > ACTIONS_MAX) actions.shift();
  }

  function actionsText() {
    if (!actions.length) return 'действий не записано';
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return actions.map(function (a) {
      var d = new Date(a.at);
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '  ' + a.label;
    }).join('\n');
  }

  // Версия интерфейса: её кладёт в страницу сборщик (см. prepare_webview.py).
  function uiVersion() {
    var m = document.querySelector('meta[name="iohub-ui-version"]');
    return (m && m.content) || 'не записана';
  }

  // Что происходит на экране в момент сборки отчёта — это к журналу хоста не добавить.
  function reportFacts() {
    var opened = [];
    devicesById.forEach(function (dev) {
      if (dev.opened) opened.push(hex(dev.vendorId) + ':' + hex(dev.productId) + ' ' + dev.productName);
    });
    return [
      'интерфейс: ' + uiVersion(),
      'язык интерфейса: ' + uiLang(),
      'шаг приложения: #' + (location.hash || '/'),
      'заголовок: ' + (document.title || '—'),
      'движок: ' + (navigator.userAgent || '—'),
      'разрешено устройств: ' + allowedIds.size,
      'открыто сейчас: ' + (opened.length ? opened.join(', ') : 'нет'),
      'режим HID: ' + window.__iohubHidMode,
      'время: ' + new Date().toISOString(),
    ].join('\n');
  }

  var STYLE = 'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;color:#e7e9ee;';
  var BTN = 'appearance:none;border:1px solid #3a3f4b;background:#2a2f39;color:#e7e9ee;'
    + 'border-radius:8px;padding:8px 12px;cursor:pointer;font:inherit;margin:0 6px 0 0;';
  var BTN_MAIN = BTN + 'background:#4a6cf7;border-color:#4a6cf7;color:#fff;';

  function el(tag, css, text) {
    var n = document.createElement(tag);
    n.setAttribute('style', css);
    if (text != null) n.textContent = text;
    return n;
  }

  var reportPanel = null;
  var reportState = { text: '', fileName: 'iohub-report.txt' };

  function setStatus(msg, bad) {
    var box = reportPanel && reportPanel.querySelector('[data-role=status]');
    if (box) box.textContent = msg || '';
    if (box) box.style.color = bad ? '#ff9c9c' : '#9fb6ff';
  }

  function buildReportPanel() {
    if (reportPanel) return reportPanel;
    var overlay = el('div', 'position:fixed;inset:0;z-index:2147483000;background:rgba(8,10,14,.62);'
      + 'display:flex;align-items:center;justify-content:center;padding:24px;');
    var card = el('div', STYLE + 'background:#1b1e25;border:1px solid #343a46;border-radius:14px;'
      + 'box-shadow:0 18px 60px rgba(0,0,0,.5);width:min(720px,100%);max-height:88vh;overflow:auto;padding:18px 20px;');

    card.appendChild(el('div', 'font-size:16px;font-weight:600;margin-bottom:6px;', 'Сообщить об ошибке'));
    var ticketLine = el('div', 'font-size:12px;color:#9fb6ff;margin-bottom:8px;', '');
    ticketLine.setAttribute('data-role', 'ticket');
    card.appendChild(ticketLine);
    card.appendChild(el('div', 'color:#aab2c0;margin-bottom:12px;line-height:1.45;',
      'Программа работает без интернета, поэтому жалоба никуда не уходит сама. Опишите проблему '
      + 'и выберите, как её передать: письмом на ' + (support.email || 'почту поддержки')
      + ' или задачей в репозитории.'));

    var area = el('textarea', STYLE + 'width:100%;box-sizing:border-box;min-height:76px;resize:vertical;'
      + 'background:#14171d;border:1px solid #343a46;border-radius:8px;padding:9px;color:#e7e9ee;'
      + 'margin-bottom:10px;', '');
    area.setAttribute('placeholder', 'Что не работает? Какую клавиатуру подключали, что нажимали, чего ждали.');
    area.setAttribute('data-role', 'problem');
    card.appendChild(area);

    card.appendChild(el('div', 'color:#aab2c0;margin-bottom:4px;', 'Отчёт (журнал, устройства, версия):'));
    card.appendChild(el('div', 'font-size:11px;color:#7f8896;margin-bottom:4px;',
      'Имя пользователя из путей вырезается. Проверьте текст перед отправкой.'));
    var pre = el('pre', 'margin:0 0 12px;padding:9px;background:#14171d;border:1px solid #343a46;'
      + 'border-radius:8px;max-height:190px;overflow:auto;white-space:pre-wrap;'
      + 'font:11px/1.45 ui-monospace,Consolas,monospace;color:#c8cfdc;', 'собираем…');
    pre.setAttribute('data-role', 'preview');
    card.appendChild(pre);

    var row = el('div', 'display:flex;flex-wrap:wrap;align-items:center;margin-bottom:8px;');
    var bMail = el('button', BTN_MAIN, 'Письмо на ' + (support.email || 'почту'));
    bMail.setAttribute('data-act', 'mail');
    var bGit = el('button', BTN_MAIN, 'Задача на GitHub');
    bGit.setAttribute('data-act', 'github');
    var bSave = el('button', BTN, 'Сохранить в файл');
    bSave.setAttribute('data-act', 'save');
    var bCopy = el('button', BTN, 'Скопировать');
    bCopy.setAttribute('data-act', 'copy');
    var bAgain = el('button', BTN, 'Обновить отчёт');
    bAgain.setAttribute('data-act', 'refresh');
    var bClose = el('button', BTN, 'Закрыть');
    bClose.setAttribute('data-act', 'close');
    [bMail, bGit, bSave, bCopy, bAgain, bClose].forEach(function (b) { row.appendChild(b); });
    card.appendChild(row);

    card.appendChild(el('div', 'font-size:11px;color:#7f8896;line-height:1.5;',
      'Файлы отчётов кладутся в подпапку reports папки данных программы. Их можно приложить к письму '
      + 'или задаче — в тексте письма место ограничено.'));
    var status = el('div', 'font-size:12px;margin-top:6px;min-height:16px;color:#9fb6ff;', '');
    status.setAttribute('data-role', 'status');
    card.appendChild(status);

    overlay.appendChild(card);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) closeReport();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && reportPanel && reportPanel.style.display !== 'none') closeReport();
    });
    overlay.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) return;
      e.preventDefault();
      var act = btn.getAttribute('data-act');
      if (act === 'close') closeReport();
      else if (act === 'refresh') refreshReport();
      else if (act === 'save') saveReport();
      else if (act === 'copy') copyReport();
      else if (act === 'mail') sendMail();
      else if (act === 'github') openIssue();
    });
    document.body.appendChild(overlay);
    reportPanel = overlay;
    return overlay;
  }

  function problemText() {
    var area = reportPanel && reportPanel.querySelector('[data-role=problem]');
    return area ? area.value.trim() : '';
  }

  function refreshReport() {
    var pre = reportPanel && reportPanel.querySelector('[data-role=preview]');
    return invoke('report_bundle', {
      problem: problemText(),
      extra: reportFacts(),
      actions: actionsText(),
      ticket: reportTicket,
      fileName: reportFileName(),
    })
      .then(function (r) {
        reportState.text = (r && r.text) || '';
        reportState.fileName = (r && r.fileName) || 'iohub-report.txt';
        if (pre) pre.textContent = reportState.text;
        setStatus('');
        return r;
      })
      .catch(function (e) {
        if (pre) pre.textContent = 'не удалось собрать отчёт: ' + e;
        setStatus('журнал не собрался: ' + e, true);
      });
  }

  function openReport() {
    // Каждое открытие панели — новый случай и новый номер; «Обновить отчёт» номер сохраняет.
    reportTicket = newTicket();
    buildReportPanel().style.display = 'flex';
    var line = reportPanel.querySelector('[data-role=ticket]');
    if (line) line.textContent = 'Номер отчёта ' + reportTicket + ' — назовите его в письме или задаче.';
    var area = reportPanel.querySelector('[data-role=problem]');
    setTimeout(function () { if (area) area.focus(); }, 30);
    refreshReport();
  }

  function closeReport() {
    if (reportPanel) reportPanel.style.display = 'none';
  }

  // Отчёт всегда сначала сохраняется: его можно приложить к письму или задаче.
  function saveReport() {
    return invoke('save_report', { text: reportState.text, fileName: reportState.fileName })
      .then(function (path) {
        setStatus('сохранено: ' + path);
        return path;
      })
      .catch(function (e) {
        setStatus('не удалось сохранить: ' + e, true);
      });
  }

  // Копируем через скрытое поле: execCommand в WebView2 жив, а clipboard API без жеста
  // пользователя иногда молча отказывает.
  function copyToClipboard(text) {
    var ta = el('textarea', 'position:fixed;left:-2000px;top:0;');
    ta.value = text == null ? '' : String(text);
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function copyReport() {
    if (copyToClipboard(reportState.text)) {
      setStatus('отчёт в буфере обмена');
    } else {
      setStatus('не скопировалось — выделите текст в окне отчёта и нажмите Ctrl+C', true);
    }
  }

  // Плашка внизу окна. Нужна для случаев, когда клик по ссылке программу не устраивает:
  // молча убитая ссылка выглядит как поломка, а здесь видно, что именно не так, и адрес
  // можно забрать себе в буфер обмена.
  var toastBox = null;
  var toastTimer = null;

  function ensureToast() {
    if (toastBox) return toastBox;
    toastBox = el('div', 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);'
      + 'z-index:2147483010;display:none;align-items:center;gap:10px;'
      + 'max-width:min(720px,92vw);background:#20242c;border:1px solid #4a5568;border-radius:10px;'
      + 'box-shadow:0 10px 32px rgba(0,0,0,.45);padding:10px 12px;' + STYLE);
    toastBox.setAttribute('data-iohub', 'toast');
    var msg = el('div', 'line-height:1.4;color:#ffd9a0;', '');
    msg.setAttribute('data-role', 'toast-msg');
    var copy = el('button', BTN, '');
    copy.setAttribute('data-role', 'toast-copy');
    copy.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var texts = helpText(uiLang());
      var link = toastBox.getAttribute('data-url') || '';
      msg.textContent = copyToClipboard(link) ? texts.copied + ': ' + link : texts.copyFail;
    });
    toastBox.appendChild(msg);
    toastBox.appendChild(copy);
    document.body.appendChild(toastBox);
    return toastBox;
  }

  function showToast(message, url) {
    var texts = helpText(uiLang());
    var box = ensureToast();
    box.querySelector('[data-role="toast-msg"]').textContent = message;
    var copy = box.querySelector('[data-role="toast-copy"]');
    if (url) {
      box.setAttribute('data-url', url);
      copy.textContent = texts.copy;
      copy.style.display = '';
    } else {
      copy.style.display = 'none';
    }
    box.style.display = 'flex';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.style.display = 'none'; }, url ? 15000 : 6000);
  }

  function excerpt(n) {
    var t = reportState.text;
    if (t.length <= n) return t;
    return t.slice(0, n) + '\n… (дальше — в файле отчёта)';
  }

  function sendMail() {
    saveReport().then(function () {
      return supportReady;
    }).then(function (info) {
      var mail = info && info.email;
      if (!mail) {
        // Хост не прислал адрес: честнее сказать это прямо, чем получить отказ по белому списку.
        setStatus('адрес почты поддержки не пришёл в программу', true);
        return;
      }
      var subject = (reportTicket ? reportTicket + ' · ' : '') + 'iohub-desktop: '
        + (problemText() || 'не работает настройка клавиатуры').slice(0, 70);
      var body = problemText() + '\n\n---\n' + excerpt(1200)
        + '\n\nФайл отчёта ' + reportState.fileName + ' лежит в подпапке reports папки данных'
        + ' программы — приложите его, пожалуйста, к письму.';
      var href = 'mailto:' + mail + '?subject=' + encodeURIComponent(subject)
        + '&body=' + encodeURIComponent(body);
      invoke('open_link', { url: href })
        .then(function () { setStatus('открываем почтовую программу'); })
        .catch(function (e) { setStatus(String(e), true); });
    });
  }

  function openIssue() {
    var base = support.issues || 'https://github.com/aspidovss/iohub/issues/new';
    var title = ((reportTicket ? reportTicket + ' ' : '')
      + (problemText() || 'Не работает настройка клавиатуры')).slice(0, 90);
    var body = '**Что случилось**\n\n' + (problemText() || '—')
      + '\n\n**Номер отчёта:** ' + (reportTicket || '—')
      + '\n\n**Фрагмент отчёта**\n\n```\n' + excerpt(1800)
      + '\n```\n\nПолный отчёт ' + reportState.fileName + ' лежит в подпапке reports папки данных'
      + ' программы — приложите его к задаче, если в фрагменте не видно главного.';
    var href = base + (base.indexOf('?') === -1 ? '?' : '&') + 'title=' + encodeURIComponent(title)
      + '&body=' + encodeURIComponent(body);
    saveReport().then(function () {
      invoke('open_link', { url: href })
        .then(function () { setStatus('открываем GitHub в браузере'); })
        .catch(function (e) { setStatus(String(e), true); });
    });
  }

  window.__iohubReport = {
    open: openReport,
    close: closeReport,
    info: function () { return support; },
    ticket: function () { return reportTicket; },
    actions: function () { return actions.slice(); },
    // Для проверки сборки: то же самое, что делают кнопки панели, но без рук.
    refresh: function () { return refreshReport(); },
    save: function () { return saveReport(); },
    write: function (text) {
      var area = reportPanel && reportPanel.querySelector('[data-role=problem]');
      if (area) area.value = text == null ? '' : String(text);
      return problemText();
    },
  };

  // ---------------------------------------------------------------- справка и GitHub
  //
  // Программа живёт без интернета, поэтому короткая памятка лежит внутри неё: страница
  // help.html собирается из docs/app-help.html и показывается в окне по кнопке «Справка».
  // Там же и ссылка на репозиторий — единственное место, откуда у программы растут ноги.
  // Кнопки ставим в шапку интерфейса: она одна на всех экранах, и рядом штатная
  // «Сообщить об ошибке». Svelte перерисовывает шапку сам, поэтому кнопки периодически
  // проверяются на месте: выбило — ставим заново.

  var HELP_TEXTS = {
    ru: {
      help: 'Справка', github: 'GitHub', title: 'Краткая справка',
      close: 'Закрыть', report: 'Сообщить об ошибке', mail: 'Почта поддержки',
      loading: 'Загружаем справку…',
      missing: 'Текст справки не нашёлся внутри программы — проверьте файл help.html в сборке.',
      footer: 'Программа неофициальная: интерфейс и прошивки принадлежат их автору.',
      version: 'версия ',
      blocked: 'программа не открывает эту ссылку: ',
      copy: 'скопировать адрес', copied: 'адрес в буфере обмена',
      copyFail: 'не скопировалось — адрес записан в журнал программы',
    },
    en: {
      help: 'Help', github: 'GitHub', title: 'Quick help',
      close: 'Close', report: 'Report a problem', mail: 'Email support',
      loading: 'Loading help…',
      missing: 'The help text is missing from the program — check help.html in the build.',
      footer: 'Unofficial program: the interface and the firmware belong to their author.',
      version: 'version ',
      blocked: 'the program does not open this link: ',
      copy: 'copy address', copied: 'address copied to clipboard',
      copyFail: 'could not copy — the address is written to the program log',
    },
  };

  var helpPanel = null;
  var helpHtml = null;
  var helpEntry = { help: null, git: null, lang: '', announced: false };

  function helpText(lang) { return HELP_TEXTS[lang] || HELP_TEXTS.en; }

  // Язык интерфейса держит переключатель со значениями ru/en; <html lang> подстраивается следом.
  function uiLang() {
    var selects = document.querySelectorAll('header select');
    for (var i = 0; i < selects.length; i++) {
      var values = [];
      for (var j = 0; j < selects[i].options.length; j++) values.push(selects[i].options[j].value);
      if (values.indexOf('ru') !== -1 && values.indexOf('en') !== -1) {
        return String(selects[i].value || '').toLowerCase().indexOf('ru') === 0 ? 'ru' : 'en';
      }
    }
    var tag = String(document.documentElement.lang || '').toLowerCase();
    if (tag.indexOf('ru') === 0) return 'ru';
    if (tag.indexOf('en') === 0) return 'en';
    return /^ru/i.test(navigator.language || '') ? 'ru' : 'en';
  }

  // Кнопка один в один как соседние кнопки шапки: берём их класс у соседа, чтобы
  // вид следовал за темой интерфейса, а не за нашей догадкой о цветах.
  function toolButton(host, label, role) {
    var model = host.querySelector('button:not([data-iohub])');
    var b = document.createElement('button');
    b.setAttribute('data-iohub', role);
    if (model) {
      b.className = model.className;
      b.setAttribute('style', 'cursor:pointer;');
    } else {
      b.setAttribute('style', BTN);
    }
    b.textContent = label;
    return b;
  }

  function headerHost() {
    return document.querySelector('header .extra')
      || document.querySelector('header .brand')
      || document.querySelector('header');
  }

  function ensureHelpEntry() {
    var lang = uiLang();
    var texts = helpText(lang);
    var host = headerHost();
    if (!host) return;
    var live = function (b) { return b && b.isConnected && b.parentNode === host; };
    if (!live(helpEntry.help) || !live(helpEntry.git)) {
      // Svelte перерисовывает шапку когда хочет: старый узел мог остаться в прежнем
      // хосте, а мог исчезнуть совсем. Убираем обе прежние кнопки, иначе в шапке
      // вырастет вторая пара «Справка»/«GitHub».
      if (helpEntry.help) helpEntry.help.remove();
      if (helpEntry.git) helpEntry.git.remove();
      var help = toolButton(host, texts.help, 'help');
      var git = toolButton(host, texts.github, 'github');
      help.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openHelp(); });
      git.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); openRepo(); });
      host.appendChild(help);
      host.appendChild(git);
      helpEntry = { help: help, git: git, lang: lang, announced: helpEntry.announced };
      if (!helpEntry.announced) {
        helpEntry.announced = true;
        log('в шапку добавлены кнопки «' + texts.help + '» и «' + texts.github + '»');
      }
      return;
    }
    if (lang !== helpEntry.lang) {
      helpEntry.help.textContent = texts.help;
      helpEntry.git.textContent = texts.github;
      helpEntry.lang = lang;
      if (helpPanel && helpPanel.style.display !== 'none') renderHelp(lang);
    }
  }

  function openRepo() {
    supportReady.then(function (info) {
      var url = info && info.repo;
      if (!url) { log('адрес репозитория не пришёл из хоста'); return; }
      invoke('open_link', { url: url })
        .then(function () { log('открываем страницу проекта: ' + url); })
        .catch(function (e) { log('ссылка не открыта: ' + url + ' — ' + e); });
    });
  }

  function styleHelp(box) {
    var css = {
      h4: 'margin:14px 0 3px;font-size:13px;font-weight:600;color:#e7e9ee;',
      p: 'margin:0 0 6px;',
      ul: 'margin:0 0 8px;padding-left:18px;',
      li: 'margin:2px 0;',
      code: 'font:12px ui-monospace,Consolas,monospace;background:#14171d;border:1px solid #2b313c;'
        + 'border-radius:5px;padding:1px 4px;color:#cdd5e2;',
      b: 'color:#e7e9ee;font-weight:600;',
      a: 'color:#9fb6ff;',
    };
    Object.keys(css).forEach(function (tag) {
      var nodes = box.querySelectorAll(tag);
      for (var i = 0; i < nodes.length; i++) nodes[i].setAttribute('style', css[tag]);
    });
  }

  // Справка — текст, а не разметка чужих страниц. Оставляем видимость, выбрасывая то, что
  // умеет себя вести: встраиваемые теги, обработчики on*, javascript: в ссылках.
  var HELP_DEAD_TAGS = /^(SCRIPT|IFRAME|OBJECT|EMBED|LINK|STYLE|FORM|BASE|META)$/;
  function sanitizeHelp(root) {
    var nodes = root.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (HELP_DEAD_TAGS.test(n.tagName)) {
        n.remove();
        continue;
      }
      var attrs = n.attributes;
      for (var j = attrs.length - 1; j >= 0; j--) {
        var name = attrs[j].name.toLowerCase();
        var value = attrs[j].value || '';
        var bad = name.indexOf('on') === 0 || name === 'src' || name === 'srcdoc'
          || name === 'formaction' || name === 'data' || name === 'action'
          || (name === 'href' && /^\s*javascript:/i.test(value));
        if (bad) n.removeAttribute(attrs[j].name);
      }
    }
  }

  function renderHelp(lang) {
    var box = helpPanel && helpPanel.querySelector('[data-role=body]');
    if (!box) return;
    var texts = helpText(lang);
    var paint = function (text) {
      var doc = null;
      try {
        doc = new DOMParser().parseFromString(text, 'text/html');
      } catch (e) {
        doc = null;
      }
      var section = doc
        && (doc.querySelector('[data-lang="' + lang + '"]') || doc.querySelector('[data-lang="ru"]'));
      if (!section) {
        box.textContent = texts.missing;
        return;
      }
      // Справку вставляем из локального файла, но не как есть: в DOCUMENT из DOMParser
      // ничего не загружается и не выполняется, поэтому вычищаем обработчики on* и теги,
      // которые что-то подгружают или выполняют, уже там — и только потом переносим в окно.
      sanitizeHelp(section);
      box.innerHTML = '';
      while (section.firstChild) box.appendChild(section.firstChild);
      styleHelp(box);
    };
    if (helpHtml) { paint(helpHtml); return; }
    box.textContent = texts.loading;
    fetch('./help.html', { cache: 'default' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) { helpHtml = text; paint(text); })
      .catch(function (e) {
        box.textContent = texts.missing;
        log('help.html не прочитался: ' + e);
      });
  }

  function buildHelpPanel() {
    if (helpPanel) return helpPanel;
    var texts = helpText(uiLang());
    var overlay = el('div', 'position:fixed;inset:0;z-index:2147483000;background:rgba(8,10,14,.62);'
      + 'display:none;align-items:center;justify-content:center;padding:24px;');
    var card = el('div', STYLE + 'background:#1b1e25;border:1px solid #343a46;border-radius:14px;'
      + 'box-shadow:0 18px 60px rgba(0,0,0,.5);width:min(760px,100%);max-height:88vh;overflow:auto;'
      + 'padding:18px 20px;');

    var head = el('div', 'display:flex;align-items:baseline;justify-content:space-between;gap:12px;');
    var title = el('div', 'font-size:16px;font-weight:600;margin-bottom:6px;', texts.title);
    title.setAttribute('data-role', 'title');
    var version = el('div', 'font-size:11px;color:#7f8896;', '');
    version.setAttribute('data-role', 'version');
    head.appendChild(title);
    head.appendChild(version);
    card.appendChild(head);

    var body = el('div', 'line-height:1.5;color:#c8cfdc;', '');
    body.setAttribute('data-role', 'body');
    card.appendChild(body);

    var row = el('div', 'display:flex;flex-wrap:wrap;align-items:center;margin:14px 0 8px;');
    var bGit = el('button', BTN_MAIN, texts.github);
    bGit.setAttribute('data-act', 'github');
    var bReport = el('button', BTN, texts.report);
    bReport.setAttribute('data-act', 'report');
    var bMail = el('button', BTN, texts.mail);
    bMail.setAttribute('data-act', 'mail');
    var bClose = el('button', BTN, texts.close);
    bClose.setAttribute('data-act', 'close');
    [bGit, bReport, bMail, bClose].forEach(function (b) { row.appendChild(b); });
    card.appendChild(row);

    card.appendChild(el('div', 'font-size:11px;color:#7f8896;line-height:1.5;', texts.footer));
    var status = el('div', 'font-size:12px;margin-top:6px;min-height:16px;color:#9fb6ff;', '');
    status.setAttribute('data-role', 'status');
    card.appendChild(status);

    overlay.appendChild(card);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) closeHelp();
    });
    overlay.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!btn) return;
      e.preventDefault();
      var act = btn.getAttribute('data-act');
      if (act === 'close') closeHelp();
      else if (act === 'github') openRepo();
      else if (act === 'report') { closeHelp(); openReport(); }
      else if (act === 'mail') helpMail();
    });
    document.body.appendChild(overlay);
    helpPanel = overlay;
    return overlay;
  }

  function helpMail() {
    supportReady.then(function (info) {
      var mail = info && info.email;
      if (!mail) return;
      var subject = 'iohub-desktop' + (info.version ? ' ' + info.version : '') + ': вопрос по программе';
      var url = 'mailto:' + mail + '?subject=' + encodeURIComponent(subject);
      invoke('open_link', { url: url })
        .then(function () { helpStatus('открываем письмо на ' + mail); })
        .catch(function (e) { helpStatus(String(e), true); });
    });
  }

  function helpStatus(msg, bad) {
    var box = helpPanel && helpPanel.querySelector('[data-role=status]');
    if (!box) return;
    box.textContent = msg || '';
    box.style.color = bad ? '#ff9c9c' : '#9fb6ff';
  }

  function openHelp() {
    var overlay = buildHelpPanel();
    var lang = uiLang();
    var title = overlay.querySelector('[data-role=title]');
    if (title) title.textContent = helpText(lang).title;
    renderHelp(lang);
    supportReady.then(function (info) {
      var box = helpPanel && helpPanel.querySelector('[data-role=version]');
      if (box && info && info.version) box.textContent = helpText(uiLang()).version + info.version;
    });
    overlay.style.display = 'flex';
    helpStatus('');
  }

  function closeHelp() {
    if (helpPanel) helpPanel.style.display = 'none';
  }

  window.__iohubHelp = {
    open: openHelp,
    close: closeHelp,
    // Где лежат настройки и журнал — первый вопрос при любой неполадке.
    paths: function () { return support; },
  };

  // Подпись программы внизу экрана настроек. Сама программа неофициальная, и человек
  // должен видеть прямо в интерфейсе, какая это оболочка, какой интерфейс внутри и где
  // проект. Ставим строку в конец страницы настроек: там свободное место, а не поверх
  // чужих кнопок. Вид наследуется от страницы — цвет и шрифт берём у её же текста.
  var FOOT_TEXTS = {
    ru: {
      about: 'неофициальная офлайн-программа для клавиатур IO',
      ui: 'интерфейс',
      repo: 'страница проекта',
      problem: 'сообщить об ошибке',
    },
    en: {
      about: 'unofficial offline program for IO keyboards',
      ui: 'interface',
      repo: 'project page',
      problem: 'report a problem',
    },
  };

  var footEntry = { node: null, lang: '' };

  // Экран настроек узнаём по заголовку: классы svelte при следующей сборке интерфейса
  // другие, а слово «Настройки» на месте остаётся.
  function settingsPage() {
    var heads = document.querySelectorAll('h1, h2');
    for (var i = 0; i < heads.length; i++) {
      var t = (heads[i].textContent || '').trim().toLowerCase();
      if (t === 'настройки хаба' || t === 'hub settings') {
        var page = heads[i].closest('.app') || document.body;
        var body = page.querySelector('.surface.strong .page') || page.querySelector('.page');
        return body || null;
      }
    }
    return null;
  }

  function footLink(text, onClick) {
    var a = document.createElement('button');
    a.setAttribute('style', 'appearance:none;background:none;border:0;padding:0;cursor:pointer;'
      + 'font:inherit;color:inherit;text-decoration:underline;opacity:.85;');
    a.textContent = text;
    a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); onClick(); });
    return a;
  }

  function buildFoot(lang) {
    var texts = FOOT_TEXTS[lang] || FOOT_TEXTS.en;
    var box = document.createElement('div');
    box.setAttribute('data-iohub', 'foot');
    box.setAttribute('style', 'margin-top:18px;padding-top:10px;font-size:12px;line-height:1.5;'
      + 'opacity:.72;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;');
    var version = support.version ? ' ' + support.version : '';
    var line = document.createElement('span');
    line.textContent = 'iohub-desktop' + version + ' — ' + texts.about + ' · '
      + texts.ui + ' ' + uiVersion();
    box.appendChild(line);
    box.appendChild(footLink(texts.repo, openRepo));
    box.appendChild(footLink(texts.problem, function () {
      // Из настроек человек обычно уходит в отчёт, а не в справочное окно.
      openReport();
    }));
    return box;
  }

  function ensureFoot() {
    var page = settingsPage();
    var lang = uiLang();
    if (!page) return;
    var live = footEntry.node && footEntry.node.isConnected && footEntry.node.parentNode === page;
    if (live && footEntry.lang === lang) return;
    if (footEntry.node) footEntry.node.remove();
    var node = buildFoot(lang);
    page.appendChild(node);
    footEntry = { node: node, lang: lang };
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && helpPanel && helpPanel.style.display !== 'none') closeHelp();
  });
  // Переключатель языка меняет и наши подписи.
  document.addEventListener('change', function (e) {
    if (e.target && e.target.tagName === 'SELECT') ensureHelpEntry();
  }, true);
  setInterval(function () {
    ensureHelpEntry();
    ensureFoot();
  }, 1200);
  ensureHelpEntry();
  ensureFoot();

  // Кнопка «Сообщить об ошибке» в меню и любые ссылки наружу.
  var REPORT_WORDS = ['сообщить об ошибке', 'report a problem', 'сообщить о проблеме'];
  function outerText(node) {
    var get = function (name) { return node.getAttribute ? (node.getAttribute(name) || '') : ''; };
    // textContent, а не innerText: второй каждый раз заставляет браузер заново считать
    // расположение элементов, а нам хватает простого текста узла.
    return ((node.textContent || '') + ' ' + get('aria-label') + ' ' + get('title'))
      .replace(/\s+/g, ' ').toLowerCase().trim();
  }
  function isReportTrigger(target) {
    // Смотрим только на ближайшую настоящую кнопку или ссылку: перебирать всех предков
    // каждого клика по странице конфигуратора незачем.
    var hit = target && target.closest ? target.closest('button,a,[role="button"]') : null;
    if (!hit) return null;
    // В окнах отчёта и справки свои обработчики: их кнопки здесь не перехватываем.
    if ((reportPanel && reportPanel.contains(hit)) || (helpPanel && helpPanel.contains(hit))) return null;
    var t = outerText(hit);
    return (t && t.length <= 40 && REPORT_WORDS.indexOf(t) !== -1) ? hit : null;
  }
  function linkOf(target) {
    var node = target;
    for (var depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      if (node.tagName === 'A' && node.getAttribute('href')) return node.getAttribute('href');
    }
    return null;
  }
  function externalLink(href) {
    if (/^mailto:/i.test(href)) return href;
    if (!/^https?:/i.test(href) && href.indexOf('//') !== 0) return null;
    try {
      var u = new URL(href, location.href);
      if (u.origin === location.origin) return null;
      return u.href;
    } catch (e) {
      return null;
    }
  }
  function hostOf(url) {
    if (/^mailto:/i.test(url)) return url.slice(0, 60);
    try {
      return new URL(url).host;
    } catch (e) {
      return url.slice(0, 60);
    }
  }
  document.addEventListener('click', function (e) {
    // Первым делом — короткий след действий для отчёта: по нему видно, куда человек
    // нажимал перед поломкой. Собирается только то, что и так лежит в интерфейсе.
    recordAction(e.target);
    if (isReportTrigger(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      // Событие до наших окон не дойдёт, поэтому окно справки закрываем прямо здесь —
      // иначе оно останется висеть под панелью отчёта.
      closeHelp();
      log('кнопка «сообщить об ошибке» перехвачена, открыта панель отчёта');
      openReport();
      return;
    }
    var href = linkOf(e.target);
    if (!href) return;
    var url = externalLink(href);
    if (!url) return;
    e.preventDefault();
    e.stopPropagation();
    invoke('open_link', { url: url })
      .then(function () { log('ссылка из интерфейса: ' + url); })
      .catch(function (err) {
        log('ссылка не открыта: ' + url + ' — ' + err);
        // Раз клик уже подавлен, человек обязан увидеть почему: иначе ссылка кажется
        // сломанной. Адрес можно забрать в буфер обмена и открыть самому.
        var texts = helpText(uiLang());
        showToast(texts.blocked + hostOf(url) + ' — ' + err, url);
      });
  }, true);

  // Push path: the Rust reader thread emits every input report the device sends.
  listen('hid-input-report', function (event) {
    var p = event.payload || {};
    var dev = devicesById.get(p.deviceId);
    if (!dev) {
      log('← вход в закрытое устройство ' + p.deviceId);
      return;
    }
    var raw = Uint8Array.from(p.data || []);
    if (raw.length === 0) return;
    // Когда устройство использует идентификаторы, hidapi ставит его первым байтом; при id=0
    // этого байта в буфере нет, и откусывать первый байт нельзя — иначе кадр съезжает.
    var usesIds = p.usesReportIds === true;
    var reportId = usesIds ? raw[0] : 0;
    var body = usesIds ? raw.subarray(1) : raw;
    if (traceOn) log('← input ' + hex(dev.vendorId) + ':' + hex(dev.productId) + ' id=' + reportId + ' [' + hexDump(body) + ']');
    fire(dev, 'inputreport', {
      device: dev,
      reportId: reportId,
      data: new DataView(body.buffer, body.byteOffset, body.byteLength),
    });
  }).catch(function (e) {
    console.warn('[webhid-shim] cannot listen for input reports: ' + e);
  });

  listen('hid-device-lost', function (event) {
    var p = event.payload || {};
    var dev = devicesById.get(p.deviceId);
    if (!dev) return;
    dev.opened = false;
    fire(dev, 'disconnect', {});
    fire(hid, 'disconnect', { device: dev });
    log('device lost: ' + dev.productName);
  }).catch(function () {});

  log('native HID bridge installed');
})();


