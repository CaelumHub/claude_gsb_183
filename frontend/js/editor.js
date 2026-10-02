/* ============================================================
   MiniLang 平台 —— 代码编辑器组件
   纯前端实现语法高亮（手写词法着色）+ 自动补全（关键字/内置/变量/函数）。
   同时支持断点槽（点击行号设置断点）与当前执行行高亮，供调试页复用。
   ============================================================ */
(function () {
  "use strict";

  const ML = (window.ML = window.ML || {});

  const KEYWORDS = new Set(["var", "func", "if", "elif", "else", "while", "for",
    "return", "break", "continue", "print", "true", "false", "null"]);
  const BUILTINS = new Set(["print", "len", "push", "pop", "type", "str", "int",
    "float", "range", "abs", "min", "max", "sqrt", "floor", "ceil", "round",
    "input", "exit", "time", "random"]);

  const DOUBLE_OPS = ["==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "*=", "/=", "%="];
  const SINGLE_OPS = "+-*/%!=<>(){}[],;.";

  /* ----------------------------------------------------------
   * 词法着色：把 MiniLang 源码转成带高亮的 HTML
   * navByPos（可选）：绝对偏移 -> 导航出现点（occurrence），命中的标识符
   * 会额外加上可点击/已解析的 class，供"定义跳转/引用查找"响应点击。
   * ---------------------------------------------------------- */
  ML.Highlighter = {
    highlight(code, navByPos) {
      const esc = ML.escapeHtml;
      const identNavClass = (start, word) => {
        if (!navByPos) return null;
        const occ = navByPos.get(start);
        if (!occ || occ.name !== word) return null;
        if (!occ.resolved) return "id-resolved id-unresolved";
        let cls = "id-resolved";
        if (occ.role === "call") cls += " id-call";
        else if (occ.role === "declaration" || occ.role === "parameter") cls += " id-decl";
        return cls;
      };
      let out = "";
      let i = 0;
      const n = code.length;
      while (i < n) {
        const ch = code[i];
        // 行注释
        if (ch === "/" && code[i + 1] === "/") {
          let j = i;
          while (j < n && code[j] !== "\n") j++;
          out += '<span class="tk-com">' + esc(code.slice(i, j)) + "</span>";
          i = j;
          continue;
        }
        // 块注释
        if (ch === "/" && code[i + 1] === "*") {
          let j = code.indexOf("*/", i + 2);
          j = j === -1 ? n : j + 2;
          out += '<span class="tk-com">' + esc(code.slice(i, j)) + "</span>";
          i = j;
          continue;
        }
        // 字符串
        if (ch === '"') {
          let j = i + 1;
          while (j < n) {
            if (code[j] === "\\") { j += 2; continue; }
            if (code[j] === '"') { j++; break; }
            if (code[j] === "\n") break;
            j++;
          }
          out += '<span class="tk-str">' + esc(code.slice(i, j)) + "</span>";
          i = j;
          continue;
        }
        // 数字
        if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(code[i + 1] || ""))) {
          const m = code.slice(i).match(/^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/);
          if (m) {
            out += '<span class="tk-num">' + esc(m[0]) + "</span>";
            i += m[0].length;
            continue;
          }
        }
        // 标识符 / 关键字 / 内置
        if (/[A-Za-z_]/.test(ch)) {
          let j = i;
          while (j < n && /[A-Za-z0-9_]/.test(code[j])) j++;
          const word = code.slice(i, j);
          let cls = "tk-ident";
          if (KEYWORDS.has(word)) cls = "tk-kw";
          else if (BUILTINS.has(word)) cls = "tk-bi";
          // 已被语义分析解析到符号表的标识符：附带跳转 class（关键字除外）
          const navCls = cls === "tk-ident" || cls === "tk-bi" ? identNavClass(i, word) : null;
          if (navCls) {
            out += `<span class="${navCls} ${cls}" title="点击查看引用 · 双击/F12 跳转定义">` +
              esc(word) + "</span>";
          } else {
            out += '<span class="' + cls + '">' + esc(word) + "</span>";
          }
          i = j;
          continue;
        }
        // 运算符（双字符优先）
        const two = code.slice(i, i + 2);
        if (DOUBLE_OPS.includes(two)) {
          out += '<span class="tk-op">' + esc(two) + "</span>";
          i += 2;
          continue;
        }
        if (SINGLE_OPS.includes(ch)) {
          out += '<span class="tk-op">' + esc(ch) + "</span>";
          i += 1;
          continue;
        }
        out += esc(ch);
        i += 1;
      }
      return out;
    },
  };

  /* ----------------------------------------------------------
   * 从源码中收集已声明的符号（用于补全）
   * ---------------------------------------------------------- */
  function collectSymbols(code) {
    const fns = new Map(); // name -> {kind, params}
    const vars = new Set();
    const params = new Set();
    let m;
    const fnRe = /\bfunc\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
    while ((m = fnRe.exec(code)) !== null) {
      fns.set(m[1], { kind: "函数" });
      m[2].split(",").map((s) => s.trim()).filter(Boolean).forEach((p) => params.add(p));
    }
    const varRe = /\bvar\s+([A-Za-z_]\w*)/g;
    while ((m = varRe.exec(code)) !== null) vars.add(m[1]);
    return { fns, vars, params };
  }

  /* ----------------------------------------------------------
   * CodeEditor 组件
   * ---------------------------------------------------------- */
  ML.CodeEditor = class {
    /**
     * @param {HTMLElement} container 挂载点
     * @param {object} opts
     *   value: 初始源码
     *   height: 最小高度（px，默认 320）
     *   breakpoints: 是否显示断点槽
     *   onBreakpointChange: (line, active) => void
     *   onValueChange: (value) => void
     *   autocomplete: 是否启用自动补全（默认 true）
     *   navigation: 是否启用"定义跳转 / 引用查找"（默认 true）
     */
    constructor(container, opts) {
      opts = opts || {};
      this.container = container;
      this.breakpointsEnabled = !!opts.breakpoints;
      this.onBreakpointChange = opts.onBreakpointChange || null;
      this.onValueChange = opts.onValueChange || null;
      this.autocomplete = opts.autocomplete !== false;
      this.navigation = opts.navigation !== false;
      this._bps = new Set();
      this._tabSize = 4;
      this._charW = null;
      this._acBox = null;
      this._acSel = 0;
      this._acItems = [];
      /* ---- 定义跳转 / 引用查找状态 ---- */
      this._navData = null;        // /api/navigate 最近一次结果
      this._navByPos = null;       // Map<绝对偏移, occurrence>
      this._navLoading = false;
      this._navToken = 0;
      this._navPanel = null;
      this._selectedSid = null;    // 当前选中的符号 sid
      this._selectedUnresolved = null; // 当前选中的未解析名字（line/column/name）
      this._backStack = [];        // 跳转前的光标位置（回跳）
      this._flashTimer = null;
      this._buildDom(opts);
    }

    _buildDom(opts) {
      const wrap = document.createElement("div");
      wrap.className = "editor-wrap";
      wrap.style.minHeight = (opts.height || 320) + "px";

      this.gutterInner = document.createElement("div");
      this.gutterInner.className = "gutter-inner";
      const gutter = document.createElement("div");
      gutter.className = "gutter";
      gutter.appendChild(this.gutterInner);

      this.hlInner = document.createElement("span");
      this.hlInner.className = "hl-inner";
      this.hl = document.createElement("pre");
      this.hl.className = "hl";
      this.hl.setAttribute("aria-hidden", "true");
      this.hl.appendChild(this.hlInner);

      this.curLine = document.createElement("div");
      this.curLine.className = "cur-line";
      this.curLine.style.display = "none";

      // 当前符号全部出现位置的高亮层（定义/调用/赋值等）
      this.markLayer = document.createElement("div");
      this.markLayer.className = "nav-marks";

      this.ta = document.createElement("textarea");
      this.ta.className = "src";
      this.ta.spellcheck = false;
      this.ta.wrap = "off";
      this.ta.setAttribute("autocapitalize", "off");
      this.ta.setAttribute("autocorrect", "off");

      const area = document.createElement("div");
      area.className = "code-area";
      area.appendChild(this.hl);
      area.appendChild(this.curLine);
      area.appendChild(this.markLayer);
      area.appendChild(this.ta);

      wrap.appendChild(gutter);
      wrap.appendChild(area);
      this.container.appendChild(wrap);
      this.wrap = wrap;

      this._bindEvents();
      this.setValue(opts.value != null ? opts.value : "");
      if (this.navigation) {
        this._buildNavPanel();
        this._refreshNav(false);
      }
    }

    _bindEvents() {
      this.ta.addEventListener("input", () => {
        this._render();
        if (this.onValueChange) this.onValueChange(this.getValue());
        if (this.navigation) this._scheduleNav();
      });
      this.ta.addEventListener("scroll", () => this._syncScroll());
      this.ta.addEventListener("keydown", (e) => this._onKeydown(e));
      this.ta.addEventListener("click", (e) => {
        this._closeAC();
        if (this.navigation) this._onNavClick(e);
      });
      this.ta.addEventListener("dblclick", (e) => {
        if (!this.navigation) return;
        this._onNavClick(e, true);
      });
      if (this.navigation) {
        this.ta.addEventListener("mousemove", (e) => {
          if (e.ctrlKey || e.metaKey) {
            const hit = this._posFromEvent(e);
            const w = hit != null && this._wordAt(hit);
            this.ta.classList.toggle("nav-ctrl", !!(w && this._occAtPos(w.start)));
          } else {
            this.ta.classList.remove("nav-ctrl");
          }
        });
        this.ta.addEventListener("mouseleave", () => this.ta.classList.remove("nav-ctrl"));
      }
      this.ta.addEventListener("blur", () => setTimeout(() => this._closeAC(), 150));

      if (this.breakpointsEnabled) {
        this.gutterInner.addEventListener("click", (e) => {
          const line = e.target.closest(".gline");
          if (line) this.toggleBreakpoint(parseInt(line.dataset.line, 10));
        });
      }
    }

    /* ---------------- 取值 / 设值 ---------------- */
    getValue() { return this.ta.value; }

    setValue(code) {
      this.ta.value = code;
      // 关闭旧引用面板，避免展示上一份代码的符号；随后刷新导航数据
      this.closeReferences();
      this._navData = null;
      this._navByPos = null;
      this._render();
      if (this.navigation) this._refreshNav(false);
    }

    getBreakpoints() { return Array.from(this._bps).sort((a, b) => a - b); }

    setBreakpoints(lines) {
      this._bps = new Set(lines || []);
      this._renderGutter();
    }

    toggleBreakpoint(line) {
      if (line < 1) return;
      if (this._bps.has(line)) this._bps.delete(line);
      else this._bps.add(line);
      this._renderGutter();
      if (this.onBreakpointChange) this.onBreakpointChange(line, this._bps.has(line));
      return this._bps.has(line);
    }

    setCurrentLine(line) {
      if (!line) { this.curLine.style.display = "none"; return; }
      this.curLine.style.display = "block";
      this._placeCurLine(line);
    }

    focus() { this.ta.focus(); }

    /* ---------------- 渲染 ---------------- */
    _render() {
      this.hlInner.innerHTML =
        ML.Highlighter.highlight(this.ta.value, this._navByPos) || "​";
      this._renderGutter();
      this._syncScroll();
      this._renderMarks();
    }

    _renderGutter() {
      const lines = this.ta.value.split("\n").length;
      let html = "";
      for (let i = 1; i <= lines; i++) {
        const hasBp = this._bps.has(i);
        html += `<div class="gline${hasBp ? " has-bp" : ""}" data-line="${i}">` +
          `<span class="bp"></span><span class="num">${i}</span></div>`;
      }
      this.gutterInner.innerHTML = html;
    }

    _syncScroll() {
      const st = this.ta.scrollTop, sl = this.ta.scrollLeft;
      this.hlInner.style.transform = `translate(${-sl}px, ${-st}px)`;
      this.gutterInner.style.transform = `translateY(${-st}px)`;
      if (this.markLayer) this.markLayer.style.transform = `translate(${-sl}px, ${-st}px)`;
      const cur = parseInt(this.ta.dataset.curLine || "0", 10);
      if (cur) this._placeCurLine(cur);
    }

    _placeCurLine(line) {
      const st = this.ta.scrollTop;
      this.curLine.style.top = (12 + (line - 1) * 20 - st) + "px";
    }

    /* ---------------- 键盘 / 补全 ---------------- */
    _onKeydown(e) {
      /* ---- 定义跳转 / 引用查找的按键 ---- */
      if (this.navigation) {
        if (e.key === "F12") { e.preventDefault(); this._navigateAtCursor(); return; }
        if (e.key === "Escape" && this._navPanel && this._navPanel.style.display !== "none") {
          e.preventDefault(); this.closeReferences(); return;
        }
        if (e.key === "ArrowLeft" && e.altKey) { e.preventDefault(); this.goBack(); return; }
      }
      if (this._acBox && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) {
        if (e.key === "ArrowDown") { e.preventDefault(); this._moveAC(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); this._moveAC(-1); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); this._commitAC(); return; }
        if (e.key === "Escape") { e.preventDefault(); this._closeAC(); return; }
      }
      if (e.key === "Tab") {
        e.preventDefault();
        this._insertText(" ".repeat(this._tabSize));
        return;
      }
      if (e.key === "Enter") {
        // 缩进延续
        const { line } = this._cursor();
        const text = this.ta.value;
        const lines = text.split("\n");
        const cur = lines[line] || "";
        const indent = (cur.match(/^[ \t]*/) || [""])[0];
        e.preventDefault();
        this._insertText("\n" + indent);
        return;
      }
      if (e.key === " " && e.ctrlKey) {
        e.preventDefault();
        this._showAC(true);
        return;
      }
      if (e.key.length === 1 && /[A-Za-z_]/.test(e.key)) {
        setTimeout(() => this._showAC(false), 0);
      }
    }

    _cursor() {
      const pos = this.ta.selectionStart;
      const before = this.ta.value.slice(0, pos);
      const lines = before.split("\n");
      return { line: lines.length - 1, col: lines[lines.length - 1].length, pos };
    }

    _currentWord() {
      const { pos, col } = this._cursor();
      const text = this.ta.value;
      let start = pos;
      while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start--;
      return text.slice(start, pos);
    }

    _insertText(s) {
      const start = this.ta.selectionStart, end = this.ta.selectionEnd;
      this.ta.setRangeText(s, start, end, "end");
      this._render();
      if (this.onValueChange) this.onValueChange(this.getValue());
    }

    _commitAC() {
      const item = this._acItems[this._acSel];
      this._closeAC();
      if (!item) return;
      const word = this._currentWord();
      const { pos } = this._cursor();
      const start = pos - word.length;
      this.ta.setRangeText(item.text, start, pos, "end");
      this._render();
      if (this.onValueChange) this.onValueChange(this.getValue());
    }

    _buildItems(force) {
      const word = this._currentWord();
      if (!force && word.length === 0) return [];
      const sym = collectSymbols(this.ta.value);
      const items = [];
      const add = (text, kind) => items.push({ text, kind });
      KEYWORDS.forEach((k) => add(k, "关键字"));
      BUILTINS.forEach((b) => add(b, "内置函数"));
      sym.fns.forEach((_, name) => add(name, "函数"));
      sym.params.forEach((p) => add(p, "形参"));
      sym.vars.forEach((v) => add(v, "变量"));
      const seen = new Set();
      const uniq = items.filter((it) => {
        if (seen.has(it.text)) return false;
        seen.add(it.text);
        if (word && !it.text.startsWith(word)) return false;
        return true;
      });
      return uniq.slice(0, 40);
    }

    _showAC(force) {
      if (!this.autocomplete) return;
      const items = this._buildItems(force);
      if (!items.length) { this._closeAC(); return; }
      this._acItems = items;
      this._acSel = 0;
      this._renderAC();
    }

    _renderAC() {
      if (!this._acBox) {
        this._acBox = document.createElement("div");
        this._acBox.className = "ac-box";
        this.wrap.appendChild(this._acBox);
      }
      let html = "";
      this._acItems.forEach((it, idx) => {
        html += `<div class="item${idx === this._acSel ? " sel" : ""}" data-i="${idx}">` +
          `<span class="t">${ML.escapeHtml(it.text)}</span>` +
          `<span class="k">${ML.escapeHtml(it.kind)}</span></div>`;
      });
      this._acBox.innerHTML = html;
      const { line, col } = this._cursor();
      const cw = this._charWidth();
      const x = 44 + 14 + col * cw - this.ta.scrollLeft;
      const y = 12 + line * 20 - this.ta.scrollTop + 20;
      this._acBox.style.left = Math.min(x, this.wrap.clientWidth - 200) + "px";
      this._acBox.style.top = Math.max(y, 0) + "px";
      this._acBox.style.display = "block";
      this._acBox.querySelectorAll(".item").forEach((el) => {
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this._acSel = parseInt(el.dataset.i, 10);
          this._commitAC();
        });
      });
    }

    _moveAC(d) {
      if (!this._acBox) return;
      this._acSel = (this._acSel + d + this._acItems.length) % this._acItems.length;
      this._renderAC();
    }

    _closeAC() {
      if (this._acBox) this._acBox.style.display = "none";
      this._acBox = null;
      this._acItems = [];
    }

    _charWidth() {
      if (this._charW != null) return this._charW;
      const cs = getComputedStyle(this.ta);
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.font = cs.font || "13px monospace";
      this._charW = ctx.measureText("M").width;
      return this._charW;
    }

    destroy() {
      this._closeAC();
      if (this.wrap && this.wrap.parentNode) this.wrap.parentNode.removeChild(this.wrap);
    }

    /* ================================================================
     * 定义跳转 / 引用查找（Go-to-Definition & Find References）
     *
     * 数据来自 /api/navigate（复用后端符号表与作用域链），前端只负责：
     *   点击/按键选中标识符 -> 高亮该符号的全部出现位置 -> 打开引用列表面板；
     *   双击 / F12 / Ctrl+点击 -> 跳到定义所在行；Alt+← 回跳。
     * ================================================================ */

    /* ---- 数据：编辑后防抖刷新；点击时若不是最新则立即拉一次 ---- */
    _scheduleNav() {
      clearTimeout(this._navTimer);
      this._navTimer = setTimeout(() => { this._refreshNav(false); }, 500);
    }

    async _refreshNav(force) {
      if (!this.navigation) return null;
      const source = this.ta.value;
      if (!source.trim()) {
        this._navData = null; this._navByPos = null; this._render();
        return null;
      }
      const token = ++this._navToken;
      this._navLoading = true;
      try {
        const data = await ML.api.navigate(source);
        if (token !== this._navToken) return null; // 有更新的请求在途中
        const r = (data && data.result) || null;
        this._navData = r && r.ok ? r : null;
        this._navByPos = this._navData ? this._indexOccurrences(this._navData.occurrences) : null;
      } catch (e) {
        if (token === this._navToken) { this._navData = null; this._navByPos = null; }
      } finally {
        if (token === this._navToken) this._navLoading = false;
      }
      this._render();
      // 若面板正开着，按新代码重新定位当前选中的符号
      if (this._selectedSid != null) this._selectSid(this._selectedSid, false);
      return this._navData;
    }

    _indexOccurrences(occurrences) {
      const map = new Map();
      const text = this.ta.value;
      const starts = this._lineStarts(text);
      (occurrences || []).forEach((o) => {
        const pos = starts[o.line - 1] + (o.column - 1);
        // 仅当与源码实际文本一致时收录（编辑后的数据可能短暂过期）
        if (text.substr(pos, o.length) === o.name) map.set(pos, o);
      });
      return map;
    }

    _lineStarts(text) {
      const starts = [0];
      for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
      return starts;
    }

    /* ---- 坐标 -> 光标位置（line/column 均为 1-based） ---- */
    _posFromEvent(e) {
      const cs = getComputedStyle(this.ta);
      const padX = parseFloat(cs.paddingLeft) || 0, padY = parseFloat(cs.paddingTop) || 0;
      const cw = this._charWidth();
      const lh = 20;
      const x = e.clientX - this.ta.getBoundingClientRect().left - padX + this.ta.scrollLeft;
      const y = e.clientY - this.ta.getBoundingClientRect().top - padY + this.ta.scrollTop;
      const line = Math.max(1, Math.floor(y / lh) + 1);
      const col = Math.max(1, Math.round(x / cw) + 1);
      const text = this.ta.value;
      const starts = this._lineStarts(text);
      if (line > starts.length) return null;
      const lineStart = starts[line - 1];
      const lineEnd = line < starts.length ? starts[line] - 1 : text.length;
      return Math.min(lineStart + (col - 1), lineEnd);
    }

    /* 把某个光标位置扩展到所在标识符，返回 { start, end, word } 或 null */
    _wordAt(pos) {
      const text = this.ta.value;
      if (pos == null || pos < 0 || pos > text.length) return null;
      let start = pos, end = pos;
      const isWord = (c) => /[A-Za-z0-9_]/.test(c);
      // 点在词右边界时退一格，让词更容易被点中
      if (start > 0 && !isWord(text[start]) && isWord(text[start - 1])) start -= 1;
      while (start > 0 && isWord(text[start - 1])) start--;
      while (end < text.length && isWord(text[end])) end++;
      if (start === end) return null;
      const word = text.slice(start, end);
      if (!/^[A-Za-z_]/.test(word)) return null;
      return { start, end, word };
    }

    _occAtPos(pos) {
      if (!this._navByPos) return null;
      return this._navByPos.get(pos) || null;
    }

    /* ---- 点击：单击=选中+面板；Ctrl/双击=跳定义 ---- */
    async _onNavClick(e, fromDbl) {
      const wantJump = fromDbl === true || e.ctrlKey || e.metaKey;
      let pos = this.ta.selectionStart;
      // click/dblclick 用鼠标坐标精确命中；Ctrl 组合键时浏览器可能未移动光标
      if (e && e.clientX != null) {
        const hit = this._posFromEvent(e);
        if (hit != null) pos = hit;
      }
      const word = this._wordAt(pos);
      if (!word) { if (!wantJump) this.closeReferences(); return; }

      if (!this._navData || this._navLoading || this._navStale()) {
        await this._refreshNav(true);
      }
      const occ = this._occAtPos(word.start);
      if (!occ) {
        // 未解析 / 无导航信息（如语法错误时）：仅选中词并提示
        this._selectWord(word);
        if (!wantJump) this._showPlainWord(word);
        else ML.toast("无法跳转：该名字未能解析到定义", "err");
        return;
      }
      if (occ.resolved && occ.sid != null) {
        this._selectSid(occ.sid, true, word);
        if (wantJump) this.jumpToDefinition(occ.sid);
      } else {
        this._selectWord(word);
        this._selectUnresolved(occ, word);
      }
    }

    _navStale() {
      // 数据每次编辑后按防抖刷新；点击时若正在加载则等待，加载完成即与源码同步
      return this._navLoading;
    }

    async _navigateAtCursor() {
      const pos = this.ta.selectionStart;
      const word = this._wordAt(pos) || this._wordAt(Math.max(0, pos - 1));
      if (!word) { ML.toast("请把光标放到标识符上再按 F12"); return; }
      if (!this._navData || this._navLoading) await this._refreshNav(true);
      const occ = this._occAtPos(word.start);
      if (!occ) { ML.toast("无法跳转：该名字未能解析到定义", "err"); return; }
      if (!occ.resolved || occ.sid == null) {
        this._selectWord(word);
        this._selectUnresolved(occ, word);
        ML.toast("该名字在作用域中找不到定义", "err");
        return;
      }
      this._selectSid(occ.sid, true, word);
      this.jumpToDefinition(occ.sid);
    }

    _selectWord(word) {
      this.ta.focus();
      this.ta.setSelectionRange(word.start, word.end);
    }

    /* ---- 选中某个符号：高亮全部出现位置 + 渲染引用面板 ---- */
    _selectSid(sid, focusPanel, word) {
      this._selectedSid = sid;
      this._selectedUnresolved = null;
      if (!this._navData) return;
      const sym = this._navData.symbols.find((s) => s.sid === sid);
      if (!sym) return;
      if (word) this._selectWord(word);
      this._renderMarks();
      this._renderPanel(sym);
      if (focusPanel) this._navPanel.style.display = "block";
    }

    _selectUnresolved(occ, word) {
      this._selectedSid = null;
      this._selectedUnresolved = occ;
      this._renderMarks();
      this._renderUnresolvedPanel(occ);
      this._navPanel.style.display = "block";
    }

    _showPlainWord(word) {
      // 语法错误导致无导航数据时的降级面板
      if (!this._navPanel) return;
      this._selectedSid = null;
      this._selectedUnresolved = null;
      this._renderMarks();
      this._navPanel.innerHTML =
        `<div class="nav-head"><span class="mono" style="font-weight:700">${ML.escapeHtml(word.word)}</span>
          <span class="muted" style="font-size:12px">当前代码存在词法/语法错误，引用解析暂不可用</span>
          <button class="btn ghost sm nav-close" title="关闭（Esc）">✕</button></div>`;
      this._navPanel.style.display = "block";
      this._bindPanelClose();
    }

    /* ---- 出现位置高亮标记 ---- */
    _renderMarks() {
      if (!this.markLayer) return;
      this.markLayer.innerHTML = "";
      if (this._selectedSid == null && !this._selectedUnresolved) return;
      const text = this.ta.value;
      const starts = this._lineStarts(text);
      const cw = this._charWidth();
      const padX = 14, padY = 12, lh = 20;
      const draw = (line, column, len, cls) => {
        const el = document.createElement("div");
        el.className = "nav-mark " + cls;
        el.style.left = (padX + (column - 1) * cw) + "px";
        el.style.top = (padY + (line - 1) * lh) + "px";
        el.style.width = Math.max(4, len * cw) + "px";
        el.style.height = lh + "px";
        this.markLayer.appendChild(el);
      };
      if (this._selectedSid != null && this._navData) {
        const sym = this._navData.symbols.find((s) => s.sid === this._selectedSid);
        if (!sym) return;
        const occs = this._navData.occurrences.filter((o) => o.sid === this._selectedSid);
        occs.forEach((o) => {
          let cls = "mk-use";
          if (o.role === "call") cls = "mk-call";
          else if (o.role === "assign") cls = "mk-assign";
          else if (o.role === "declaration" || o.role === "parameter") cls = "mk-decl";
          draw(o.line, o.column, o.length, cls);
        });
      } else if (this._selectedUnresolved) {
        const o = this._selectedUnresolved;
        draw(o.line, o.column, o.name.length, "mk-unresolved");
      }
    }

    /* ---- 引用列表面板 ---- */
    _buildNavPanel() {
      const panel = document.createElement("div");
      panel.className = "nav-panel";
      panel.style.display = "none";
      // 放在编辑器下方（与编辑器同宽），跟随页面滚动
      this.container.appendChild(panel);
      this._navPanel = panel;
    }

    _scopeLabel(sym) {
      if (sym.is_builtin) return "内置";
      if (sym.scope_type === "global") return "全局作用域";
      if (sym.scope_type === "function") return `函数 ${sym.scope_name}()`;
      return "块作用域（局部）";
    }

    _roleBadge(role, roleLabel) {
      const map = {
        declaration: ["purple", "定义"],
        parameter: ["purple", "形参"],
        call: ["cyan", "调用"],
        assign: ["amber", "赋值"],
        read: ["blue", "使用"],
      };
      const [cls, txt] = map[role] || ["gray", roleLabel || role];
      return ML.badge(txt, cls);
    }

    _lineSnippet(line, column, len) {
      const text = this.ta.value;
      const lines = text.split("\n");
      const raw = lines[line - 1] != null ? lines[line - 1] : "";
      const col = Math.max(0, column - 1);
      const before = raw.slice(0, col);
      const hit = raw.slice(col, col + len);
      const after = raw.slice(col + len);
      return `<span class="muted">${ML.escapeHtml(before)}</span><span class="nav-hit">${ML.escapeHtml(hit)}</span><span class="muted">${ML.escapeHtml(after)}</span>`;
    }

    _rowHtml(line, column, len, role, roleLabel) {
      return `<div class="nav-row" data-line="${line}" data-column="${column}" data-len="${len}">
        <span class="nav-role">${this._roleBadge(role, roleLabel)}</span>
        <span class="nav-loc mono">L${line}:C${column}</span>
        <code class="nav-code">${this._lineSnippet(line, column, len)}</code>
      </div>`;
    }

    _renderPanel(sym) {
      const esc = ML.escapeHtml;
      const kindBadge = ML.badge(sym.kind_label,
        sym.kind === "function" ? "cyan" : sym.kind === "parameter" ? "purple" : "blue");
      let defRow = "";
      if (sym.definition) {
        const d = sym.definition;
        defRow = `<div class="nav-section">定义</div>` +
          this._rowHtml(d.line, d.column, sym.name.length, d.role, d.role_label);
      } else {
        defRow = `<div class="nav-section">定义</div>
          <div class="nav-row nav-builtin"><span class="nav-role">${ML.badge("内置", "gray")}</span>
          <span class="muted" style="font-size:12px">${esc(sym.name)} 是语言内置函数，无源码定义；下列为全部调用位置。</span></div>`;
      }
      const usageRows = sym.usages.map((u) =>
        this._rowHtml(u.line, u.column, sym.name.length, u.role, u.role_label)).join("");
      const callN = sym.usages.filter((u) => u.role === "call").length;
      const summary = sym.is_builtin
        ? `${sym.usages.length} 处调用`
        : `${sym.usages.length} 处使用` + (callN ? `（${callN} 次调用）` : "");

      this._navPanel.innerHTML = `
        <div class="nav-head">
          <span class="mono nav-title">${esc(sym.name)}</span>
          ${kindBadge}
          <span class="badge gray">${esc(this._scopeLabel(sym))}</span>
          <span class="muted nav-count">${esc(summary)}</span>
          <span class="spacer" style="flex:1"></span>
          ${this._backStack.length ? '<button class="btn ghost sm nav-back" title="Alt+←">↩ 回跳</button>' : ""}
          ${sym.definition ? '<button class="btn sm nav-jump">⤢ 跳转定义 <kbd>F12</kbd></button>' : ""}
          <button class="btn ghost sm nav-close" title="关闭（Esc）">✕</button>
        </div>
        ${defRow}
        <div class="nav-section">引用（${sym.usages.length}）</div>
        ${usageRows || '<div class="muted" style="font-size:12px;padding:4px 12px 8px">该符号暂无使用位置。</div>'}
        <div class="nav-hint muted">单击标识符查看引用 · 双击 / <kbd>F12</kbd> / Ctrl+点击跳转定义 · <kbd>Alt</kbd>+<kbd>←</kbd> 回跳 · <kbd>Esc</kbd> 关闭</div>`;
      this._bindPanelEvents(sym);
    }

    _renderUnresolvedPanel(occ) {
      const esc = ML.escapeHtml;
      this._navPanel.innerHTML = `
        <div class="nav-head">
          <span class="mono nav-title" style="color:var(--warning)">${esc(occ.name)}</span>
          ${ML.badge("未定义", "amber")}
          <span class="muted" style="font-size:12px">该名字在作用域链中找不到定义，无法跳转；下列为同名出现位置。</span>
          <span class="spacer" style="flex:1"></span>
          <button class="btn ghost sm nav-close" title="关闭（Esc）">✕</button>
        </div>
        <div class="nav-section">出现位置（${(this._navData.unresolved || []).filter((u) => u.name === occ.name).length}）</div>
        ${(this._navData.unresolved || []).filter((u) => u.name === occ.name).map((u) =>
          this._rowHtml(u.line, u.column, u.name.length, "unresolved", "未定义")).join("")}
        <div class="nav-hint muted">提示：检查拼写，或先用 <code>var</code> / 形参 / <code>func</code> 声明该名字。</div>`;
      this._bindPanelEvents(null);
    }

    _bindPanelEvents(sym) {
      this._bindPanelClose();
      const back = this._navPanel.querySelector(".nav-back");
      if (back) back.addEventListener("click", () => this.goBack());
      const jump = this._navPanel.querySelector(".nav-jump");
      if (jump && sym) jump.addEventListener("click", () => this.jumpToDefinition(sym.sid));
      this._navPanel.querySelectorAll(".nav-row[data-line]").forEach((row) => {
        row.addEventListener("click", () => {
          this._jumpTo(parseInt(row.dataset.line, 10), parseInt(row.dataset.column, 10),
            parseInt(row.dataset.len || "0", 10));
        });
      });
      // 内置函数说明行不可跳转
      const builtinRow = this._navPanel.querySelector(".nav-row.nav-builtin");
      if (builtinRow) delete builtinRow.dataset.line;
    }

    _bindPanelClose() {
      const x = this._navPanel.querySelector(".nav-close");
      if (x) x.addEventListener("click", () => this.closeReferences());
    }

    closeReferences() {
      if (this._navPanel) this._navPanel.style.display = "none";
      this._selectedSid = null;
      this._selectedUnresolved = null;
      this._renderMarks();
    }

    /* ---- 光标移动 / 滚动 / 闪烁 ---- */
    _jumpTo(line, column, len) {
      const text = this.ta.value;
      const starts = this._lineStarts(text);
      if (line < 1 || line > starts.length) return;
      const pos = starts[line - 1] + Math.max(0, column - 1);
      this._backStack.push(this.ta.selectionStart);
      if (this._backStack.length > 50) this._backStack.shift();
      this.ta.focus();
      this.ta.setSelectionRange(pos, pos + (len || 0));
      // 把目标行滚动到编辑区中间偏上
      const lh = 20, padY = 12;
      const target = padY + (line - 1) * lh;
      this.ta.scrollTop = Math.max(0, target - this.ta.clientHeight / 3);
      this._flashLine(line);
    }

    jumpToDefinition(sid) {
      if (!this._navData) return;
      const sym = this._navData.symbols.find((s) => s.sid === sid);
      if (!sym) return;
      if (!sym.definition) {
        ML.toast(`${sym.name} 是内置函数，无源码定义`);
        return;
      }
      this._jumpTo(sym.definition.line, sym.definition.column, sym.name.length);
    }

    goBack() {
      const pos = this._backStack.pop();
      if (pos == null) { ML.toast("没有可回跳的位置"); return; }
      const before = this.ta.value.slice(0, pos).split("\n");
      const line = before.length;
      this.ta.focus();
      this.ta.setSelectionRange(pos, pos);
      const lh = 20, padY = 12;
      this.ta.scrollTop = Math.max(0, padY + (line - 1) * lh - this.ta.clientHeight / 3);
      this._flashLine(line);
    }

    _flashLine(line) {
      this.ta.dataset.flashLine = line;
      const st = this.ta.scrollTop;
      let bar = this.wrap.querySelector(".nav-flash");
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "nav-flash";
        this.wrap.appendChild(bar);
      }
      bar.style.display = "block";
      bar.style.top = (12 + (line - 1) * 20 - st) + "px";
      bar.classList.remove("play");
      void bar.offsetWidth; // 重新触发动画
      bar.classList.add("play");
      clearTimeout(this._flashTimer);
      this._flashTimer = setTimeout(() => { bar.style.display = "none"; }, 1200);
    }
  };
})();
