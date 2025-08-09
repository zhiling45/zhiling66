// app.js
// 纯前端每日信息记录应用
// 模块：storage、state、ui、list、editor、filters、exporter、importer、stats、undo、theme、router
(() => {
  "use strict";

  /*** ------------------ 工具函数 ------------------ ***/
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const uuid = () => (crypto?.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  const debounce = (fn, wait = 250) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  };
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  /*** ------------------ 数据存储 ------------------ ***/
  const Store = {
    KEY: "dailyJournal.v1",
    THEME_KEY: "dailyJournal.theme",
    load() {
      try {
        const raw = localStorage.getItem(this.KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizeRecord).filter(Boolean);
      } catch {
        return [];
      }
    },
    save(records) {
      localStorage.setItem(this.KEY, JSON.stringify(records));
    },
    estimateSize(records) {
      try {
        const bytes = new Blob([JSON.stringify(records)]).size;
        return { bytes, mb: (bytes / (1024 * 1024)).toFixed(2) };
      } catch {
        const len = JSON.stringify(records).length;
        return { bytes: len, mb: (len / (1024 * 1024)).toFixed(2) };
      }
    }
  };

  /*** ------------------ 应用状态 ------------------ ***/
  const State = {
    records: Store.load().sort((a,b)=> (b.date || '').localeCompare(a.date || '')),
    filters: { q: "", date: "", mood: "", tags: new Set() },
    page: 1,
    pageSize: 20,
    lastAction: null, // { type: 'add'|'update'|'delete', before?, after? }
    redoAction: null
  };

  /*** ------------------ 记录模型校准 ------------------ ***/
  const VALID_MOODS = ["开心","一般","低落","紧张","疲惫"];
  function normalizeRecord(r) {
    if (!r || typeof r !== 'object') return null;
    const id = String(r.id || uuid());
    const date = (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) ? r.date : todayStr();
    const title = String(r.title || "").trim();
    const content = String(r.content || "");
    const mood = VALID_MOODS.includes(r.mood) ? r.mood : "一般";
    const tags = Array.isArray(r.tags) ? r.tags.filter(Boolean).map(String) : [];
    const attachments = Array.isArray(r.attachments) ? r.attachments.filter(isDataUrlImageSafe) : [];
    return { id, date, title, content, mood, tags, attachments };
  }
  function isDataUrlImageSafe(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const { dataUrl, name, type, size } = obj;
    if (!dataUrl || typeof dataUrl !== 'string') return false;
    if (!/^data:image\/[a-zA-Z+.-]+;base64,/.test(dataUrl)) return false;
    if (typeof size === 'number' && size > 1024*1024) return false;
    return true;
  }

  /*** ------------------ 主题 ------------------ ***/
  const Theme = {
    init() {
      const saved = localStorage.getItem(Store.THEME_KEY);
      if (saved === "dark" || saved === "light") {
        document.documentElement.setAttribute('data-theme', saved);
        $('#btnTheme')?.setAttribute('aria-pressed', saved === 'dark' ? 'true' : 'false');
      }
    },
    toggle() {
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      const next = cur === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      $('#btnTheme')?.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
      localStorage.setItem(Store.THEME_KEY, next);
    }
  };

  /*** ------------------ 列表渲染与分页 ------------------ ***/
  function getFilteredRecords() {
    const { q, date, mood, tags } = State.filters;
    const qlc = q.trim().toLowerCase();
    return State.records.filter(r => {
      if (date && r.date !== date) return false;
      if (mood && r.mood !== mood) return false;
      if (tags.size) {
        const hasAll = Array.from(tags).every(t => r.tags.includes(t));
        if (!hasAll) return false;
      }
      if (qlc) {
        const hay = [r.title, r.content, r.tags.join(",")].join(" ").toLowerCase();
        return hay.includes(qlc);
      }
      return true;
    });
  }

  function renderList(reset = false) {
    const list = $('#recordList');
    const emptyState = $('#emptyState');
    if (reset) {
      list.innerHTML = '';
      State.page = 1;
    }
    const filtered = getFilteredRecords();
    emptyState.hidden = filtered.length > 0;
    const start = 0;
    const end = clamp(State.page * State.pageSize, 0, filtered.length);
    const pageItems = filtered.slice(0, end);

    const frag = document.createDocumentFragment();
    list.innerHTML = ''; // 重新渲染（简单稳妥，数据量大可做 diff）
    for (const r of pageItems) {
      frag.appendChild(makeCard(r));
    }
    list.appendChild(frag);

    // “加载更多”按钮
    const more = $('#btnLoadMore');
    if (filtered.length > end) {
      more.hidden = false;
      more.onclick = () => {
        State.page++;
        renderList(false);
      };
    } else {
      more.hidden = true;
    }

    // 更新标签筛选候选
    refreshTagFilterMenu();
    // 更新统计
    Stats.render();
  }

  function makeCard(rec) {
    const tpl = $('#cardTpl');
    const li = tpl.content.firstElementChild.cloneNode(true);
    $('.card-date', li).textContent = rec.date;
    $('.card-title', li).textContent = rec.title || '(未命名)';
    $('.card-content', li).textContent = rec.content || '';
    const mood = $('.badge.mood', li);
    mood.textContent = rec.mood;

    const tagWrap = $('.card-tags', li);
    rec.tags.forEach(t => {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = t;
      tagWrap.appendChild(span);
    });

    const twrap = $('.card-thumbs', li);
    rec.attachments.slice(0, 6).forEach(a => {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = a.name || '附件';
      img.src = a.dataUrl;
      twrap.appendChild(img);
    });

    $('.edit', li).addEventListener('click', () => Editor.open(rec.id));
    $('.del', li).addEventListener('click', () => Editor.confirmDelete(rec.id));
    return li;
  }

  /*** ------------------ 编辑面板 ------------------ ***/
  const Editor = {
    open(id = null) {
      this.clearErrors();
      const isNew = !id;
      $('#btnDelete').hidden = isNew ? true : false;

      const rec = isNew ? {
        id: uuid(),
        date: todayStr(),
        title: "",
        content: "",
        mood: "一般",
        tags: [],
        attachments: []
      } : State.records.find(r => r.id === id);

      $('#recId').value = rec.id;
      $('#recDate').value = rec.date;
      $('#recTitle').value = rec.title;
      $('#recContent').value = rec.content;
      $('#recMood').value = rec.mood;

      // 标签 chips
      TagInput.set(rec.tags);

      // 附件预览
      Attachments.set(rec.attachments);

      // 展示
      const panel = $('#editorPanel');
      panel.classList.add('show');
      panel.setAttribute('aria-hidden', 'false');
      $('#recTitle').focus();
    },

    close() {
      const panel = $('#editorPanel');
      panel.classList.remove('show');
      panel.setAttribute('aria-hidden', 'true');
    },

    clearErrors() {
      $('#errDate').textContent = '';
      $('#errTitle').textContent = '';
      $('#errAttach').textContent = '';
    },

    async save(e) {
      e?.preventDefault();
      Editor.clearErrors();

      // 校验
      const date = $('#recDate').value;
      const title = $('#recTitle').value.trim();
      if (!date) {
        $('#errDate').textContent = '请选择日期';
        return;
      }
      if (!title) {
        $('#errTitle').textContent = '标题为必填';
        $('#recTitle').focus();
        return;
      }

      const rec = {
        id: $('#recId').value,
        date,
        title,
        content: $('#recContent').value,
        mood: $('#recMood').value,
        tags: TagInput.get(),
        attachments: Attachments.get()
      };

      const idx = State.records.findIndex(r => r.id === rec.id);
      if (idx === -1) {
        // 新增
        State.records.unshift(rec);
        setLastAction({ type: 'add', after: structuredClone(rec) });
      } else {
        const before = structuredClone(State.records[idx]);
        State.records[idx] = rec;
        setLastAction({ type: 'update', before, after: structuredClone(rec) });
      }
      Store.save(State.records);

      // 显示存储占用
      const { mb } = Store.estimateSize(State.records);
      $('#storageHint').textContent = `已占用本地存储约 ${mb} MB（浏览器通常上限约 ~5MB）。`;

      Editor.close();
      renderList(true);
    },

    confirmDelete(id) {
      const ok = confirm('确定要删除该记录吗？此操作可通过“撤销”恢复。');
      if (!ok) return;
      const idx = State.records.findIndex(r => r.id === id);
      if (idx > -1) {
        const removed = State.records.splice(idx, 1)[0];
        setLastAction({ type: 'delete', before: structuredClone(removed) });
        Store.save(State.records);
        renderList(true);
      }
    }
  };

  /*** ------------------ 标签 Chips 输入 ------------------ ***/
  const TagInput = {
    set(tags) {
      this._tags = Array.from(new Set((tags || []).map(t => String(t).trim()).filter(Boolean)));
      this.render();
    },
    get() {
      return this._tags || [];
    },
    render() {
      const wrap = $('#tagChips');
      wrap.innerHTML = '';
      (this._tags || []).forEach((t, i) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.innerHTML = `<span>${escapeHtml(t)}</span><button type="button" aria-label="移除标签">×</button>`;
        chip.querySelector('button').addEventListener('click', () => {
          this._tags.splice(i, 1);
          this.render();
        });
        wrap.appendChild(chip);
      });
    }
  };
  $('#tagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = e.currentTarget.value.trim();
      if (v) {
        const set = new Set(TagInput.get());
        set.add(v);
        TagInput.set(Array.from(set));
        e.currentTarget.value = '';
      }
    }
  });

  /*** ------------------ 附件处理 ------------------ ***/
  const Attachments = {
    set(list) {
      this._atts = Array.isArray(list) ? list.slice() : [];
      this.render();
    },
    get() {
      return this._atts || [];
    },
    render() {
      const wrap = $('#attachPreview');
      wrap.innerHTML = '';
      (this._atts || []).forEach((a, i) => {
        const box = document.createElement('div');
        box.className = 'thumb';
        const img = document.createElement('img');
        img.alt = a.name || '附件';
        img.src = a.dataUrl;
        const rm = document.createElement('button');
        rm.className = 'remove';
        rm.type = 'button';
        rm.textContent = '✕';
        rm.title = '移除';
        rm.addEventListener('click', () => {
          this._atts.splice(i, 1);
          this.render();
        });
        box.append(img, rm);
        wrap.appendChild(box);
      });
    }
  };
  $('#filePicker').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const max = 1024 * 1024; // 1MB/张
    const newOnes = [];
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue;
      if (f.size > max) {
        $('#errAttach').textContent = `文件“${f.name}”超过 1MB，已跳过。`;
        continue;
      }
      const dataUrl = await fileToDataUrl(f);
      newOnes.push({ name: f.name, type: f.type, size: f.size, dataUrl });
    }
    const merged = (Attachments.get() || []).concat(newOnes);
    Attachments.set(merged);
    // 清空选择（便于再次选择同名文件）
    e.target.value = '';
  });
  function fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
  }

  /*** ------------------ 筛选区（搜索、日期、心情、标签） ------------------ ***/
  $('#q').addEventListener('input', debounce((e) => {
    State.filters.q = e.target.value || '';
    renderList(true);
  }, 200));

  $('#filterDate').addEventListener('change', (e) => {
    State.filters.date = e.target.value || '';
    renderList(true);
  });

  $('#filterMood').addEventListener('change', (e) => {
    State.filters.mood = e.target.value || '';
    renderList(true);
  });

  // 标签筛选菜单
  const tagBtn = $('#btnTagFilter');
  const tagMenu = $('#tagMenu');
  tagBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const showing = tagMenu.classList.contains('show');
    closeAllMenus();
    if (!showing) {
      // 贴靠按钮
      const rect = tagBtn.getBoundingClientRect();
      tagMenu.style.left = '0';
      tagMenu.style.top = (rect.height + 6) + 'px';
      tagMenu.classList.add('show');
      tagBtn.setAttribute('aria-expanded', 'true');
    }
  });
  document.addEventListener('click', () => closeAllMenus());
  function closeAllMenus() {
    tagMenu.classList.remove('show');
    tagBtn.setAttribute('aria-expanded', 'false');
  }

  function refreshTagFilterMenu() {
    const wrap = $('#tagFilterList');
    const allTags = new Set();
    State.records.forEach(r => (r.tags || []).forEach(t => allTags.add(t)));
    wrap.innerHTML = '';
    if (!allTags.size) {
      const span = document.createElement('span');
      span.className = 'muted small';
      span.textContent = '暂无可用标签';
      wrap.appendChild(span);
      return;
    }
    allTags.forEach(t => {
      const id = 'tag-filter-' + t;
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = id;
      cb.value = t;
      cb.checked = State.filters.tags.has(t);
      cb.addEventListener('change', () => {
        if (cb.checked) State.filters.tags.add(t);
        else State.filters.tags.delete(t);
        renderList(true);
      });
      const txt = document.createElement('span');
      txt.textContent = t;
      label.append(cb, txt);
      wrap.appendChild(label);
    });
  }
  $('#btnClearTagFilter').addEventListener('click', () => {
    State.filters.tags.clear();
    renderList(true);
  });

  /*** ------------------ 导出 / 导入 ------------------ ***/
  $('#btnExportJson').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(State.records, null, 2)], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, `daily-journal-${Date.now()}.json`);
  });
  $('#btnExportCsv').addEventListener('click', () => {
    // CSV：不包含附件数据（避免过大），保留附件数量
    const header = ['id','date','title','content','mood','tags','attachmentsCount'];
    const lines = [header.join(',')];
    State.records.forEach(r => {
      const row = [
        r.id,
        r.date,
        escapeCsv(r.title),
        escapeCsv(r.content),
        r.mood,
        escapeCsv((r.tags || []).join(';')),
        String((r.attachments || []).length)
      ];
      lines.push(row.join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob(blob, `daily-journal-${Date.now()}.csv`);
  });
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function escapeCsv(s) {
    const str = String(s ?? '');
    if (/[",\n]/.test(str)) {
      return `"${str.replaceAll('"','""')}"`;
    }
    return str;
  }

  $('#btnImportJson').addEventListener('click', () => $('#fileImport').click());
  $('#fileImport').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('文件格式无效：应为数组');
      let added = 0, skipped = 0, fixedAttach = 0;
      const ids = new Set(State.records.map(r => r.id));
      const incoming = parsed.map(normalizeRecord).filter(Boolean);
      for (const rec of incoming) {
        if (ids.has(rec.id)) { skipped++; continue; }
        // 附件再校验：超过1MB则剔除（导入时保护）
        rec.attachments = (rec.attachments || []).filter(a => {
          if (a.size && a.size > 1024*1024) { fixedAttach++; return false; }
          return true;
        });
        State.records.push(rec);
        ids.add(rec.id);
        added++;
      }
      // 排序 & 保存
      State.records.sort((a,b)=> (b.date || '').localeCompare(a.date || ''));
      Store.save(State.records);
      alert(`导入完成：新增 ${added} 条，跳过重复 ${skipped} 条${fixedAttach?`，剔除超限附件 ${fixedAttach} 个`:''}。`);
      renderList(true);
    } catch (err) {
      alert('导入失败：' + (err?.message || err));
    } finally {
      e.target.value = '';
    }
  });

  /*** ------------------ 统计 ------------------ ***/
  const Stats = {
    render() {
      const items = getFilteredRecords();
      this.mood(items);
      this.date(items);
    },
    mood(items) {
      const counts = Object.fromEntries(VALID_MOODS.map(m => [m, 0]));
      items.forEach(r => { counts[r.mood] = (counts[r.mood] || 0) + 1; });
      drawBar($('#moodCanvas'), Object.keys(counts), Object.values(counts));
      $('#moodText').textContent = `总计 ${items.length} 条；` + Object.entries(counts).map(([k,v]) => `${k}:${v}`).join('，');
    },
    date(items) {
      // 最近 30 天
      const days = [];
      const map = new Map();
      const today = new Date();
      for (let i=29; i>=0; i--) {
        const d = new Date(today); d.setDate(today.getDate() - i);
        const key = d.toISOString().slice(0,10);
        days.push(key); map.set(key, 0);
      }
      items.forEach(r => { if (map.has(r.date)) map.set(r.date, map.get(r.date)+1); });
      drawBar($('#dateCanvas'), days.map(d=>d.slice(5)), days.map(d=>map.get(d)));
      $('#dateText').textContent = `最近30天记录总数：${items.filter(r=>map.has(r.date)).length}`;
    }
  };

  // 简单柱状图（原生 canvas）
  function drawBar(canvas, labels, values) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0,0,W,H);

    const max = Math.max(1, ...values);
    const pad = 18;
    const gw = W - pad*2;
    const gh = H - pad*2 - 14;
    const n = values.length;
    const bw = Math.max(4, (gw / n) - 2);

    // 轴
    ctx.strokeStyle = getCssVar('--border'); ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, H-pad-14);
    ctx.lineTo(W-pad, H-pad-14);
    ctx.stroke();

    // 柱
    ctx.fillStyle = getCssVar('--primary');
    for (let i=0;i<n;i++) {
      const x = pad + i*(bw+2);
      const h = Math.round((values[i]/max) * gh);
      const y = H - pad - 14 - h;
      ctx.fillRect(x, y, bw, h);
    }

    // 简易刻度（只画起止）
    ctx.fillStyle = getCssVar('--muted'); ctx.font = '10px system-ui';
    ctx.textAlign = 'left'; ctx.fillText('0', pad, H-pad-2);
    ctx.textAlign = 'right'; ctx.fillText(String(max), W-pad, pad+10);

    // 如果标签较少，渲染 x 轴标签
    if (labels.length <= 10) {
      ctx.save();
      ctx.translate(0,0);
      ctx.textAlign = 'center';
      for (let i=0;i<n;i++) {
        const x = pad + i*(bw+2) + bw/2;
        ctx.fillText(labels[i], x, H-2);
      }
      ctx.restore();
    }
  }
  function getCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  /*** ------------------ 撤销 / 恢复（单步） ------------------ ***/
  function setLastAction(action) {
    State.lastAction = action;
    State.redoAction = null; // 新操作后清空恢复栈
    updateUndoRedoButtons();
  }
  function updateUndoRedoButtons() {
    $('#btnUndo').disabled = !State.lastAction;
    $('#btnRedo').disabled = !State.redoAction;
  }
  $('#btnUndo').addEventListener('click', () => {
    const a = State.lastAction;
    if (!a) return;
    if (a.type === 'add') {
      // 撤销新增 -> 删除
      const idx = State.records.findIndex(r => r.id === a.after.id);
      if (idx>-1) State.records.splice(idx,1);
    } else if (a.type === 'update') {
      // 撤销更新 -> 还原 before
      const idx = State.records.findIndex(r => r.id === a.after.id);
      if (idx>-1) State.records[idx] = structuredClone(a.before);
    } else if (a.type === 'delete') {
      // 撤销删除 -> 放回
      State.records.unshift(structuredClone(a.before));
    }
    Store.save(State.records);
    State.redoAction = a;
    State.lastAction = null;
    updateUndoRedoButtons();
    renderList(true);
  });
  $('#btnRedo').addEventListener('click', () => {
    const a = State.redoAction;
    if (!a) return;
    if (a.type === 'add') {
      State.records.unshift(structuredClone(a.after));
    } else if (a.type === 'update') {
      const idx = State.records.findIndex(r => r.id === a.after.id);
      if (idx>-1) State.records[idx] = structuredClone(a.after);
    } else if (a.type === 'delete') {
      const idx = State.records.findIndex(r => r.id === a.before.id);
      if (idx>-1) State.records.splice(idx,1);
    }
    Store.save(State.records);
    State.lastAction = a;
    State.redoAction = null;
    updateUndoRedoButtons();
    renderList(true);
  });

  /*** ------------------ 键盘快捷键 ------------------ ***/
  document.addEventListener('keydown', (e) => {
    // 输入框内的按键不拦截除 Ctrl/Cmd+S 以外
    const isTyping = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    // N 新建
    if ((e.key === 'n' || e.key === 'N') && !isTyping) {
      e.preventDefault(); Editor.open();
    }
    // / 聚焦搜索
    if (e.key === '/' && !isTyping) {
      e.preventDefault(); $('#q').focus();
    }
    // S 保存（编辑器打开时）
    const editorVisible = $('#editorPanel').classList.contains('show');
    if ((e.key === 's' || e.key === 'S' || (e.key === 's' && (e.ctrlKey||e.metaKey))) && editorVisible) {
      e.preventDefault(); Editor.save();
    }
    // Ctrl/Cmd+S 在任何输入内也应该触发保存
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase() === 's' && editorVisible) {
      e.preventDefault(); Editor.save();
    }
  });

  /*** ------------------ 事件绑定 ------------------ ***/
  $('#btnNew').addEventListener('click', () => Editor.open());
  $('#btnSave').addEventListener('click', (e) => Editor.save(e));
  $('#btnCancel').addEventListener('click', () => Editor.close());
  $('#btnCloseEditor').addEventListener('click', () => Editor.close());
  $('#btnDelete').addEventListener('click', () => {
    const id = $('#recId').value;
    Editor.confirmDelete(id);
    Editor.close();
  });
  $('#btnTheme').addEventListener('click', () => Theme.toggle());

  /*** ------------------ 安全与转义 ------------------ ***/
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }

  /*** ------------------ 初始化 ------------------ ***/
  function init() {
    Theme.init();
    renderList(true);
    updateUndoRedoButtons();
  }
  init();

  // 可选：你可以在将来添加 PWA 支持（需新增 manifest.json 与 sw.js 文件）
})();
