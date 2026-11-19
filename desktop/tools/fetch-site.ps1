<#
.SYNOPSIS
  Скачивает интерфейс web.io.vision в папку vendor/io-web, чтобы программу собиралась без сети.

.DESCRIPTION
  Интерфейс — это одностаничное приложение: браузер сохраняет только тот экран, который
  открыт, а остальные модули, картинки клавиатур и шрифты подгружаются по ходу работы.
  Скрипт делает два шага:

    1. берёт сохранённую браузером страницу (Ctrl+S) и собирает из неё чистый index.html
       без внешних ссылок и без битого тега <script ... .download>;
    2. обходит все ссылки найденного JavaScript и CSS и докачивает то, чего нет на диске,
       повторяя, пока список не опустеет — так попадают и модули поздней загрузки.

  По умолчанию всё лежит рядом с репозиторием: «IO Hub.html» и «IO Hub_files/» — то, что
  сохранил браузер, а результат — в vendor/io-web/. Папки сохранения в git не попадают.

  После скрипта нужно собрать интерфейс заново:

    python desktop/prepare_webview.py
    cd desktop ; cargo tauri build

  Имена файлов у сборки меняются с каждым релизом производителя. Если поменялось имя
  главного файла, проверьте якорь правок в desktop/prepare_webview.py и запустите
  desktop/tools/find_firmware_urls.py.

.PARAMETER Base
  Откуда качать недостающие файлы. По умолчанию https://web.io.vision

.PARAMETER Root
  Корень репозитория. По умолчанию — папка на два уровня выше этого скрипта.

.PARAMETER SavedHtml
  Сохранённая браузером страница. По умолчанию «<Root>/IO Hub.html».

.PARAMETER SavedDir
  Папка с файлами сохранения. По умолчанию «<Root>/IO Hub_files».

.PARAMETER OutDir
  Куда складывать дамп. По умолчанию «<Root>/vendor/io-web».

.EXAMPLE
  .\desktop\tools\fetch-site.ps1
  Сохранить дамп в vendor/io-web тем, что лежит рядом с репозиторием.

.EXAMPLE
  .\desktop\tools\fetch-site.ps1 -OutDir .\.fetch\app
  Потренироваться в отдельной папке, не трогая дамп в репозитории.
#>
[CmdletBinding()]
param(
  [string]$Base = 'https://web.io.vision',
  [string]$Root = '',
  [string]$SavedHtml = '',
  [string]$SavedDir = '',
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
# Индикатор скачивания у Invoke-WebRequest в PowerShell 5.1 отъедает половину времени:
# на сотнях мелких файлов без него быстрее в разы.
$ProgressPreference = 'SilentlyContinue'

if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
if (-not $SavedHtml) { $SavedHtml = Join-Path $Root 'IO Hub.html' }
if (-not $SavedDir) { $SavedDir = Join-Path $Root 'IO Hub_files' }
if (-not $OutDir) { $OutDir = Join-Path $Root 'vendor\io-web' }

foreach ($p in @($SavedHtml, $SavedDir)) {
  if (-not (Test-Path -LiteralPath $p)) {
    throw "Нет «$p». Откройте $Base в браузере, сохраните страницу целиком (Ctrl+S) и повторите."
  }
}

New-Item -ItemType Directory -Force -Path "$OutDir\assets" | Out-Null

# Имена главного файла и стилей берём из сохранённой страницы: у каждой сборки они свои.
$full = Get-Content -LiteralPath $SavedHtml -Raw -Encoding UTF8
$cut = $full.IndexOf('<body')
if ($cut -lt 0) { throw "В файле «$SavedHtml» нет тега <body> — похоже, страница сохранена не целиком (нужно «Страница полностью»). " }
$head = $full.Substring(0, $cut)
$savedLeaf = Split-Path -Leaf $SavedDir

function Find-Saved([string]$name) {
  # Браузер сохраняет главный модуль с суффиксом .download, а иногда и с другим именем.
  $clean = $name -replace '\.download$', ''
  foreach ($cand in @($clean, "$clean.download")) {
    $p = Join-Path $SavedDir $cand
    if (Test-Path -LiteralPath $p) { return $p }
  }
  $stem = [System.IO.Path]::GetFileNameWithoutExtension($clean)
  $ext = [System.IO.Path]::GetExtension($clean)
  $hit = Get-ChildItem -LiteralPath $SavedDir -Filter ($stem + '*' + $ext + '*') | Select-Object -First 1
  if ($hit) { return $hit.FullName }
  return $null
}

$cssName = [regex]::Match($head, 'href="[^"]*?(index[^"/"]+\.css)"').Groups[1].Value
$jsName = [regex]::Match($head, '(?:src|href)="[^"]*?(index[^"/"]+\.js)[^"]*"').Groups[1].Value
if (-not $cssName -or -not $jsName) {
  throw "В сохранённой странице не найдены главный модуль или стили: js=«$jsName» css=«$cssName»."
}

$cssSrc = Find-Saved $cssName
$jsSrc = Find-Saved $jsName
foreach ($pair in @(@($jsSrc, $jsName), @($cssSrc, $cssName))) {
  if (-not $pair[0]) { throw "В папке сохранения нет файла «$($pair[1])»." }
  Copy-Item -LiteralPath $pair[0] -Destination "$OutDir\assets\$($pair[1])" -Force
}
Write-Host "Главный модуль: $jsName ; стили: $cssName"

# Шапка сохранённой страницы: путь к файлам сохранения меняем на локальный /assets/,
# ссылки на чужой домен выбрасываем — программа работает без интернета.
$head = $head -replace ('(?:\./)?' + [regex]::Escape($savedLeaf) + '[\\/]'), '/assets/'
$head = [regex]::Replace($head, '<link[^>]*href="https?://[^"]*"[^>]*>\s*', '')
$head = [regex]::Replace($head, '<script[^>]*src="https?://[^"]*"[^>]*>\s*</script>', '')
# Сохранённая страница ссылается на главный модуль как на файл .download — такой ссылки в
# программе быть не должно, настоящий тег подключения пишется ниже.
$head = [regex]::Replace($head, '<script[^>]*\.download[^>]*>\s*</script>', '')
$html = $head + "<body>`n" +
  '<div id="app"></div>' + "`n" +
  "<script type=`"module`" crossorigin src=`"/assets/$jsName`"></script>`n" +
  "</body>`n</html>`n"
# Без BOM: страницы он не смущает, а диффы и проверка файлов — да.
[System.IO.File]::WriteAllText((Join-Path $OutDir 'index.html'), $html, (New-Object System.Text.UTF8Encoding($false)))

$queue = New-Object System.Collections.Generic.Queue[string]
$seen = New-Object System.Collections.Generic.HashSet[string]

function Add-Refs([string]$t) {
  $found = @()
  # Пути вида assets/... и devices/..., в том числе с ../ в начале.
  $found += [regex]::Matches($t, '(?:\.\./)*((?:assets|devices)/[A-Za-z0-9_.\-/]+\.(?:js|css|svg|json|png|woff2))') |
    ForEach-Object { $_.Groups[1].Value }
  # Файлы, которые собираются назвать по маске имя-хеш.js, но путь к которым собран из частей.
  $found += [regex]::Matches($t, '(?<![A-Za-z0-9_\-])([A-Za-z0-9_\-]+-[A-Za-z0-9_\-]{6,10}\.js)') |
    ForEach-Object { 'assets/' + $_.Groups[1].Value }
  $found += [regex]::Matches($t, '([A-Za-z0-9_\-]+\.woff2)') | ForEach-Object { 'assets/' + $_.Groups[1].Value }
  foreach ($f in $found) { if ($seen.Add($f)) { $queue.Enqueue($f) } }
}

function Get-Asset([string]$rel) {
  $dest = Join-Path $OutDir ($rel -replace '/', '\')
  if (Test-Path -LiteralPath $dest) { return $true }
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  try {
    Invoke-WebRequest -Uri "$Base/$rel" -OutFile $dest -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
    return $true
  } catch {
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
    if ($_ + '' -match 'timed out') { $script:timeouts++ }
    return $false
  }
}

Add-Refs (Get-Content -LiteralPath "$OutDir\assets\$jsName" -Raw -Encoding UTF8)
Add-Refs (Get-Content -LiteralPath "$OutDir\assets\$cssName" -Raw -Encoding UTF8)

# Эти модули появляются только когда пользователь открывает соответствующий экран,
# поэтому в сохранённой странице их нет. Список пополняется по мере изучения интерфейса.
foreach ($e in @('assets/driver-ObUgXM8z.js', 'assets/emitter-WqgolIYy.js',
                 'assets/report-DsRvFWy_.js', 'assets/ui-CqflakEm.js', 'assets/ui-kPywwZvx.css')) {
  if ($seen.Add($e)) { $queue.Enqueue($e) }
}

$ok = 0
$fail = @()
$script:timeouts = 0
while ($queue.Count -gt 0) {
  $r = $queue.Dequeue()
  if (Get-Asset $r) {
    $ok++
    if ($ok % 40 -eq 0) { Write-Host "  скачано $ok, в очереди ещё $($queue.Count)…" }
    if ($r -match '\.(js|css)$') {
      Add-Refs (Get-Content -LiteralPath (Join-Path $OutDir ($r -replace '/', '\')) -Raw -Encoding UTF8)
    }
  } else {
    $fail += $r
  }
}

Write-Host ""
Write-Host "Скачано или уже было: $ok ; всего уникальных ссылок: $($seen.Count)"
if ($script:timeouts) {
  Write-Host "ВАЖНО: $script:timeouts обращений не дождались ответа за 30 секунд — похоже, сети нет или"
  Write-Host "она закрыта (корпоративный прокси, файрвол). Это не «файла нет на сервере»: запустите"
  Write-Host "скрипт ещё раз, когда сеть появится, — уже скачанное он пропустит."
}
Write-Host "Не найдено на сервере: $($fail.Count) — часть путей приложение собирает на лету"
Write-Host "(картинки .art.js, схемы .svg, описания .kle.json их нет в открытом доступе, это нормально)."
$serious = @($fail | Where-Object { $_ -match '\.(js|css|woff2)$' -and $_ -notmatch '\.art\.js$' })
if ($serious.Count) {
  Write-Host "Стоит проверить вручную:"
  $serious | ForEach-Object { Write-Host "  $_" }
} else {
  Write-Host "Среди нескачанного нет ни модулей, ни стилей, ни шрифтов."
}
Write-Host ""
Write-Host "Старые файлы скрипт не удаляет: в $OutDir могут остаться модули от прошлой"
Write-Host "сборки производителя. Для чистого дампа очистите папку вывода и запустите заново."
Write-Host "Дальше: python desktop/prepare_webview.py, затем сборка. Если имя главного файла"
Write-Host "изменилось, поправьте якорь правок в desktop/prepare_webview.py."
