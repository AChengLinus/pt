'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

// ===== GPU 硬件加速开关（必须在 app ready 之前设置） =====
// 这些开关强制 Chromium 走显卡渲染，避免大图缩放/平移时掉回软件渲染导致卡顿。
app.commandLine.appendSwitch('ignore-gpu-blocklist');               // 忽略显卡黑名单，强制启用 GPU
app.commandLine.appendSwitch('enable-gpu-rasterization');          // 用 GPU 做光栅化
app.commandLine.appendSwitch('enable-zero-copy');                  // 零拷贝纹理上传
app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization');
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('use-angle', 'd3d11');              // Windows 使用 D3D11 渲染后端
}

// 让 JS 堆足够大，避免大图解码时因堆上限而失败
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');

// ===== sharp（libvips）懒加载 =====
// sharp 是原生模块，若与 Electron ABI 不匹配则置空并回退到纯前端解码路径。
let sharp = undefined;
function loadSharp() {
  if (sharp === undefined) {
    try {
      sharp = require('sharp');
      // 限制 libvips 线程数：金字塔生成 / 16-bit 全局统计等重任务默认会占满所有 CPU 核心，
      // 在多核机器上会让整个系统（含文件选择对话框）明显卡顿。固定用 2 个线程，
      // 给 UI 与系统留出资源，代价是金字塔生成稍慢（后台懒加载任务，可接受）。
      try { sharp.concurrency(2); } catch (e2) {}
    } catch (e) {
      console.error('[sharp] 加载失败，回退到纯前端解码：', e && e.message);
      sharp = null;
    }
  }
  return sharp;
}

// 主窗口
let mainWindow = null;
let allowClose = false;   // 渲染进程确认关闭后置真，放行窗口关闭（防误触退出）

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#eaf3fb',
    title: 'EL 点位标注工具',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,            // 允许 preload 使用 webUtils 等能力
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.webContents.on('will-navigate', (e, url) => {
    // 阻止页面跳转到外链，仅允许加载本地页面
    if (!url.startsWith('file://')) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.on('closed', () => { mainWindow = null; });

  // 关闭窗口防误触：首次关闭先拦截并通知渲染进程（有未导出标注时弹确认），确认后再真正关闭
  mainWindow.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    mainWindow.webContents.send('app:close-request');
  });
}

// ===== 应用菜单 =====
function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开图片…',
          accelerator: 'CmdOrCtrl+O',
          click: () => openImageDialog()
        },
        {
          label: '关闭图片',
          click: () => { if (mainWindow) mainWindow.webContents.send('menu:close-image'); }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '查看 GPU 加速状态',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('app:gpu-report');
            }
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 弹出系统文件选择框，返回 { path, name } 或 null。
// 打开前先向渲染进程发「静音」信号，暂停取瓦片/金字塔等 libvips 重任务，
// 否则这些后台解码占满 CPU 会让系统文件对话框明显卡死；返回后恢复。
async function pickImageFile() {
  if (!mainWindow) return null;
  mainWindow.webContents.send('bg:pause');
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择图片或 CAD 图纸',
      properties: ['openFile'],
      filters: [
        { name: '图片 / TIFF / PDF / CAD', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'pdf', 'dxf', 'dwg'] },
        { name: 'CAD 图纸', extensions: ['dxf', 'dwg'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = result.filePaths[0];
    return { path: filePath, name: path.basename(filePath) };
  } finally {
    mainWindow.webContents.send('bg:resume');
  }
}

// 菜单“打开图片”入口：选中后经 menu:open 通知渲染进程加载
async function openImageDialog() {
  const picked = await pickImageFile();
  if (!picked || !mainWindow) return;
  mainWindow.webContents.send('menu:open', picked);
}

// ===== IPC =====
// 渲染进程确认关闭（防误触弹窗点「退出」后），放行窗口关闭
ipcMain.on('app:confirm-close', () => {
  allowClose = true;
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('app:gpu-info', () => {
  const s = loadSharp();
  // getGPUFeatureStatus 返回纯字符串键值，可直接序列化；getGPUInfo 含不可克隆对象，故不返回。
  let featureStatus = {};
  try { featureStatus = JSON.parse(JSON.stringify(app.getGPUFeatureStatus() || {})); } catch (e) {}
  return {
    gpuFeatureStatus: featureStatus,
    sharpLoaded: !!s,
    platform: process.platform,
    arch: process.arch,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  };
});

// 页面内“打开图片”按钮统一走主进程系统对话框（与菜单一致），返回 { path, name } 或 null
ipcMain.handle('image:open', async () => {
  return pickImageFile();
});

// 获取图片元信息（含 16-bit 灰度的全局最小/最大值，用于跨瓦片一致归一化）
ipcMain.handle('image:meta', async (e, filePath) => {
  const s = loadSharp();
  if (!s) throw new Error('图像引擎不可用');
  try {
    const meta = await s(filePath, { limitInputPixels: false }).metadata();
    let min = null, max = null;
    // 仅对 16-bit 灰度/彩色计算全局 min/max（8-bit 无需）。stats 返回的是原始像素值（16-bit 即 0~65535）。
    if (meta.depth === 'ushort' || meta.depth === 'short') {
      try {
        const stats = await s(filePath, { limitInputPixels: false }).stats();
        if (stats && stats.channels && stats.channels.length) {
          const c0 = stats.channels[0];
          min = c0.min;
          max = c0.max;
        }
      } catch (err) {
        min = null; max = null;
      }
    }
    return {
      width: meta.width,
      height: meta.height,
      format: meta.format || '',
      depth: meta.depth || 'uchar',
      channels: meta.channels || 0,
      min, max
    };
  } catch (e) {
    throw new Error('无法读取图片：' + (e && e.message ? e.message : '未知错误'));
  }
});

// 渲染可见区域瓦片：提取 + 归一化 + 缩放到目标尺寸，输出 JPEG 缓冲
ipcMain.handle('image:region', async (e, filePath, opts) => {
  const s = loadSharp();
  if (!s) throw new Error('图像引擎不可用');
  const outW = Math.max(1, Math.min(8192, Math.floor(opts.outW)));
  const outH = Math.max(1, Math.min(8192, Math.floor(opts.outH)));
  const quality = opts.quality != null ? opts.quality : 85;

  // 先取尺寸并 clamp 提取区域：浮点/取整误差会让 left+width 越过图像边界，
  // 直接导致 libvips 报错（extract_area: bad extract area），图片边缘被切。这里统一夹到边界内。
  const meta = await s(filePath, { limitInputPixels: false }).metadata();
  const iw = meta.width, ih = meta.height;
  const left = Math.max(0, Math.min(iw - 1, Math.floor(opts.left)));
  const top = Math.max(0, Math.min(ih - 1, Math.floor(opts.top)));
  const width = Math.max(1, Math.min(iw - left, Math.floor(opts.width)));
  const height = Math.max(1, Math.min(ih - top, Math.floor(opts.height)));

  let pipeline = s(filePath, { limitInputPixels: false }).extract({ left, top, width, height });

  // 16-bit → 8-bit：线性拉伸到全 16-bit 范围，再由 libvips 右移 8 位得到 8-bit
  if (opts.min != null && opts.max != null && opts.max > opts.min) {
    const a = 65535 / (opts.max - opts.min);
    const b = -opts.min * a;
    pipeline = pipeline.linear(a, b);
  } else if ((opts.depth || meta.depth) === 'ushort' || (opts.depth || meta.depth) === 'short') {
    pipeline = pipeline.normalise(); // 无全局统计时退化为逐块归一化
  }

  const buf = await pipeline
    .resize(outW, outH, { fit: 'fill', kernel: 'lanczos3' })
    .jpeg({ quality, chromaSubsampling: '4:4:4' })
    .toBuffer();

  return buf; // Buffer 经 IPC 到渲染进程后成为 Uint8Array
});

// 生成整图概览（低分辨率基础层）：用 shrink-on-load 快速缩放，供缩放/平移时的 GPU 合成层兜底
ipcMain.handle('image:overview', async (e, filePath, maxDim, min, max) => {
  const s = loadSharp();
  if (!s) throw new Error('图像引擎不可用');
  const meta = await s(filePath, { limitInputPixels: false }).metadata();
  const maxd = Math.max(1, Math.floor(maxDim || 2048));
  const scale = Math.min(1, maxd / Math.max(meta.width, meta.height));

  let pipeline = s(filePath, { limitInputPixels: false });
  // 16-bit 灰度先归一化，避免概览整体过暗；优先复用 image:meta 已算好的全局 min/max
  if (meta.depth === 'ushort' || meta.depth === 'short') {
    if (min != null && max != null && max > min) {
      const a = 65535 / (max - min);
      pipeline = pipeline.linear(a, -min * a);
    } else {
      try {
        const stats = await s(filePath, { limitInputPixels: false }).stats();
        if (stats && stats.channels && stats.channels.length && stats.channels[0].max > stats.channels[0].min) {
          const c0 = stats.channels[0];
          const a = 65535 / (c0.max - c0.min);
          pipeline = pipeline.linear(a, -c0.min * a);
        }
      } catch (err) {}
    }
  }

  const ow = Math.max(1, Math.round(meta.width * scale));
  const oh = Math.max(1, Math.round(meta.height * scale));

  const buf = await pipeline
    .resize(ow, oh, { fit: 'fill', kernel: 'lanczos3' })
    .jpeg({ quality: 82, chromaSubsampling: '4:4:4' })
    .toBuffer();

  return { buf, ow, oh };
});

// 生成/复用图像金字塔（tiled pyramidal TIFF）。
// JPEG 等顺序解码格式随机访问极慢（放大取瓦片要 1 秒级），预生成金字塔后降到几十毫秒。
// 缓存放在应用数据目录（而非系统临时目录，避免被系统清理/重启后重建），并设 LRU 上限防磁盘写满。
const PYRAMID_DIR = path.join(app.getPath('userData'), 'pyramid-cache');
const PYRAMID_MAX_KEEP = 6;   // 最多保留 6 个金字塔文件，超出按修改时间删最旧

function prunePyramidCache(dir) {
  let files = [];
  try {
    files = require('fs').readdirSync(dir)
      .filter(function (f) { return f.slice(-4) === '.tif'; })
      .map(function (f) { return path.join(dir, f); });
  } catch (e) { return; }
  if (files.length <= PYRAMID_MAX_KEEP) return;
  files.sort(function (a, b) {
    try { return require('fs').statSync(a).mtimeMs - require('fs').statSync(b).mtimeMs; }
    catch (e) { return 0; }
  });
  for (let i = 0; i < files.length - PYRAMID_MAX_KEEP; i++) {
    try { require('fs').unlinkSync(files[i]); } catch (e) {}
  }
}

ipcMain.handle('image:ensure-pyramid', async (e, filePath) => {
  const s = loadSharp();
  if (!s) throw new Error('图像引擎不可用');
  const fs = require('fs');
  const crypto = require('crypto');
  const st = fs.statSync(filePath);
  // 用「路径 + 大小 + 修改时间」做缓存键，同一文件复用，避免重复生成
  const key = crypto.createHash('md5')
    .update(filePath + ':' + st.size + ':' + Math.floor(st.mtimeMs))
    .digest('hex').slice(0, 16);
  const dir = PYRAMID_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const pyrPath = path.join(dir, key + '.tif');
  if (fs.existsSync(pyrPath)) return { path: pyrPath, cached: true };

  const meta = await s(filePath, { limitInputPixels: false }).metadata();
  const is16 = meta.depth === 'ushort' || meta.depth === 'short';
  // jpeg 压缩仅支持 8-bit；16-bit 用 lzw 无损
  const tmpPath = pyrPath + '.tmp';
  try { fs.unlinkSync(tmpPath); } catch (e) {}
  await s(filePath, { limitInputPixels: false })
    .tiff({
      pyramid: true,
      tile: true,
      tileWidth: 256,
      tileHeight: 256,
      compression: is16 ? 'lzw' : 'jpeg',
      quality: 88
    })
    .toFile(tmpPath);
  fs.renameSync(tmpPath, pyrPath);   // 原子重命名，避免中断留下损坏的缓存文件
  prunePyramidCache(dir);            // 清理最旧的缓存，防止金字塔文件占满磁盘
  return { path: pyrPath, cached: false };
});

// 将整图缩放到指定分辨率（超大图整图导出时的底图），返回 JPEG 缓冲
ipcMain.handle('image:render-resized', async (e, filePath, outW, outH, min, max, depth) => {
  const s = loadSharp();
  if (!s) throw new Error('图像引擎不可用');
  const w = Math.max(1, Math.min(16384, Math.floor(outW)));
  const h = Math.max(1, Math.min(16384, Math.floor(outH)));
  let pipeline = s(filePath, { limitInputPixels: false });
  if (min != null && max != null && max > min) {
    const a = 65535 / (max - min);
    pipeline = pipeline.linear(a, -min * a);
  } else if (depth === 'ushort' || depth === 'short') {
    pipeline = pipeline.normalise();
  }
  const buf = await pipeline
    .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return buf;
});

// 拖拽/粘贴的文件若拿不到真实路径，则写入临时目录后返回路径
ipcMain.handle('file:save-temp', async (e, name, arrayBuffer) => {
  const buf = Buffer.from(arrayBuffer);
  const dir = path.join(os.tmpdir(), 'el-marker');
  require('fs').mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, Date.now() + '_' + (name || 'image'));
  await require('fs').promises.writeFile(filePath, buf);
  return filePath;
});

// ===== DWG → DXF 转换 =====
// 设计要点：
//   1) 不打包任何第三方转换器，只探测本机已有的：AutoCAD 核心控制台（accoreconsole）
//      → ODA File Converter → LibreDWG dwg2dxf。用户机器上装了哪个就用哪个。
//   2) accoreconsole 靠脚本文件驱动。脚本里的输出路径是按「当前代码页」解释的字节串，
//      中文路径会被写坏，所以工作目录必须是纯 ASCII 路径（见 asciiTempRoot）。
//   3) 转换是秒级～十几秒的重活，且会占用一个 CAD 许可席位（进程退出即释放、不消耗授权）。
//      因此产出的 DXF 按「路径+大小+修改时间」缓存复用，避免重复转换。
//   4) 同一时刻只允许一个转换进程：新任务到来时先杀掉上一个，防止进程堆积。

let DWG_TOOL;              // undefined = 未探测 | null = 无可用工具 | { kind, exe, dir }
let dwgChild = null;       // 当前正在运行的转换子进程

// 选一个「纯 ASCII 且可写」的临时根目录。
// 之所以如此苛刻：accoreconsole 的 .scr 脚本按 ANSI 代码页读取，中文路径会在写文件时乱码。
function asciiTempRoot() {
  const cands = [
    path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'ELMarker'),
    path.join(os.tmpdir(), 'elmarker-dwg'),
    path.join(app.getPath('userData'), 'dwg-tmp')
  ];
  for (let i = 0; i < cands.length; i++) {
    if (/^[\x20-\x7E]+$/.test(cands[i])) return cands[i];
  }
  return cands[cands.length - 1];
}
const DWG_ROOT = asciiTempRoot();
const DWG_CACHE_DIR = path.join(DWG_ROOT, 'cache');   // 转换结果缓存
const DWG_WORK_DIR = path.join(DWG_ROOT, 'work');     // 转换过程的临时目录
const DWG_CACHE_MAX_KEEP = 12;

// 允许用户在 userData/dwg-tools.json 里显式指定转换器路径：
//   { "accoreconsole": "...", "oda": "...", "dwg2dxf": "..." }
function readDwgToolConfig() {
  try {
    const p = path.join(app.getPath('userData'), 'dwg-tools.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (e) {}
  return {};
}

function existsFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; }
}

// 读注册表里 AutoCAD 的安装位置（HKLM\SOFTWARE\Autodesk\AutoCAD\R*\ACAD-* 的 AcadLocation）。
// reg.exe 输出按控制台代码页编码，这里用 latin1 做「逐字节保留」解码：
// 纯 ASCII 路径能原样拿到；含中文的会变成乱码，随后的 existsFile 校验会自然淘汰它，回落到目录扫描。
function findAccoreConsoleByRegistry() {
  const roots = ['HKLM\\SOFTWARE\\Autodesk\\AutoCAD', 'HKLM\\SOFTWARE\\WOW6432Node\\Autodesk\\AutoCAD'];
  for (let i = 0; i < roots.length; i++) {
    let out = '';
    try {
      out = execFileSync('reg', ['query', roots[i], '/s', '/v', 'AcadLocation'],
        { encoding: 'buffer', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString('latin1');
    } catch (e) { continue; }
    const re = /AcadLocation\s+REG_SZ\s+([^\r\n]+)/g;
    let m;
    while ((m = re.exec(out))) {
      const exe = path.join(m[1].trim(), 'accoreconsole.exe');
      if (existsFile(exe)) return { kind: 'accoreconsole', exe, dir: path.dirname(exe) };
    }
  }
  return null;
}

// 扫描各磁盘的 Program Files 下的 Autodesk\AutoCAD*
function findAccoreConsoleByScan() {
  const drives = ['C:', 'D:', 'E:', 'F:', 'G:'];
  for (let d = 0; d < drives.length; d++) {
    const bases = [
      drives[d] + '\\Program Files\\Autodesk',
      drives[d] + '\\Program Files (x86)\\Autodesk'
    ];
    for (let b = 0; b < bases.length; b++) {
      let names;
      try { names = fs.readdirSync(bases[b]); } catch (e) { continue; }
      for (let n = 0; n < names.length; n++) {
        if (!/^AutoCAD/i.test(names[n])) continue;
        const dir = path.join(bases[b], names[n]);
        const exe = path.join(dir, 'accoreconsole.exe');
        if (existsFile(exe)) return { kind: 'accoreconsole', exe, dir };
      }
    }
  }
  return null;
}

function findOdaConverter() {
  const drives = ['C:', 'D:', 'E:', 'F:'];
  for (let d = 0; d < drives.length; d++) {
    const bases = [
      drives[d] + '\\Program Files\\ODA',
      drives[d] + '\\Program Files (x86)\\ODA'
    ];
    for (let b = 0; b < bases.length; b++) {
      let names;
      try { names = fs.readdirSync(bases[b]); } catch (e) { continue; }
      for (let n = 0; n < names.length; n++) {
        const exe = path.join(bases[b], names[n], 'ODAFileConverter.exe');
        if (existsFile(exe)) return { kind: 'oda', exe, dir: path.dirname(exe) };
      }
    }
  }
  return null;
}

function findOnPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (let i = 0; i < dirs.length; i++) {
    if (!dirs[i]) continue;
    const exe = path.join(dirs[i], name);
    if (existsFile(exe)) return exe;
  }
  return null;
}

function probeDwgTool() {
  if (DWG_TOOL !== undefined) return DWG_TOOL;
  const cfg = readDwgToolConfig();
  const pick = function (p, kind) {
    return existsFile(p) ? { kind: kind, exe: p, dir: path.dirname(p) } : null;
  };
  DWG_TOOL =
    pick(cfg.accoreconsole, 'accoreconsole') ||
    findAccoreConsoleByRegistry() ||
    findAccoreConsoleByScan() ||
    pick(cfg.oda, 'oda') ||
    findOdaConverter() ||
    pick(cfg.dwg2dxf, 'dwg2dxf') ||
    (function () { const e = findOnPath('dwg2dxf.exe'); return e ? { kind: 'dwg2dxf', exe: e, dir: path.dirname(e) } : null; })() ||
    null;
  return DWG_TOOL;
}

// 跑一个子进程并收集输出（args 数组传参，不经 shell，文件名里的空格/中文/引号都安全）
function runProcess(exe, args, cwd, timeoutMs) {
  return new Promise(function (resolve) {
    let child;
    try {
      child = spawn(exe, args, { cwd: cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, out: '', err: String((e && e.message) || e) });
      return;
    }
    let out = '', err = '', done = false;
    const finish = function (r) { if (!done) { done = true; clearTimeout(timer); if (dwgChild === child) dwgChild = null; resolve(r); } };
    const timer = setTimeout(function () {
      try { child.kill(); } catch (e) {}
      finish({ code: -2, out: out, err: '转换超时（' + Math.round(timeoutMs / 1000) + ' 秒）' });
    }, timeoutMs);
    // accoreconsole 的 stdout 是 UTF-16LE，这里只需错误摘要，稳妥起见用 latin1 逐字节保留再截断
    child.stdout.on('data', function (d) { out += d.toString('latin1'); });
    child.stderr.on('data', function (d) { err += d.toString('utf8'); });
    child.on('error', function (e) { finish({ code: -1, out: out, err: String((e && e.message) || e) }); });
    child.on('close', function (code) { finish({ code: code, out: out, err: err }); });
    dwgChild = child;
  });
}

// accoreconsole 的脚本内容。
// 每一行都是「系统变量名/命令 + 回车输入的值」，不能有多余空行 ——
// AutoCAD 脚本里的空行含义是「重复上一条命令」，会导致 DXFOUT 反复执行并吃掉后面的 _QUIT。
function buildAccoreScript(dxfPath) {
  return [
    'CMDECHO', '0',            // 关命令回显，脚本输出干净
    'FILEDIA', '0',            // 关文件对话框，改用命令行参数
    'EXPERT', '5',             // 抑制「覆盖已有文件」等确认提示
    '_DXFOUT',                 // 下划线前缀 = 命令的国际化名称，规避简体中文版本地化关键字
    dxfPath.replace(/\\/g, '/'),
    '16',                      // 精度：16 位小数（ASCII 输出，dxf-parser 可读）
    '_QUIT'                    // 退出，释放许可席位
  ].join('\r\n');
}

function pruneDwgCache() {
  let files = [];
  try {
    files = fs.readdirSync(DWG_CACHE_DIR)
      .filter(function (f) { return f.slice(-4).toLowerCase() === '.dxf'; })
      .map(function (f) { return path.join(DWG_CACHE_DIR, f); });
  } catch (e) { return; }
  if (files.length <= DWG_CACHE_MAX_KEEP) return;
  files.sort(function (a, b) {
    try { return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs; } catch (e) { return 0; }
  });
  for (let i = 0; i < files.length - DWG_CACHE_MAX_KEEP; i++) {
    try { fs.unlinkSync(files[i]); } catch (e) {}
  }
}

async function convertDwgToDxf(dwgPath) {
  const tool = probeDwgTool();
  if (!tool) throw new Error('未找到可用的 DWG 转换器（需要 AutoCAD / ODA File Converter / dwg2dxf 其一）');

  // 同一时刻只留一个转换进程：新任务到来时先杀掉上一个，避免进程堆积占满 CPU 与许可席位
  if (dwgChild) { try { dwgChild.kill(); } catch (e) {} dwgChild = null; }

  const st = fs.statSync(dwgPath);
  const key = crypto.createHash('md5')
    .update(tool.kind + ':' + dwgPath + ':' + st.size + ':' + Math.floor(st.mtimeMs))
    .digest('hex').slice(0, 16);

  fs.mkdirSync(DWG_CACHE_DIR, { recursive: true });
  const cachePath = path.join(DWG_CACHE_DIR, key + '.dxf');
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
    return { dxfPath: cachePath, cached: true, tool: tool.kind };
  }

  // 每次转换独占一个工作子目录，避免并发/重试时互相踩踏
  const work = path.join(DWG_WORK_DIR, key + '_' + Date.now());
  fs.mkdirSync(work, { recursive: true });
  try {
    let produced = null;

    if (tool.kind === 'accoreconsole') {
      const dxfPath = path.join(work, 'out.dxf');
      const scrPath = path.join(work, 'conv.scr');
      // 脚本必须逐字节写入：latin1 保留 ASCII 原样，且不写 BOM（BOM 会成为命令的一部分）
      fs.writeFileSync(scrPath, buildAccoreScript(dxfPath), 'latin1');
      const res = await runProcess(tool.exe, ['/i', dwgPath, '/s', scrPath], tool.dir, 180000);
      if (!existsFile(dxfPath) || fs.statSync(dxfPath).size === 0) {
        const detail = (res.err || res.out || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300);
        throw new Error('AutoCAD 未能输出 DXF' + (detail ? '：' + detail : ''));
      }
      produced = dxfPath;

    } else if (tool.kind === 'oda') {
      // ODA File Converter 是「目录进、目录出」的批处理工具：
      //   ODAFileConverter <输入目录> <输出目录> <版本> <格式> <是否递归> <是否审核> [过滤器]
      const inDir = path.join(work, 'in');
      const outDir = path.join(work, 'out');
      fs.mkdirSync(inDir, { recursive: true });
      fs.mkdirSync(outDir, { recursive: true });
      const inFile = path.join(inDir, path.basename(dwgPath));
      fs.copyFileSync(dwgPath, inFile);
      const res = await runProcess(tool.exe,
        [inDir, outDir, 'ACAD2018', 'DXF', '0', '1'], tool.dir, 180000);
      const names = fs.readdirSync(outDir).filter(function (f) { return f.slice(-4).toLowerCase() === '.dxf'; });
      if (!names.length) {
        const detail = (res.err || res.out || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300);
        throw new Error('ODA File Converter 未能输出 DXF' + (detail ? '：' + detail : ''));
      }
      produced = path.join(outDir, names[0]);

    } else {
      // LibreDWG dwg2dxf：文件进、文件出
      const dxfPath = path.join(work, 'out.dxf');
      const res = await runProcess(tool.exe, ['-y', '-o', dxfPath, dwgPath], tool.dir, 120000);
      if (!existsFile(dxfPath) || fs.statSync(dxfPath).size === 0) {
        const detail = (res.err || res.out || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300);
        throw new Error('dwg2dxf 未能输出 DXF' + (detail ? '：' + detail : ''));
      }
      produced = dxfPath;
    }

    // 原子落缓存：先拷到 .tmp 再改名，避免中断留下半截文件被当成有效缓存
    const tmp = cachePath + '.tmp';
    fs.copyFileSync(produced, tmp);
    fs.renameSync(tmp, cachePath);
    pruneDwgCache();
    return { dxfPath: cachePath, cached: false, tool: tool.kind };

  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  }
}

// 探测转换器（渲染进程据此决定「打开 DWG」是否可用，并在缺失时给出明确指引）
ipcMain.handle('dwg:probe', () => {
  const t = probeDwgTool();
  return {
    available: !!t,
    kind: t ? t.kind : '',
    name: t ? ({ accoreconsole: 'AutoCAD 核心控制台', oda: 'ODA File Converter', dwg2dxf: 'LibreDWG dwg2dxf' }[t.kind] || t.kind) : '',
    exe: t ? t.exe : '',
    configPath: path.join(app.getPath('userData'), 'dwg-tools.json')
  };
});

// 把 DWG 转成 DXF，返回 { dxfPath, cached, tool }
ipcMain.handle('dwg:convert', async (e, dwgPath) => {
  if (!dwgPath || !existsFile(dwgPath)) throw new Error('文件不存在：' + dwgPath);
  if (path.extname(dwgPath).toLowerCase() !== '.dwg') throw new Error('不是 DWG 文件');
  return convertDwgToDxf(dwgPath);
});

// 读取任意文件为二进制（渲染进程读回转换后的 DXF）
ipcMain.handle('file:read', async (e, filePath) => {
  if (!filePath || !existsFile(filePath)) throw new Error('文件不存在：' + filePath);
  return fs.readFileSync(filePath);   // Buffer → 渲染进程收到 Uint8Array
});

// 应用启动
app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 强制退出：金字塔生成等 libvips 后台任务会阻塞进程退出，导致「关不掉」。
// 窗口关闭后标注数据已落盘，这里直接终止进程，不等待后台任务完成。
app.on('will-quit', () => {
  // 清理可能还在跑的 DWG 转换子进程（accoreconsole），否则会留下占用许可席位的孤儿进程
  if (dwgChild) { try { dwgChild.kill(); } catch (e) {} dwgChild = null; }
  process.exit(0);
});
