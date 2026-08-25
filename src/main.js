import { parseMetadata } from '@lilohuang/exiftool';
import zeroperlWasmUrl from '@lilohuang/zeroperl-ts/zeroperl.wasm?url';
import './style.css';

const fetchZeroPerlWasm = () => fetch(zeroperlWasmUrl);

const fileInput = document.querySelector('#fileInput');
const analyzeBtn = document.querySelector('#analyzeBtn');
const fileInfo = document.querySelector('#fileInfo');
const statusBox = document.querySelector('#status');
const resultBox = document.querySelector('#result');
const makeEl = document.querySelector('#make');
const modelEl = document.querySelector('#model');
const fileTypeEl = document.querySelector('#fileType');
const shutterCountEl = document.querySelector('#shutterCount');
const sourceTagEl = document.querySelector('#sourceTag');
const messageEl = document.querySelector('#message');
const debugDetails = document.querySelector('#debugDetails');
const debugOutput = document.querySelector('#debugOutput');
const dropZone = document.querySelector('#dropZone');

let selectedFile = null;

const SAFE_SHUTTER_TAGS = new Set([
  'shuttercount',
  'shuttercount2',
  'mechanicalshuttercount',
  'shutteractuations',
]);

function shortTagName(key) {
  return String(key).split(':').pop().replace(/\s+/g, '').toLowerCase();
}

function humanFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function firstTag(metadata, names) {
  const wanted = new Set(names.map((x) => x.toLowerCase()));
  for (const [key, value] of Object.entries(metadata || {})) {
    if (wanted.has(shortTagName(key)) && value !== '' && value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

function normalizeCount(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,\s]/g, '');
    if (/^\d+$/.test(cleaned)) return Number.parseInt(cleaned, 10);
  }
  return null;
}

function findShutterCount(metadata) {
  for (const [key, value] of Object.entries(metadata || {})) {
    if (!SAFE_SHUTTER_TAGS.has(shortTagName(key))) continue;
    const count = normalizeCount(value);
    if (count !== null) return { count, sourceTag: key };
  }
  return null;
}

function relatedTags(metadata) {
  const tokens = ['shutter', 'actuation', 'imagecount', 'filecount', 'count'];
  return Object.fromEntries(
    Object.entries(metadata || {}).filter(([key]) => {
      const lower = key.toLowerCase();
      return tokens.some((token) => lower.includes(token));
    })
  );
}

function setStatus(text, type = 'info') {
  statusBox.textContent = text;
  statusBox.className = `status ${type}`;
}

function clearStatus() {
  statusBox.textContent = '';
  statusBox.className = 'status hidden';
}

function resetResult() {
  resultBox.classList.add('hidden');
  debugDetails.classList.add('hidden');
  debugOutput.textContent = '';
}

function selectFile(file) {
  selectedFile = file || null;
  resetResult();
  clearStatus();

  if (!selectedFile) {
    analyzeBtn.disabled = true;
    fileInfo.classList.add('hidden');
    fileInfo.textContent = '';
    return;
  }

  fileInfo.textContent = `${selectedFile.name} — ${humanFileSize(selectedFile.size)}`;
  fileInfo.classList.remove('hidden');
  analyzeBtn.disabled = false;
}

fileInput.addEventListener('change', () => selectFile(fileInput.files?.[0]));

['dragenter', 'dragover'].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
  });
});

dropZone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) selectFile(file);
});

analyzeBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  analyzeBtn.disabled = true;
  resetResult();
  setStatus('در حال اجرای ExifTool داخل مرورگر… اولین اجرا ممکن است کمی زمان ببرد.', 'loading');

  try {
    const output = await parseMetadata(selectedFile, {
      fetch: fetchZeroPerlWasm,
      args: ['-json', '-a', '-u', '-G1', '-s', '-n'],
      transform: (data) => JSON.parse(data),
    });

    if (!output.success) {
      throw new Error(output.error || 'ExifTool نتوانست فایل را پردازش کند.');
    }

    const metadata = Array.isArray(output.data) ? output.data[0] : output.data;
    if (!metadata || typeof metadata !== 'object') {
      throw new Error('متادیتای قابل خواندن پیدا نشد.');
    }

    const make = firstTag(metadata, ['make']) ?? 'نامشخص';
    const model = firstTag(metadata, ['model', 'cameramodelname']) ?? 'نامشخص';
    const fileType = firstTag(metadata, ['filetype', 'filetypeextension']) ?? selectedFile.name.split('.').pop()?.toUpperCase() ?? 'نامشخص';
    const shutter = findShutterCount(metadata);
    const related = relatedTags(metadata);

    makeEl.textContent = String(make);
    modelEl.textContent = String(model);
    fileTypeEl.textContent = String(fileType);

    if (shutter) {
      shutterCountEl.textContent = new Intl.NumberFormat('fa-IR').format(shutter.count);
      sourceTagEl.textContent = `منبع: ${shutter.sourceTag}`;
      messageEl.textContent = 'این عدد مستقیماً از تگ شاتر داخل متادیتای فایل استخراج شده و تخمین زده نشده است.';
      setStatus('تعداد شاتر پیدا شد.', 'success');
    } else {
      shutterCountEl.textContent = 'قابل استخراج نیست';
      sourceTagEl.textContent = '';
      messageEl.textContent = 'تعداد شاتر این مدل از فایل آپلودشده با تگ قابل‌اعتماد پیدا نشد. فایل اصلی و ویرایش‌نشده دوربین را امتحان کن.';
      setStatus('اطلاعات فایل خوانده شد، اما تگ قابل‌اعتماد تعداد شاتر پیدا نشد.', 'warning');
    }

    if (Object.keys(related).length) {
      debugOutput.textContent = JSON.stringify(related, null, 2);
      debugDetails.classList.remove('hidden');
    }

    resultBox.classList.remove('hidden');
  } catch (error) {
    console.error(error);
    const rawMessage = String(error?.message || 'فایل قابل پردازش نبود.');
    const friendlyMessage = rawMessage.includes('expected magic word')
      ? 'موتور ExifTool درست بارگذاری نشد. چند لحظه بعد صفحه را با Ctrl+F5 رفرش کن و دوباره امتحان کن.'
      : rawMessage;
    setStatus(`خطا: ${friendlyMessage}`, 'error');
  } finally {
    analyzeBtn.disabled = false;
  }
});
