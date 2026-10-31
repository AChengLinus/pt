'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 暴露给页面（index.html）的桌面能力。普通浏览器中该对象不存在，页面会走纯前端路径。
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  // 打开系统文件选择框，返回 { path, name } 或 null
  openImage: () => ipcRenderer.invoke('image:open'),

  // 取真实磁盘路径（用于拖拽/文件选择框得到的 File，避免复制大文件）
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (e) {
      return null;
    }
  },

  // 超大图元信息
  getMeta: (p) => ipcRenderer.invoke('image:meta', p),

  // 渲染可见区域瓦片
  renderRegion: (p, opts) => ipcRenderer.invoke('image:region', p, opts),

  // 整图概览（低分辨率基础层），返回 { buf, ow, oh }
  overview: (p, maxDim, min, max) => ipcRenderer.invoke('image:overview', p, maxDim, min, max),

  // 生成/复用图像金字塔，返回 { path, cached }
  ensurePyramid: (p) => ipcRenderer.invoke('image:ensure-pyramid', p),

  // 整图缩放到指定分辨率，返回 JPEG 缓冲
  renderResized: (p, w, h, min, max, depth) => ipcRenderer.invoke('image:render-resized', p, w, h, min, max, depth),

  // 无法取路径时写入临时文件
  saveTemp: (name, buf) => ipcRenderer.invoke('file:save-temp', name, buf),

  // 读取任意文件为二进制（用于读回转换后的 DXF 文本）
  readFile: (p) => ipcRenderer.invoke('file:read', p),

  // DWG 转换器探测：{ available, kind, name, exe, configPath }
  dwgProbe: () => ipcRenderer.invoke('dwg:probe'),

  // 把 DWG 转成 DXF，返回 { dxfPath, cached, tool }
  dwgConvert: (p) => ipcRenderer.invoke('dwg:convert', p),

  // GPU 状态
  gpuInfo: () => ipcRenderer.invoke('app:gpu-info'),

  // 菜单“打开图片”事件
  onMenuOpen: (cb) => ipcRenderer.on('menu:open', (e, data) => cb(data)),
  // 菜单“关闭图片”事件
  onMenuClose: (cb) => ipcRenderer.on('menu:close-image', () => cb()),
  onGpuReport: (cb) => ipcRenderer.on('app:gpu-report', () => cb()),
  // 主进程打开文件对话框前/后，暂停/恢复后台取瓦片与金字塔生成
  onBgPause: (cb) => ipcRenderer.on('bg:pause', () => cb()),
  onBgResume: (cb) => ipcRenderer.on('bg:resume', () => cb()),
  // 关闭软件防误触：主进程拦截窗口关闭，渲染进程确认后再真正关闭
  onCloseRequest: (cb) => ipcRenderer.on('app:close-request', () => cb()),
  confirmClose: () => ipcRenderer.send('app:confirm-close'),

  platform: process.platform
});
