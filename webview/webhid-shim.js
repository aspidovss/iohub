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

  var support = { email: '', repo: '', issues: '', logPath: '' };
  invoke('support_info')
    .then(function (info) {
      if (!info) return;
      support = info;
      window.__iohubSupportEmail = info.email || '';
      if (info.email) log('почта поддержки: ' + info.email);
    })
    .catch(function () {});

  function reportFileName() {
    var d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return 'iohub-report-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
      + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  // Что происходит на экране в момент сборки отчёта — это к журналу хоста не добавить.
  function reportFacts() {
    var opened = [];
    devicesById.forEach(function (dev) {
      if (dev.opened) opened.push(hex(dev.vendorId) + ':' + hex(dev.productId) + ' ' + dev.productName);
    });
    return [
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
    buildReportPanel().style.display = 'flex';
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

  function copyReport() {
    var ta = el('textarea', 'position:fixed;left:-2000px;top:0;');
    ta.value = reportState.text;
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    if (ok) {
      setStatus('отчёт в буфере обмена');
    } else {
      setStatus('не скопировалось — выделите текст в окне отчёта и нажмите Ctrl+C', true);
    }
  }

  function excerpt(n) {
    var t = reportState.text;
    if (t.length <= n) return t;
    return t.slice(0, n) + '\n… (дальше — в файле отчёта)';
  }

  function sendMail() {
    var subject = 'iohub-desktop: ' + (problemText() || 'не работает настройка клавиатуры').slice(0, 70);
    var body = problemText() + '\n\n---\n' + excerpt(1200)
      + '\n\nПолный отчёт лежит в подпапке reports папки данных программы — приложите его, пожалуйста, к письму.';
    var href = 'mailto:' + (support.email || '') + '?subject=' + encodeURIComponent(subject)
      + '&body=' + encodeURIComponent(body);
    saveReport().then(function () {
      invoke('open_link', { url: href })
        .then(function () { setStatus('открываем почтовую программу'); })
        .catch(function (e) { setStatus(String(e), true); });
    });
  }

  function openIssue() {
    var base = support.issues || 'https://github.com/aspidovss/iohub/issues/new';
    var title = (problemText() || 'Не работает настройка клавиатуры').slice(0, 80);
    var body = '**Что случилось**\n\n' + (problemText() || '—') + '\n\n**Журнал**\n\n```\n'
      + excerpt(1800) + '\n```\n\nПолный отчёт лежит в подпапке reports папки данных программы.';
    var href = base + '&title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
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
  };

  // Кнопка «Сообщить об ошибке» в меню и любые ссылки наружу.
  var REPORT_WORDS = ['сообщить об ошибке', 'report a problem', 'сообщить о проблеме'];
  function outerText(node) {
    var get = function (name) { return node.getAttribute ? (node.getAttribute(name) || '') : ''; };
    return ((node.innerText || '') + ' ' + get('aria-label') + ' ' + get('title'))
      .replace(/\s+/g, ' ').toLowerCase().trim();
  }
  function isReportTrigger(target) {
    var node = target;
    for (var depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      if (reportPanel && reportPanel.contains(node)) return false;
      var t = outerText(node);
      if (!t || t.length > 40) continue;
      if (REPORT_WORDS.indexOf(t) !== -1) return node;
    }
    return null;
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
  document.addEventListener('click', function (e) {
    if (isReportTrigger(e.target)) {
      e.preventDefault();
      e.stopPropagation();
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
      .catch(function (err) { log('ссылка не открыта: ' + url + ' — ' + err); });
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


