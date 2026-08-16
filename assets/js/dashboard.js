(() => {
  "use strict";

  const POLL_MS = 3 * 60 * 1000;
  const CACHE_KEY = "osy-news-cache-v6";
  const LATEST_PAGE = 12;
  const isNarrow = () => window.matchMedia("(max-width: 959px)").matches;

  const state = {
    data: null,
    fingerprint: null,
    syncing: false,
    bound: false,
    month: "all",
    view: "latest",
    q: "",
    tagFilter: null,
    issues: [],
    filteredArticles: [],
    latestShown: 0,
    previewStack: [],
  };

  const el = {
    boot: document.getElementById("boot"),
    bootBar: document.getElementById("bootBar"),
    bootPct: document.getElementById("bootPct"),
    bootMsg: document.getElementById("bootMsg"),
    app: document.getElementById("app"),
    topBar: document.getElementById("topBar"),
    main: document.getElementById("main"),
    periodLabel: document.getElementById("periodLabel"),
    viewHint: document.getElementById("viewHint"),
    heroBand: document.getElementById("heroBand"),
    statGrid: document.getElementById("statGrid"),
    monthPulse: document.getElementById("monthPulse"),
    hotKeywords: document.getElementById("hotKeywords"),
    miniRank: document.getElementById("miniRank"),
    mobileRails: document.getElementById("mobileRails"),
    searchForm: document.getElementById("searchForm"),
    q: document.getElementById("q"),
    searchClear: document.getElementById("searchClear"),
    dateBtn: document.getElementById("dateBtn"),
    dateSheet: document.getElementById("dateSheet"),
    dateList: document.getElementById("dateList"),
    dateClose: document.getElementById("dateClose"),
    dateDim: document.getElementById("dateDim"),
    detailSheet: document.getElementById("detailSheet"),
    detailBody: document.getElementById("detailBody"),
    detailTitle: document.getElementById("detailTitle"),
    detailClose: document.getElementById("detailClose"),
    detailDim: document.getElementById("detailDim"),
    readerBack: document.getElementById("readerBack"),
    previewDock: document.getElementById("previewDock"),
    toTop: document.getElementById("toTop"),
    sourceLink: document.getElementById("sourceLink"),
    syncBtn: document.getElementById("syncBtn"),
    syncStatus: document.getElementById("syncStatus"),
    toast: document.getElementById("toast"),
  };

  const HINTS = {
    latest: "카드를 누르면 같은 자리에서 펼쳐 미리보기",
    popular: "이슈를 누르면 아래에서 바로 펼쳐 읽기",
    report: "펼친 뒤 미리보기로 같은 페이지에서 이어 읽기",
  };

  const setProgress = (n, msg) => {
    const p = Math.max(0, Math.min(100, Math.round(n)));
    el.bootBar.style.width = `${p}%`;
    el.bootPct.textContent = `${p}%`;
    if (msg) el.bootMsg.textContent = msg;
  };

  function setSyncStatus(text, mode) {
    el.syncStatus.textContent = text || "";
    el.syncStatus.dataset.mode = mode || "idle";
  }

  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    el.toast.classList.add("is-on");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      el.toast.classList.remove("is-on");
      el.toast.hidden = true;
    }, 3000);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeCache(data) {
    const save = () => {
      try {
        localStorage.setItem(
          CACHE_KEY,
          JSON.stringify({ savedAt: Date.now(), fingerprint: data.meta.fingerprint, data })
        );
      } catch {
        /* quota */
      }
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(save, { timeout: 2500 });
    else setTimeout(save, 0);
  }

  async function fetchBytesWithProgress(url, { cache = "no-store", onProgress } = {}) {
    const res = await fetch(url, { cache, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || 0;
    if (!res.body) {
      onProgress?.(1);
      return res.text();
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(total ? received / total : 0, received);
    }
    return new Blob(chunks).text();
  }

  function withTimeout(promise, ms, label = "timeout") {
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  }

  async function loadLiveDoc(onProgress) {
    const text = await fetchBytesWithProgress(window.NewsDoc.DOC_EXPORT_URL, {
      cache: "no-store",
      onProgress,
    });
    const data = window.NewsDoc.parseDoc(text);
    if (!data.articles.length) throw new Error("parsed empty");
    return data;
  }

  async function loadFallbackJson(onProgress) {
    const text = await fetchBytesWithProgress("data/news.json", {
      cache: "force-cache",
      onProgress,
    });
    const data = JSON.parse(text);
    if (!data.meta.fingerprint) {
      data.meta.fingerprint = [data.meta.total, data.articles[0]?.id || ""].join("|");
    }
    data.meta.live = false;
    return data;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }
  function formatShortDate(iso) {
    const [, m, d] = iso.split("-");
    return `${m}.${d}`;
  }
  function formatTime(isoOrMs) {
    const d = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("ko-KR", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  function daysSince(iso) {
    const t = new Date(iso + "T12:00:00").getTime();
    return Math.max(0, (Date.now() - t) / 86400000);
  }

  function applyFilters(articles) {
    let rows = articles;
    if (state.month !== "all") rows = rows.filter((a) => a.date.startsWith(state.month));
    if (state.tagFilter) rows = rows.filter((a) => (a.tags || []).includes(state.tagFilter));
    const q = state.q.trim().toLowerCase();
    if (q) {
      rows = rows.filter((a) => {
        const hay = `${a.title} ${a.summary} ${a.press} ${(a.tags || []).join(" ")}`.toLowerCase();
        return hay.includes(q);
      });
    }
    return rows.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  function buildIssues(articles) {
    const byTag = new Map();
    for (const a of articles) {
      const tags = a.tags?.length ? a.tags : ["#기타"];
      for (const tag of tags) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(a);
      }
    }
    const issues = [];
    for (const [tag, list] of byTag) {
      const unique = [];
      const seen = new Set();
      for (const a of list) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        unique.push(a);
      }
      unique.sort((a, b) => (a.date < b.date ? 1 : -1));
      if (!unique.length) continue;
      const pressSet = new Set(unique.map((a) => a.press));
      const recent = unique.filter((a) => daysSince(a.date) <= 21).length;
      const score = Math.round(
        unique.length * 12 + pressSet.size * 8 + recent * 6 + Math.max(0, 40 - daysSince(unique[0].date))
      );
      issues.push({
        id: tag,
        tag,
        articles: unique,
        lead: unique[0],
        count: unique.length,
        pressCount: pressSet.size,
        score,
        updated: unique[0].date,
      });
    }
    issues.sort((a, b) => b.score - a.score || (a.updated < b.updated ? 1 : -1));
    return issues;
  }

  function relatedArticles(article, limit = 8) {
    if (!article) return [];
    const tags = new Set(article.tags || []);
    const pool = state.filteredArticles.length ? state.filteredArticles : state.data.articles;
    if (!tags.size) {
      return pool.filter((a) => a.id !== article.id && a.week === article.week).slice(0, limit);
    }
    const scored = [];
    for (const a of pool) {
      if (a.id === article.id) continue;
      let overlap = 0;
      for (const t of a.tags || []) if (tags.has(t)) overlap += 1;
      if (!overlap) continue;
      const recency = Math.max(0, 30 - Math.abs(daysSince(a.date) - daysSince(article.date)));
      scored.push({ a, s: overlap * 10 + recency });
    }
    scored.sort((x, y) => y.s - x.s);
    return scored.slice(0, limit).map((x) => x.a);
  }

  function formatProse(text) {
    if (!text) return "";
    const cleaned = String(text).replace(/\s+/g, " ").trim();
    if (!cleaned) return "";
    const parts = cleaned
      .split(/(?<=[.。!?…])\s+|(?<=다\.)\s+|(?<=요\.)\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const chunks = parts.length > 1 ? parts : [cleaned];
    return chunks.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  }

  function findArticle(id) {
    return (
      state.filteredArticles.find((x) => x.id === id) ||
      state.data?.articles.find((x) => x.id === id) ||
      null
    );
  }

  function openSheet(sheet, open) {
    sheet.hidden = !open;
    if (!open && sheet === el.detailSheet) state.previewStack = [];
    const anyOpen = !el.dateSheet.hidden || !el.detailSheet.hidden;
    document.body.style.overflow = anyOpen ? "hidden" : "";
    if (sheet === el.dateSheet) el.dateBtn.setAttribute("aria-expanded", String(open));
    if (el.readerBack) el.readerBack.hidden = state.previewStack.length < 2;
  }

  function renderHero() {
    const lead = state.filteredArticles[0] || state.issues[0]?.lead;
    if (!lead) {
      el.heroBand.innerHTML = `<p class="hero-band__eye">ADMISSIONS BRIEF</p>
        <h1>조건에 맞는 이슈가 없습니다</h1>
        <p>기간·검색어를 조정해 보세요.</p>`;
      return;
    }
    el.heroBand.innerHTML = `
      <p class="hero-band__eye">TODAY’S BRIEF</p>
      <h1>${escapeHtml(lead.title)}</h1>
      <p>${escapeHtml(lead.summary || `${lead.press} · ${formatShortDate(lead.date)}`)}</p>
      <div class="hero-band__actions">
        <button type="button" class="btn-sm btn-sm--primary" data-preview="${escapeAttr(lead.id)}" style="background:#fff;color:#0b6b45">펼쳐 미리보기</button>
      </div>`;
  }

  function renderRails() {
    const m = state.data.meta;
    const count = state.filteredArticles.length;
    const months = (state.data.months || [])
      .filter((mo) => mo.month >= 1 && mo.month <= 12)
      .slice(0, 12);
    const maxM = Math.max(...months.map((x) => x.count), 1);
    const tags = (state.data.tags || []).slice(0, isNarrow() ? 10 : 14);
    const narrow = isNarrow();

    if (!narrow) {
      el.statGrid.innerHTML = `
        <div class="stat"><b>${count.toLocaleString("ko-KR")}</b><span>표시 기사</span></div>
        <div class="stat"><b>${state.issues.length}</b><span>이슈 클러스터</span></div>
        <div class="stat"><b>${m.weekCount}</b><span>주간</span></div>
        <div class="stat"><b>${m.pressCount}</b><span>매체</span></div>`;

      el.monthPulse.innerHTML =
        `<button type="button" class="pulse__row${state.month === "all" ? " is-on" : ""}" data-month="all" aria-pressed="${state.month === "all"}">
          <span class="pulse__check" aria-hidden="true"></span>
          <span class="pulse__label">전체</span>
          <span class="pulse__track"><span class="pulse__fill" style="width:100%"></span></span>
          <span class="pulse__n">${state.data.meta.total}</span>
        </button>` +
        months
          .map((mo) => {
            const key = `${mo.year}-${String(mo.month).padStart(2, "0")}`;
            const on = state.month === key;
            const pct = Math.round((mo.count / maxM) * 100);
            return `<button type="button" class="pulse__row${on ? " is-on" : ""}" data-month="${key}" aria-pressed="${on}">
              <span class="pulse__check" aria-hidden="true"></span>
              <span class="pulse__label">${String(mo.month).padStart(2, "0")}월</span>
              <span class="pulse__track"><span class="pulse__fill" style="width:${pct}%"></span></span>
              <span class="pulse__n">${mo.count}</span>
            </button>`;
          })
          .join("");

      el.hotKeywords.innerHTML = tags
        .map(
          (t) =>
            `<button type="button" class="${state.tagFilter === t.name ? "is-on" : ""}" data-tag="${escapeAttr(t.name)}">${escapeHtml(t.name)} · ${t.count}</button>`
        )
        .join("");

      el.miniRank.innerHTML = state.issues
        .slice(0, 8)
        .map(
          (iss, i) => `<button type="button" data-issue="${escapeAttr(iss.id)}">
            <span class="n">${i + 1}</span>
            <span><span class="t">${escapeHtml(iss.tag)} ${escapeHtml(iss.lead.title)}</span>
            <span class="s">관심도 ${iss.score} · ${iss.count}건</span></span>
          </button>`
        )
        .join("");
      el.mobileRails.innerHTML = "";
      return;
    }

    el.mobileRails.innerHTML = `
      <section class="glass glass--accent">
        <h2 class="glass__title">핫 키워드</h2>
        <div class="kw">${tags
          .map(
            (t) =>
              `<button type="button" class="${state.tagFilter === t.name ? "is-on" : ""}" data-tag="${escapeAttr(t.name)}">${escapeHtml(t.name)}</button>`
          )
          .join("")}</div>
      </section>
      <section class="glass">
        <h2 class="glass__title">빠른 필터 · ${count.toLocaleString("ko-KR")}건</h2>
        <div class="kw kw--months">${[
          `<button type="button" class="${state.month === "all" ? "is-on" : ""}" data-month="all">전체</button>`,
          ...months.slice(0, 6).map((mo) => {
            const key = `${mo.year}-${String(mo.month).padStart(2, "0")}`;
            return `<button type="button" class="${state.month === key ? "is-on" : ""}" data-month="${key}">${mo.month}월</button>`;
          }),
        ].join("")}</div>
      </section>`;
  }

  function renderPeriod() {
    const m = state.data.meta;
    let label =
      state.month === "all"
        ? `${(m.dateStart || "").replace(/-/g, ".")} – ${(m.dateEnd || "").replace(/-/g, ".")}`
        : `${state.month.replace("-", ".")} · ${state.filteredArticles.length}건`;
    if (state.q) label += ` · “${state.q}”`;
    if (state.tagFilter) label += ` · ${state.tagFilter}`;
    el.periodLabel.textContent = label;
    el.viewHint.textContent = HINTS[state.view];
  }

  function renderDateList() {
    const months = state.data.months;
    let html = `<button type="button" class="date-opt${state.month === "all" ? " is-on" : ""}" data-month="all">
      전체 기간<span>${state.data.meta.total}건</span></button>
      <div class="date-group">월별</div>`;
    for (const m of months) {
      if (m.month < 1 || m.month > 12) continue;
      const key = `${m.year}-${String(m.month).padStart(2, "0")}`;
      html += `<button type="button" class="date-opt${state.month === key ? " is-on" : ""}" data-month="${key}">
        ${m.label}<span>${m.count}건</span></button>`;
    }
    el.dateList.innerHTML = html;
  }

  function expandParts(a) {
    const tags = (a.tags || [])
      .slice(0, 8)
      .map((t) => `<span>${escapeHtml(t)}</span>`)
      .join("");
    const rel = relatedArticles(a, 5);
    const prose = formatProse(a.summary);
    const relHtml = rel.length
      ? rel
          .map(
            (r) => `<button type="button" class="expand__rel" data-inline-preview="${escapeAttr(r.id)}">
              <strong>${escapeHtml(r.title)}</strong>
              <span>${escapeHtml(r.press)} · ${formatShortDate(r.date)}</span>
            </button>`
          )
          .join("")
      : `<p class="expand__empty">연계 보도를 찾지 못했습니다.</p>`;
    return {
      tags,
      prose,
      side: `<aside class="expand__side">
        <h4>연계 이슈 <em>${rel.length}</em></h4>
        ${relHtml}
      </aside>`,
    };
  }

  function itemHeadHtml(a) {
    const tag = a.tags?.[0] || "";
    return `<div class="item__top">
        <time datetime="${escapeAttr(a.date)}">${formatShortDate(a.date)}</time>
        <span>${escapeHtml(a.press)}</span>
        ${tag ? `<span class="item__tag">${escapeHtml(tag)}</span>` : ""}
      </div>
      <h3 class="item__title">${escapeHtml(a.title)}</h3>
      ${a.summary ? `<p class="item__sum">${escapeHtml(a.summary)}</p>` : ""}`;
  }

  function expandBodyHtml(a, { collapse = true } = {}) {
    const { tags, prose, side } = expandParts(a);
    return `<div class="expand">
      <div class="expand__main">
        ${
          prose
            ? `<div class="expand__prose">${prose}</div>`
            : `<p class="expand__empty">요약 문장이 없습니다. 필요하면 원문에서 확인하세요.</p>`
        }
        ${tags ? `<div class="expand__tags tags">${tags}</div>` : ""}
        <div class="expand__actions">
          ${collapse ? `<button type="button" class="btn-sm" data-collapse>접기</button>` : ""}
          <button type="button" class="btn-sm btn-sm--primary" data-site-preview>원문 사이트</button>
        </div>
      </div>
      ${side}
      <div class="expand__site" hidden>
        <div class="expand__site-bar">
          <strong>원문 미리보기</strong>
          <div class="expand__site-bar-actions">
            <a class="btn-sm" href="${escapeAttr(a.url)}" target="_blank" rel="noopener noreferrer">새 탭</a>
            <button type="button" class="btn-sm" data-site-close>닫기</button>
          </div>
        </div>
        <iframe class="expand__site-frame" title="원문 미리보기" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" data-src="${escapeAttr(a.url)}"></iframe>
        <p class="expand__site-note">일부 언론사는 보안 정책으로 미리보기가 비어 보일 수 있습니다. 그때는 위의 요약으로 확인하거나 ‘새 탭’을 이용하세요.</p>
      </div>
    </div>`;
  }

  function toggleSitePreview(root, { force } = {}) {
    const expand = root?.closest?.(".expand") || root?.querySelector?.(".expand");
    if (!expand) return;
    const site = expand.querySelector(".expand__site");
    const btn = expand.querySelector("[data-site-preview]");
    const frame = site?.querySelector(".expand__site-frame");
    if (!site || !frame) return;
    const show = force != null ? force : site.hidden;
    site.hidden = !show;
    if (btn) btn.textContent = show ? "원문 닫기" : "원문 사이트";
    if (show) {
      if (!frame.getAttribute("src")) {
        const src = frame.dataset.src;
        if (src) frame.setAttribute("src", src);
      }
      requestAnimationFrame(() => {
        site.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    } else {
      frame.removeAttribute("src");
    }
  }

  function itemHtml(a) {
    const tag = a.tags?.[0] || "";
    const sumRaw = a.summary || "";
    const sum =
      sumRaw.length > 140 ? `${sumRaw.slice(0, 140)}…` : sumRaw;
    return `<article class="item" data-expand-id="${escapeAttr(a.id)}" tabindex="0" role="button" aria-expanded="false" aria-label="${escapeAttr(a.title)}">
      <div class="item__top">
        <time datetime="${escapeAttr(a.date)}">${formatShortDate(a.date)}</time>
        <span>${escapeHtml(a.press)}</span>
        ${tag ? `<span class="item__tag">${escapeHtml(tag)}</span>` : ""}
      </div>
      <h3 class="item__title">${escapeHtml(a.title)}</h3>
      ${sum ? `<p class="item__sum">${escapeHtml(sum)}</p>` : ""}
      <p class="item__hint">탭하여 펼쳐 미리보기 →</p>
      <div class="item__panel" aria-hidden="true">
        <div class="item__panel-inner"></div>
      </div>
    </article>`;
  }

  function fillItemPanel(card, a, { force = false } = {}) {
    const panelInner = card.querySelector(".item__panel-inner");
    if (!panelInner || !a) return;
    if (!force && panelInner.dataset.filled === a.id) return;
    panelInner.innerHTML = expandBodyHtml(a);
    panelInner.dataset.filled = a.id;
  }

  function setItemOpen(card, open) {
    if (!card) return;
    card.classList.toggle("is-open", open);
    card.setAttribute("aria-expanded", String(open));
    const hint = card.querySelector(".item__hint");
    if (hint) hint.textContent = open ? "접기 ▲" : "탭하여 펼쳐 미리보기 →";
    const panel = card.querySelector(".item__panel");
    if (panel) panel.setAttribute("aria-hidden", String(!open));
  }

  function collapseAllItems(exceptId) {
    document.querySelectorAll(".item.is-open").forEach((card) => {
      if (exceptId && card.dataset.expandId === exceptId) return;
      setItemOpen(card, false);
    });
  }

  function closePreviewDock() {
    if (!el.previewDock) return;
    el.previewDock.hidden = true;
    el.previewDock.innerHTML = "";
    el.previewDock.classList.remove("is-on");
  }

  function dockHtml(a) {
    const weekShort = a.week
      ? escapeHtml(String(a.week).replace(/^진학\s*뉴스\s*/i, "").replace(/\.$/, ""))
      : "";
    return `
      <div class="preview-dock__bar">
        <p class="preview-dock__eye">미리보기</p>
        <button type="button" class="btn-sm" data-dock-close>닫기</button>
      </div>
      <div class="preview-dock__meta">
        <span class="press">${escapeHtml(a.press)}</span>
        <time datetime="${escapeAttr(a.date)}">${formatShortDate(a.date)}</time>
        ${weekShort ? `<span>${weekShort}</span>` : ""}
      </div>
      <h3 class="preview-dock__title">${escapeHtml(a.title)}</h3>
      ${expandBodyHtml(a, { collapse: false })}`;
  }

  function renderPreviewDock(a, { scroll = true } = {}) {
    if (!el.previewDock || !a) return;
    el.previewDock.hidden = false;
    el.previewDock.classList.add("is-on");
    el.previewDock.dataset.viewingId = a.id;
    el.previewDock.innerHTML = dockHtml(a);
    if (scroll) {
      requestAnimationFrame(() => {
        el.previewDock.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
  }

  function swapItemPreview(card, a) {
    if (!card || !a) return;
    card.classList.add("is-swapping");
    const apply = () => {
      const tag = a.tags?.[0] || "";
      const top = card.querySelector(".item__top");
      const title = card.querySelector(".item__title");
      const sum = card.querySelector(".item__sum");
      if (top) {
        top.innerHTML = `<time datetime="${escapeAttr(a.date)}">${formatShortDate(a.date)}</time>
          <span>${escapeHtml(a.press)}</span>
          ${tag ? `<span class="item__tag">${escapeHtml(tag)}</span>` : ""}`;
      }
      if (title) title.textContent = a.title;
      if (sum) {
        const text = a.summary || "";
        sum.textContent = text.length > 140 ? `${text.slice(0, 140)}…` : text;
      }
      fillItemPanel(card, a, { force: true });
      card.dataset.viewingId = a.id;
      card.setAttribute("aria-label", a.title);
      card.classList.remove("is-swapping");
    };
    window.setTimeout(apply, 60);
  }

  function openInlinePreview(articleId, fromEl) {
    const a = findArticle(articleId);
    if (!a) return;
    const item = fromEl?.closest?.(".item.is-open");
    if (item) {
      swapItemPreview(item, a);
      return;
    }
    const dock = fromEl?.closest?.(".preview-dock");
    if (dock && el.previewDock && !el.previewDock.hidden) {
      el.previewDock.classList.add("is-swapping");
      window.setTimeout(() => {
        renderPreviewDock(a, { scroll: false });
        el.previewDock.classList.remove("is-swapping");
      }, 90);
      return;
    }
    openPreview(articleId);
  }

  function expandItem(articleId, { toggle = true, scroll = true } = {}) {
    const card = document.querySelector(`.item[data-expand-id="${CSS.escape(articleId)}"]`);
    if (!card) return false;
    const willOpen = toggle ? !card.classList.contains("is-open") : true;
    collapseAllItems(willOpen ? articleId : null);
    setItemOpen(card, willOpen);
    if (willOpen) {
      closePreviewDock();
      const a = findArticle(articleId);
      if (a) {
        card.dataset.viewingId = a.id;
        fillItemPanel(card, a);
      }
    }
    if (willOpen && scroll) {
      requestAnimationFrame(() => {
        card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
    return true;
  }

  function openPreview(articleId, { toggle = false } = {}) {
    const a = findArticle(articleId);
    if (!a) return;
    openSheet(el.detailSheet, false);

    if (expandItem(articleId, { toggle, scroll: true })) return;

    if (state.view === "latest") {
      const idx = state.filteredArticles.findIndex((x) => x.id === articleId);
      if (idx >= 0) {
        let guard = 0;
        while (state.latestShown <= idx && guard < 30) {
          renderLatest(true);
          guard += 1;
        }
        if (expandItem(articleId, { toggle: false, scroll: true })) return;
      }
    }

    collapseAllItems();
    renderPreviewDock(a);
  }

  function renderLatest(append = false) {
    const list = state.filteredArticles;
    if (!append) {
      state.latestShown = 0;
      if (state._feedIO) state._feedIO.disconnect();
      if (!list.length) {
        el.main.innerHTML = `<p class="empty">검색·기간 조건에 맞는 이슈가 없습니다.</p>`;
        return;
      }
      el.main.innerHTML = `<div class="feed" id="feed"></div><div id="sentinel" aria-hidden="true"></div>`;
      const sentinel = document.getElementById("sentinel");
      if (sentinel && state._feedIO) state._feedIO.observe(sentinel);
    }
    const feed = document.getElementById("feed");
    if (!feed) return;
    const next = list.slice(state.latestShown, state.latestShown + LATEST_PAGE);
    feed.insertAdjacentHTML("beforeend", next.map(itemHtml).join(""));
    state.latestShown += next.length;
  }

  function renderPopular() {
    const maxScore = state.issues[0]?.score || 1;
    if (!state.issues.length) {
      el.main.innerHTML = `<p class="empty">인기 이슈가 없습니다.</p>`;
      return;
    }
    el.main.innerHTML = `<div class="pop">${state.issues
      .slice(0, isNarrow() ? 24 : 36)
      .map((iss) => {
        const pct = Math.round((iss.score / maxScore) * 100);
        return `<button type="button" class="pop-card" data-issue="${escapeAttr(iss.id)}">
          <div>
            <h3 class="pop-card__title">${escapeHtml(iss.tag)} · ${escapeHtml(iss.lead.title)}</h3>
            <div class="pop-card__meta">
              <span>관심도 ${iss.score.toLocaleString("ko-KR")}</span>
              <span>연계 ${iss.count}건</span>
              <span>매체 ${iss.pressCount}</span>
              <span>${formatShortDate(iss.updated)}</span>
            </div>
            <div class="pop-card__heat" aria-hidden="true"><i style="width:${pct}%"></i></div>
          </div>
        </button>`;
      })
      .join("")}</div>`;
  }

  function renderReport() {
    const articles = state.filteredArticles.slice(0, isNarrow() ? 24 : 40);
    if (!articles.length) {
      el.main.innerHTML = `<p class="empty">보고서 항목이 없습니다.</p>`;
      return;
    }
    el.main.innerHTML = `<div class="report-grid">${articles
      .map((a, idx) => {
        const open = idx < 1;
        const tags = (a.tags || [])
          .slice(0, 4)
          .map((t) => `<span>${escapeHtml(t)}</span>`)
          .join("");
        const body = open
          ? (() => {
              const rel = relatedArticles(a, 4);
              const relHtml = rel.length
                ? rel
                    .map(
                      (r) => `<button type="button" class="rel" data-preview="${escapeAttr(r.id)}">
                  <strong>${escapeHtml(r.title)}</strong>
                  <span>${escapeHtml(r.press)} · ${formatShortDate(r.date)}</span>
                </button>`
                    )
                    .join("")
                : `<p class="rel"><span>연계 보도 없음</span></p>`;
              return `<div class="report-card__body">
            <div class="report-card__detail">
              <div class="expand__prose">${formatProse(a.summary || "세부 요약이 없습니다.")}</div>
              <div class="tags">${tags}</div>
              <div class="item__actions" style="margin-top:10px">
                <button type="button" class="btn-sm btn-sm--primary" data-preview="${escapeAttr(a.id)}">미리보기</button>
              </div>
            </div>
            <div class="report-card__links"><h4>연계 내용</h4>${relHtml}</div>
          </div>`;
            })()
          : `<div class="report-card__body"></div>`;
        return `<article class="report-card${open ? " is-open" : ""}" data-report-id="${escapeAttr(a.id)}">
          <button type="button" class="report-card__head" data-toggle="1">
            <div>
              <h3>${escapeHtml(a.title)}</h3>
              <div class="meta">${formatShortDate(a.date)} · ${escapeHtml(a.press)}</div>
            </div>
            <span class="report-card__chev">${open ? "접기" : "펼치기"}</span>
          </button>
          ${body}
        </article>`;
      })
      .join("")}</div>`;
  }

  function showIssue(tag) {
    const iss = state.issues.find((x) => x.id === tag);
    if (!iss) return;
    openPreview(iss.lead.id);
  }

  function renderView() {
    renderPeriod();
    renderHero();
    if (state.view === "latest") renderLatest(false);
    else if (state.view === "popular") renderPopular();
    else renderReport();
  }

  function refreshDataViews() {
    state.filteredArticles = applyFilters(state.data.articles);
    state.issues = buildIssues(state.filteredArticles);
    closePreviewDock();
    renderDateList();
    renderRails();
    renderView();
    el.searchClear.hidden = !state.q;
  }

  function mountData(data, { toast } = {}) {
    const prevTotal = state.data?.meta?.total;
    const changed = state.fingerprint && state.fingerprint !== data.meta.fingerprint;
    state.data = data;
    state.fingerprint = data.meta.fingerprint;
    writeCache(data);
    if (data.meta.source) el.sourceLink.href = data.meta.source;
    refreshDataViews();
    el.app.hidden = false;
    if (el.topBar) el.topBar.hidden = false;
    const live = data.meta.live ? "실시간" : "캐시";
    setSyncStatus(`${live} · ${formatTime(data.meta.updated || Date.now())}`, "ok");
    if (toast && changed) {
      const delta = (data.meta.total || 0) - (prevTotal || 0);
      showToast(delta > 0 ? `새 기사 ${delta}건 반영` : "Doc 변경 반영");
    }
  }

  async function syncFromDoc({ silent = false } = {}) {
    if (state.syncing) return;
    state.syncing = true;
    el.syncBtn.classList.add("is-busy");
    if (!silent) setSyncStatus("동기화 중…", "busy");
    else if (state.data) setSyncStatus("백그라운드 동기화…", "busy");
    try {
      const data = await withTimeout(loadLiveDoc(), silent ? 18000 : 28000, "doc-timeout");
      const changed = state.fingerprint !== data.meta.fingerprint;
      if (changed || !state.data) {
        mountData(data, { toast: silent && changed });
        if (!silent && changed) showToast("최신 Doc 반영");
        else if (!silent) setSyncStatus(`최신 · ${formatTime(Date.now())}`, "ok");
      } else {
        setSyncStatus(`최신 · ${formatTime(Date.now())}`, "ok");
      }
    } catch (err) {
      console.warn(err);
      if (!silent) setSyncStatus("동기화 실패", "err");
      else if (state.data) {
        const label = state.data.meta.live ? "실시간" : "캐시";
        setSyncStatus(`${label} · ${formatTime(state.data.meta.updated || Date.now())}`, "ok");
      }
    } finally {
      state.syncing = false;
      el.syncBtn.classList.remove("is-busy");
    }
  }

  function onTagClick(tag) {
    state.tagFilter = state.tagFilter === tag ? null : tag;
    refreshDataViews();
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;

    document.querySelectorAll(".tabs__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tabs__btn").forEach((b) => {
          b.classList.toggle("is-on", b === btn);
          b.setAttribute("aria-selected", String(b === btn));
        });
        state.view = btn.dataset.view;
        closePreviewDock();
        collapseAllItems();
        window.scrollTo({ top: 0 });
        renderView();
      });
    });

    el.searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      state.q = el.q.value;
      refreshDataViews();
    });
    el.q.addEventListener(
      "input",
      debounce(() => {
        state.q = el.q.value;
        refreshDataViews();
      }, 200)
    );
    el.searchClear.addEventListener("click", () => {
      state.q = "";
      el.q.value = "";
      refreshDataViews();
    });

    el.dateBtn.addEventListener("click", () => openSheet(el.dateSheet, el.dateSheet.hidden));
    el.dateClose.addEventListener("click", () => openSheet(el.dateSheet, false));
    el.dateDim.addEventListener("click", () => openSheet(el.dateSheet, false));
    el.detailClose?.addEventListener("click", () => openSheet(el.detailSheet, false));
    el.detailDim?.addEventListener("click", () => openSheet(el.detailSheet, false));

    el.dateList.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-month]");
      if (!btn) return;
      state.month = btn.dataset.month;
      openSheet(el.dateSheet, false);
      refreshDataViews();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    const railClick = (e) => {
      const tag = e.target.closest("[data-tag]");
      if (tag) {
        onTagClick(tag.dataset.tag);
        return;
      }
      const month = e.target.closest("[data-month]");
      if (month && month.dataset.month) {
        const next = month.dataset.month;
        state.month = state.month === next && next !== "all" ? "all" : next;
        refreshDataViews();
        return;
      }
      const issue = e.target.closest("[data-issue]");
      if (issue) showIssue(issue.dataset.issue);
    };
    el.hotKeywords.addEventListener("click", railClick);
    el.monthPulse.addEventListener("click", railClick);
    el.miniRank.addEventListener("click", railClick);
    el.mobileRails.addEventListener("click", railClick);

    const onPreviewClick = (e) => {
      if (e.target.closest("a[href]")) return;
      const dockClose = e.target.closest("[data-dock-close]");
      if (dockClose) {
        e.preventDefault();
        closePreviewDock();
        return;
      }
      const siteClose = e.target.closest("[data-site-close]");
      if (siteClose) {
        e.preventDefault();
        toggleSitePreview(siteClose, { force: false });
        return;
      }
      const siteOpen = e.target.closest("[data-site-preview]");
      if (siteOpen) {
        e.preventDefault();
        e.stopPropagation();
        toggleSitePreview(siteOpen);
        return;
      }
      const inline = e.target.closest("[data-inline-preview]");
      if (inline) {
        e.preventDefault();
        e.stopPropagation();
        openInlinePreview(inline.dataset.inlinePreview, inline);
        return;
      }
      const preview = e.target.closest("[data-preview]");
      if (preview) {
        e.preventDefault();
        openPreview(preview.dataset.preview);
        return;
      }
      const collapse = e.target.closest("[data-collapse]");
      if (collapse) {
        e.preventDefault();
        const card = collapse.closest(".item");
        if (card) setItemOpen(card, false);
        else closePreviewDock();
        return;
      }
      const item = e.target.closest(".item[data-expand-id]");
      if (item) {
        if (
          e.target.closest(".item__panel") &&
          !e.target.closest("[data-collapse], [data-inline-preview], [data-site-preview], [data-site-close]")
        ) {
          return;
        }
        e.preventDefault();
        expandItem(item.dataset.expandId);
        return;
      }
      const issue = e.target.closest("[data-issue]");
      if (issue) {
        showIssue(issue.dataset.issue);
        return;
      }
      const toggle = e.target.closest("[data-toggle]");
      if (toggle) {
        const card = toggle.closest(".report-card");
        if (!card) return;
        const open = card.classList.toggle("is-open");
        const chev = card.querySelector(".report-card__chev");
        if (chev) chev.textContent = open ? "접기" : "펼치기";
        if (open) {
          let body = card.querySelector(".report-card__body");
          if (body && !body.querySelector(".report-card__detail")) {
            const a = findArticle(card.dataset.reportId);
            if (a) {
              const rel = relatedArticles(a, 4);
              const tags = (a.tags || [])
                .slice(0, 4)
                .map((t) => `<span>${escapeHtml(t)}</span>`)
                .join("");
              const relHtml = rel.length
                ? rel
                    .map(
                      (r) => `<button type="button" class="rel" data-preview="${escapeAttr(r.id)}">
                  <strong>${escapeHtml(r.title)}</strong>
                  <span>${escapeHtml(r.press)} · ${formatShortDate(r.date)}</span>
                </button>`
                    )
                    .join("")
                : `<p class="rel"><span>연계 보도 없음</span></p>`;
              body.outerHTML = `<div class="report-card__body">
            <div class="report-card__detail">
              <div class="expand__prose">${formatProse(a.summary || "세부 요약이 없습니다.")}</div>
              <div class="tags">${tags}</div>
              <div class="item__actions" style="margin-top:10px">
                <button type="button" class="btn-sm btn-sm--primary" data-preview="${escapeAttr(a.id)}">미리보기</button>
              </div>
            </div>
            <div class="report-card__links"><h4>연계 내용</h4>${relHtml}</div>
          </div>`;
            }
          }
        }
      }
    };

    el.heroBand.addEventListener("click", onPreviewClick);
    el.previewDock.addEventListener("click", onPreviewClick);
    el.main.addEventListener("click", onPreviewClick);

    el.main.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const item = e.target.closest(".item[data-expand-id]");
      if (!item || e.target.closest("a, button")) return;
      e.preventDefault();
      expandItem(item.dataset.expandId);
    });

    el.syncBtn.addEventListener("click", () => syncFromDoc({ silent: false }));
    el.toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

    let scrollTick = false;
    window.addEventListener(
      "scroll",
      () => {
        if (scrollTick) return;
        scrollTick = true;
        requestAnimationFrame(() => {
          scrollTick = false;
          el.toTop.hidden = window.scrollY < 480;
        });
      },
      { passive: true }
    );

    const io =
      "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => {
              if (!entries.some((e) => e.isIntersecting)) return;
              if (state.view !== "latest") return;
              if (state.latestShown >= state.filteredArticles.length) return;
              renderLatest(true);
            },
            { rootMargin: "600px 0px" }
          )
        : null;
    state._feedIO = io;

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      openSheet(el.dateSheet, false);
      openSheet(el.detailSheet, false);
      closePreviewDock();
      collapseAllItems();
    });

    setInterval(() => {
      if (document.visibilityState === "visible") syncFromDoc({ silent: true });
    }, POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") syncFromDoc({ silent: true });
    });
  }

  function finishBoot() {
    setProgress(100, "완료");
    requestAnimationFrame(() => {
      el.boot.classList.add("is-done");
      el.boot.setAttribute("aria-busy", "false");
    });
  }

  async function boot() {
    bind();
    setProgress(8, "화면 준비 중…");

    const cached = readCache();
    if (cached?.data?.articles?.length) {
      setProgress(85, "저장된 데이터로 여는 중…");
      mountData(cached.data);
      setSyncStatus(`캐시 · ${formatTime(cached.savedAt)}`, "ok");
      finishBoot();
      setTimeout(() => syncFromDoc({ silent: true }), 400);
      return;
    }

    try {
      setProgress(15, "로컬 데이터 로딩…");
      const data = await loadFallbackJson((ratio) => {
        setProgress(15 + Math.min(ratio || 0, 1) * 70, "로딩 중…");
      });
      setProgress(92, "대시보드 구성 중…");
      mountData(data);
      finishBoot();
      setTimeout(() => syncFromDoc({ silent: true }), 400);
      return;
    } catch (err) {
      console.warn(err);
    }

    try {
      setProgress(10, "Google Doc 연결 중…");
      const data = await withTimeout(
        loadLiveDoc((ratio, received) => {
          const pct = 12 + Math.min(ratio || received / 2_000_000, 1) * 70;
          setProgress(pct, ratio ? `다운로드 ${Math.round(ratio * 100)}%` : "다운로드 중…");
        }),
        20000,
        "doc-timeout"
      );
      setProgress(92, "대시보드 구성 중…");
      mountData(data);
      finishBoot();
    } catch (err) {
      console.error(err);
      setProgress(100, "실패");
      el.bootMsg.textContent = "데이터를 불러오지 못했습니다. 새로고침 해주세요.";
    }
  }

  boot();
})();
