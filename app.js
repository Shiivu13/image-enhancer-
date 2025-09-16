'use strict';

// Elements
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const validationMsg = document.getElementById('validationMsg');
const processBtn = document.getElementById('processBtn');
const resetBtn = document.getElementById('resetBtn');
const progressSection = document.getElementById('progressSection');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const presetSelect = document.getElementById('presetSelect');
const autoProcess = document.getElementById('autoProcess');
const manualSliders = document.getElementById('manualSliders');
const sliderInputs = Array.from(document.querySelectorAll('.sliders input[type="range"]'));
const advancedMode = document.getElementById('advancedMode');
const advancedControls = document.getElementById('advancedControls');
const colorSpaceSel = document.getElementById('colorSpace');
const upscaleSel = document.getElementById('upscale');
const beforeCanvas = document.getElementById('canvasBefore');
const afterCanvas = document.getElementById('canvasAfter');
const afterClip = document.getElementById('afterClip');
const compareSlider = document.getElementById('slider');
const resultSection = document.getElementById('result');
const downloadBtn = document.getElementById('downloadBtn');
const downloadFormat = document.getElementById('downloadFormat');
const downloadQuality = document.getElementById('downloadQuality');
// Ad placeholders (no in-page editor; backend injects)

// State
let originalImageBitmap = null;
let workingImageBitmap = null;
let sourceObjectUrl = null;
let advWorker = null;

const MAX_FILE_MB = 25;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Optional: read initial snippets if backend seeds localStorage
const LS_AD_TOP = 'ad_snippet_top';
const LS_AD_BOTTOM = 'ad_snippet_bottom';

function setValidation(message, type = 'warn') {
  validationMsg.textContent = message || '';
  validationMsg.style.color = type === 'error' ? '#ff6b6b' : type === 'ok' ? '#8bc34a' : '#f0b429';
}

function setProgress(percent, text) {
  progressSection.hidden = false;
  progressFill.style.width = `${percent}%`;
  if (text) progressText.textContent = text;
}

function clearProgress() {
  progressSection.hidden = true;
  progressFill.style.width = '0%';
  progressText.textContent = 'Ready';
}

function resetState() {
  originalImageBitmap && originalImageBitmap.close && originalImageBitmap.close();
  workingImageBitmap && workingImageBitmap.close && workingImageBitmap.close();
  originalImageBitmap = null;
  workingImageBitmap = null;
  if (sourceObjectUrl) {
    URL.revokeObjectURL(sourceObjectUrl);
    sourceObjectUrl = null;
  }
  beforeCanvas.width = beforeCanvas.height = 0;
  afterCanvas.width = afterCanvas.height = 0;
  resultSection.hidden = true;
  setValidation('');
  clearProgress();
  processBtn.disabled = true;
  resetBtn.disabled = true;
  downloadBtn.disabled = true;
}

function pickFile() {
  fileInput.click();
}

function handleBrowseClick(e) {
  e.preventDefault();
  pickFile();
}

function isValidFile(file) {
  if (!file) return false;
  if (!ACCEPTED_TYPES.has(file.type)) {
    setValidation('Unsupported file type. Use JPEG, PNG, or WebP.', 'error');
    return false;
  }
  const sizeMb = file.size / (1024 * 1024);
  if (sizeMb > MAX_FILE_MB) {
    setValidation(`File is too large (${sizeMb.toFixed(1)} MB). Max ${MAX_FILE_MB} MB.`, 'error');
    return false;
  }
  return true;
}

async function readFileToImageBitmap(file) {
  if (!isValidFile(file)) return null;
  setValidation('Loading image...', 'ok');
  sourceObjectUrl = URL.createObjectURL(file);
  const img = document.createElement('img');
  img.decoding = 'async';
  img.src = sourceObjectUrl;
  try {
    await img.decode();
  } catch {
    // Fallback for browsers without decode support
    await new Promise((res, rej) => { img.onload = () => res(); img.onerror = rej; });
  }
  try {
    const bmp = await createImageBitmap(img, { colorSpaceConversion: 'default', imageOrientation: 'from-image', premultiplyAlpha: 'default', resizeQuality: 'high' });
    return bmp;
  } catch (e) {
    console.warn('createImageBitmap failed, using HTMLImageElement fallback', e);
    return img; // Fallback: use the HTMLImageElement directly
  }
}

function fitCanvasToBitmap(canvas, bitmap, maxWidth = 2048, maxHeight = 2048) {
  const bw = typeof bitmap.width === 'number' ? bitmap.width : (bitmap.naturalWidth || 1);
  const bh = typeof bitmap.height === 'number' ? bitmap.height : (bitmap.naturalHeight || 1);
  const scale = Math.min(1, maxWidth / bw, maxHeight / bh);
  canvas.width = Math.max(1, Math.round(bw * scale));
  canvas.height = Math.max(1, Math.round(bh * scale));
}

function drawBitmap(canvas, bitmap) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
}

function updateCompareClip(percent) {
  const wrap = beforeCanvas.parentElement;
  const rect = wrap.getBoundingClientRect();
  const clipX = (percent / 100) * rect.width;
  afterClip.style.clipPath = `inset(0 ${Math.max(0, rect.width - clipX)}px 0 0)`;
}

function updateSliderLabels() {
  for (const input of sliderInputs) {
    const label = document.querySelector(`span[data-for="${input.id}"]`);
    if (label) label.textContent = input.value;
  }
}

// Ads placeholders: do not set innerHTML from client-side to prevent XSS.
function adsLoadToSlots(){ /* backend renders ads server-side */ }

function presetToParams(preset) {
  switch (preset) {
    case 'portrait':
      return { exposure: 0.05, contrast: 1.08, saturation: 1.1, vibrance: 1.15, shadows: 1.08, highlights: 0.95, denoise: 0.25, sharpen: 0.35 };
    case 'landscape':
      return { exposure: 0.02, contrast: 1.1, saturation: 1.15, vibrance: 1.2, shadows: 1.1, highlights: 0.9, denoise: 0.15, sharpen: 0.5 };
    case 'vintage':
      return { exposure: 0.0, contrast: 1.05, saturation: 0.9, vibrance: 0.95, shadows: 1.05, highlights: 0.95, denoise: 0.2, sharpen: 0.3 };
    case 'auto':
    default:
      return { exposure: 0.04, contrast: 1.07, saturation: 1.06, vibrance: 1.08, shadows: 1.07, highlights: 0.93, denoise: 0.2, sharpen: 0.45 };
  }
}

function setParams(params) {
  for (const [k, v] of Object.entries(params)) {
    const el = document.getElementById(k);
    if (el) el.value = String(v);
  }
  updateSliderLabels();
}

function getParams() {
  const p = {};
  for (const input of sliderInputs) p[input.id] = parseFloat(input.value);
  if (colorSpaceSel) p.colorSpace = colorSpaceSel.value;
  if (upscaleSel) p.upscale = parseInt(upscaleSel.value, 10) || 1;
  return p;
}

function enhanceImageData(imageData, params) {
  const { data, width, height } = imageData;
  const p = { ...params };

  const exposure = p.exposure || 0;
  const contrast = p.contrast || 1;
  const saturation = p.saturation || 1;
  const vibrance = p.vibrance || 1;
  const shadows = p.shadows || 1;
  const highlights = p.highlights || 1;
  const denoise = p.denoise || 0;
  const sharpen = p.sharpen || 0;

  // 1) Exposure + Contrast (linear approx in sRGB gamma domain)
  const cAdj = contrast;
  const eAdj = exposure * 255;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    r = Math.min(255, Math.max(0, r * cAdj + eAdj));
    g = Math.min(255, Math.max(0, g * cAdj + eAdj));
    b = Math.min(255, Math.max(0, b * cAdj + eAdj));
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }

  // 2) Shadows/Highlights (simple luminance-based curve)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; // luminance
    const shadowBoost = shadows - 1; // >0 lifts darks
    const highlightReduce = 1 - highlights; // >0 reduces brights
    const shadowFactor = 1 + shadowBoost * (1 - l / 255);
    const highlightFactor = 1 - highlightReduce * (l / 255);
    const f = shadowFactor * highlightFactor;
    data[i] = Math.min(255, Math.max(0, r * f));
    data[i + 1] = Math.min(255, Math.max(0, g * f));
    data[i + 2] = Math.min(255, Math.max(0, b * f));
  }

  // 3) Saturation + Vibrance (HSV-ish, vibrance affects low-sat pixels more)
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const v = max;
    const d = max - min;
    let s = max === 0 ? 0 : d / max;
    const vibranceFactor = 1 + (vibrance - 1) * (1 - s);
    const sCombined = s * saturation * vibranceFactor;
    if (sCombined <= 0) {
      r = g = b = v;
    } else {
      const m = v - sCombined * v;
      let h;
      if (d === 0) h = 0; else if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
      const c = sCombined * v;
      const x = c * (1 - Math.abs((h % 2) - 1));
      let rp = 0, gp = 0, bp = 0;
      if (0 <= h && h < 1) { rp = c; gp = x; bp = 0; }
      else if (1 <= h && h < 2) { rp = x; gp = c; bp = 0; }
      else if (2 <= h && h < 3) { rp = 0; gp = c; bp = x; }
      else if (3 <= h && h < 4) { rp = 0; gp = x; bp = c; }
      else if (4 <= h && h < 5) { rp = x; gp = 0; bp = c; }
      else { rp = c; gp = 0; bp = x; }
      r = rp + m; g = gp + m; b = bp + m;
    }
    data[i] = Math.min(255, Math.max(0, Math.round(r * 255)));
    data[i + 1] = Math.min(255, Math.max(0, Math.round(g * 255)));
    data[i + 2] = Math.min(255, Math.max(0, Math.round(b * 255)));
  }

  // 4) Denoise (simple box blur with small radius scaled by denoise)
  if (denoise > 0.001) {
    const radius = Math.max(0, Math.min(2, Math.round(denoise * 3)));
    if (radius > 0) {
      boxBlur(data, width, height, radius);
    }
  }

  // 5) Sharpen (unsharp mask approximation)
  if (sharpen > 0.001) {
    unsharpMask(data, width, height, 1, sharpen * 0.8);
  }

  return imageData;
}

function boxBlur(data, width, height, radius) {
  const tmp = new Uint8ClampedArray(data);
  const w = width, h = height;
  const pass = (src, dst, w, h, r, horizontal) => {
    const size = r * 2 + 1;
    const inv = 1 / size;
    if (horizontal) {
      for (let y = 0; y < h; y++) {
        let sumR = 0, sumG = 0, sumB = 0;
        for (let k = -r; k <= r; k++) {
          const x = Math.min(w - 1, Math.max(0, k));
          const i = (y * w + x) * 4;
          sumR += src[i]; sumG += src[i + 1]; sumB += src[i + 2];
        }
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          dst[i] = (sumR * inv) | 0;
          dst[i + 1] = (sumG * inv) | 0;
          dst[i + 2] = (sumB * inv) | 0;
          // slide window
          const iAdd = (y * w + Math.min(w - 1, x + r + 1)) * 4;
          const iSub = (y * w + Math.max(0, x - r)) * 4;
          sumR += src[iAdd] - src[iSub];
          sumG += src[iAdd + 1] - src[iSub + 1];
          sumB += src[iAdd + 2] - src[iSub + 2];
        }
      }
    } else {
      for (let x = 0; x < w; x++) {
        let sumR = 0, sumG = 0, sumB = 0;
        for (let k = -r; k <= r; k++) {
          const y = Math.min(h - 1, Math.max(0, k));
          const i = (y * w + x) * 4;
          sumR += src[i]; sumG += src[i + 1]; sumB += src[i + 2];
        }
        for (let y = 0; y < h; y++) {
          const i = (y * w + x) * 4;
          dst[i] = (sumR * inv) | 0;
          dst[i + 1] = (sumG * inv) | 0;
          dst[i + 2] = (sumB * inv) | 0;
          const iAdd = (Math.min(h - 1, y + r + 1) * w + x) * 4;
          const iSub = (Math.max(0, y - r) * w + x) * 4;
          sumR += src[iAdd] - src[iSub];
          sumG += src[iAdd + 1] - src[iSub + 1];
          sumB += src[iAdd + 2] - src[iSub + 2];
        }
      }
    }
  };
  // Horizontal then vertical
  pass(tmp, data, w, h, radius, true);
  tmp.set(data);
  pass(tmp, data, w, h, radius, false);
}

function unsharpMask(data, width, height, radius, amount) {
  const blurred = new Uint8ClampedArray(data);
  boxBlur(blurred, width, height, radius);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp255(data[i] + amount * (data[i] - blurred[i]));
    data[i + 1] = clamp255(data[i + 1] + amount * (data[i + 1] - blurred[i + 1]));
    data[i + 2] = clamp255(data[i + 2] + amount * (data[i + 2] - blurred[i + 2]));
  }
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

async function processCurrentImage(trigger = 'manual') {
  if (!originalImageBitmap) return;
  setProgress(10, 'Preparing...');
  fitCanvasToBitmap(beforeCanvas, originalImageBitmap);
  fitCanvasToBitmap(afterCanvas, originalImageBitmap);
  drawBitmap(beforeCanvas, originalImageBitmap);
  setProgress(25, 'Analyzing...');

  const ctx = afterCanvas.getContext('2d');
  ctx.drawImage(originalImageBitmap, 0, 0, afterCanvas.width, afterCanvas.height);
  let imgData = ctx.getImageData(0, 0, afterCanvas.width, afterCanvas.height);

  const params = getParams();
  if (advancedMode && advancedMode.checked) {
    await processWithWorker(imgData, params);
  } else {
    setProgress(50, 'Enhancing...');
    imgData = enhanceImageData(imgData, params);
    setProgress(80, 'Rendering...');
    ctx.putImageData(imgData, 0, 0);
    setProgress(100, 'Done');
    resultSection.hidden = false;
    downloadBtn.disabled = false;
    updateCompareClip(parseInt(compareSlider.value, 10));
  }
}

function ensureWorker() {
  if (!advWorker) {
    try { advWorker = new Worker('advancedWorker.js'); }
    catch (e) {
      console.warn('Worker failed to init, falling back to main thread.', e);
      advWorker = null;
    }
  }
  return advWorker;
}

function processWithWorker(imgData, params) {
  return new Promise((resolve) => {
    // Disable Advanced Mode on file:// to avoid worker/CORS issues
    if (location.protocol === 'file:') {
      setValidation('Advanced Mode disabled on local file. Use a local server for best results.', 'warn');
      const ctx = afterCanvas.getContext('2d');
      setProgress(50, 'Enhancing...');
      const out = enhanceImageData(imgData, params);
      setProgress(80, 'Rendering...');
      ctx.putImageData(out, 0, 0);
      setProgress(100, 'Done');
      resultSection.hidden = false;
      downloadBtn.disabled = false;
      updateCompareClip(parseInt(compareSlider.value, 10));
      resolve();
      return;
    }
    const worker = ensureWorker();
    if (!worker) {
      // Fallback to main thread simple processing
      const ctx = afterCanvas.getContext('2d');
      setProgress(50, 'Enhancing...');
      const out = enhanceImageData(imgData, params);
      setProgress(80, 'Rendering...');
      ctx.putImageData(out, 0, 0);
      setProgress(100, 'Done');
      resultSection.hidden = false;
      downloadBtn.disabled = false;
      updateCompareClip(parseInt(compareSlider.value, 10));
      resolve();
      return;
    }

    let settled = false;
    const cleanup = () => {
      clearTimeout(timeoutId);
      worker.removeEventListener('message', onMsg);
      worker.onerror = null;
      worker.onmessageerror = null;
    };

    const onMsg = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'progress') {
        setProgress(m.p, m.text);
      } else if (m.type === 'done') {
        if (settled) return; settled = true; cleanup();
        const { width, height, data } = m;
        // Resize output canvas if needed (upscale)
        afterCanvas.width = width;
        afterCanvas.height = height;
        const outImage = new ImageData(new Uint8ClampedArray(data), width, height);
        const ctx = afterCanvas.getContext('2d');
        ctx.putImageData(outImage, 0, 0);
        setProgress(100, 'Done');
        resultSection.hidden = false;
        downloadBtn.disabled = false;
        updateCompareClip(parseInt(compareSlider.value, 10));
        resolve();
      } else if (m.type === 'error') {
        if (settled) return; settled = true; cleanup();
        console.error('Worker error:', m.message);
        setValidation('Advanced processing failed, using basic pipeline.', 'error');
        const ctx = afterCanvas.getContext('2d');
        const out = enhanceImageData(imgData, params);
        ctx.putImageData(out, 0, 0);
        setProgress(100, 'Done');
        resultSection.hidden = false;
        downloadBtn.disabled = false;
        updateCompareClip(parseInt(compareSlider.value, 10));
        resolve();
      }
    };
    worker.addEventListener('message', onMsg);
    worker.onerror = () => {
      if (settled) return; settled = true; cleanup();
      setValidation('Advanced processing failed, using basic pipeline.', 'error');
      const ctx = afterCanvas.getContext('2d');
      const out = enhanceImageData(imgData, params);
      ctx.putImageData(out, 0, 0);
      setProgress(100, 'Done');
      resultSection.hidden = false;
      downloadBtn.disabled = false;
      updateCompareClip(parseInt(compareSlider.value, 10));
      resolve();
    };
    worker.onmessageerror = worker.onerror;
    const timeoutId = setTimeout(() => {
      if (settled) return; settled = true; cleanup();
      setValidation('Advanced processing timed out, using basic pipeline.', 'error');
      const ctx = afterCanvas.getContext('2d');
      const out = enhanceImageData(imgData, params);
      ctx.putImageData(out, 0, 0);
      setProgress(100, 'Done');
      resultSection.hidden = false;
      downloadBtn.disabled = false;
      updateCompareClip(parseInt(compareSlider.value, 10));
      resolve();
    }, 8000);

    // Do NOT transfer the buffer to keep fallback safe
    const payload = new Uint8ClampedArray(imgData.data);
    worker.postMessage({ type: 'process', width: imgData.width, height: imgData.height, data: payload, params });
  });
}

function handleFiles(files) {
  (async () => {
    try {
      resetState();
      const file = files && files[0];
      if (!file) return;
      if (!isValidFile(file)) return;
      const bmp = await readFileToImageBitmap(file);
      if (!bmp) return;
      originalImageBitmap = bmp;
      processBtn.disabled = false;
      resetBtn.disabled = false;
      setValidation('Image loaded.', 'ok');
      if (autoProcess.checked) {
        await processCurrentImage('auto');
      } else {
        // draw preview only
        fitCanvasToBitmap(beforeCanvas, originalImageBitmap);
        drawBitmap(beforeCanvas, originalImageBitmap);
        resultSection.hidden = false;
      }
    } catch (err) {
      console.error(err);
      setValidation('Failed to load or process the image.', 'error');
      clearProgress();
    }
  })();
}

function onDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  const files = e.dataTransfer.files;
  handleFiles(files);
}

function onDragOver(e) {
  e.preventDefault();
}

function onFileChange(e) {
  const files = e.target.files;
  handleFiles(files);
}

function onDownload() {
  if (!afterCanvas.width || !afterCanvas.height) return;
  const type = downloadFormat.value;
  const quality = parseFloat(downloadQuality.value);
  afterCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
    a.download = `enhanced.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, type, type === 'image/jpeg' ? quality : undefined);
}

// 3D tilt interaction for dropzone and canvas card
function addTilt(el, max=4) {
  if (!el) return;
  el.addEventListener('mousemove', (e) => {
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    const rx = (-py * max).toFixed(2);
    const ry = (px * max).toFixed(2);
    const base = el.classList.contains('canvas-wrap') ? 'rotateX(3deg) rotateY(0.5deg)' : 'rotateX(2deg)';
    el.style.transform = `${base} translateZ(0) rotateX(${rx}deg) rotateY(${ry}deg)`;
  });
  el.addEventListener('mouseleave', () => {
    el.style.transform = el.classList.contains('canvas-wrap') ? 'rotateX(3deg) rotateY(0.5deg)' : 'rotateX(2deg)';
  });
}

// Events
browseBtn.addEventListener('click', handleBrowseClick);
fileInput.addEventListener('change', onFileChange);
dropzone.addEventListener('dragover', onDragOver);
dropzone.addEventListener('drop', onDrop);
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    pickFile();
  }
});

processBtn.addEventListener('click', () => processCurrentImage('manual'));
resetBtn.addEventListener('click', resetState);
downloadBtn.addEventListener('click', onDownload);

compareSlider.addEventListener('input', (e) => {
  updateCompareClip(parseInt(e.target.value, 10));
});

presetSelect.addEventListener('change', (e) => {
  const preset = e.target.value;
  if (preset === 'custom') {
    manualSliders.hidden = false;
  } else {
    manualSliders.hidden = true;
    setParams(presetToParams(preset));
    if (autoProcess.checked && originalImageBitmap) processCurrentImage('preset');
  }
});

if (advancedMode) {
  advancedMode.addEventListener('change', () => {
    const on = advancedMode.checked;
    advancedControls.hidden = !on;
    if (on && originalImageBitmap && autoProcess.checked) processCurrentImage('advanced-toggle');
  });
}

for (const input of sliderInputs) {
  input.addEventListener('input', () => {
    updateSliderLabels();
    if (autoProcess.checked && originalImageBitmap) processCurrentImage('tweak');
  });
}

window.addEventListener('resize', () => updateCompareClip(parseInt(compareSlider.value, 10)));

// Initialize defaults
setParams(presetToParams('auto'));
updateCompareClip(parseInt(compareSlider.value, 10));

// Init 3D tilt
addTilt(document.getElementById('dropzone'), 4);
addTilt(document.querySelector('.canvas-wrap'), 5);

// Ads are backend-rendered; nothing to do on client.


