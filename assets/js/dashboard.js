(() => {
  "use strict";

  const POLL_MS = 3 * 60 * 1000;
  const CACHE_KEY = "osy-news-cache-v5";
  const LATEST_PAGE = 40;

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
    toTop: document.getElementById("toTop"),
    sourceLink: document.getElementById("sourceLink"),
    syncBtn: document.getElementById("syncBtn"),
    syncStatus: document.getElementById("syncStatus"),
    toast: document.getElementById("toast"),
  };

  const HINTS = {
    latest: "카드를 누르면 페이지 안에서 바로 미리보기",
    popular: "연관 보도·이슈 밀도 기준 인기 순위",
    report: "제목·세부·연계를 펼쳐 보고, 미리보기로 이어 읽기",
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
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ savedAt: Date.now(), fingerprint: data.meta.fingerprint, data })
      );
    } catch {
      /* quota */
    }
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
      cache: "no-cache",
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
        <button type="button" class="btn-sm btn-sm--primary" data-detail="${escapeAttr(lead.id)}" style="background:#fff;color:#075c3a;box-shadow:none">미리보기</button>
      </div>`;
  }

  function renderRails() {
    const m = state.data.meta;
    const count = state.filteredArticles.length;
    el.statGrid.innerHTML = `
      <div class="stat"><b>${count.toLocaleString("ko-KR")}</b><span>표시 기사</span></div>
      <div class="stat"><b>${state.issues.length}</b><span>이슈 클러스터</span></div>
      <div class="stat"><b>${m.weekCount}</b><span>주간</span></div>
      <div class="stat"><b>${m.pressCount}</b><span>매체</span></div>`;

    const months = state.data.months.slice(0, 8);
    const maxM = Math.max(...months.map((x) => x.count), 1);
    el.monthPulse.innerHTML = months
      .map((mo) => {
        const key = `${mo.year}-${String(mo.month).padStart(2, "0")}`;
        const pct = Math.round((mo.count / maxM) * 100);
        return `<button type="button" class="pulse__row" data-month="${key}" style="width:100%;background:none;border:0;padding:0;cursor:pointer">
          <span>${String(mo.month).padStart(2, "0")}월</span>
          <span class="pulse__track"><span class="pulse__fill" style="width:${pct}%;display:block;height:100%"></span></span>
          <span>${mo.count}</span>
        </button>`;
      })
      .join("");

    const tags = (state.data.tags || []).slice(0, 14);
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

    // Mobile condensed rails
    el.mobileRails.innerHTML = `
      <section class="glass glass--accent">
        <h2 class="glass__title">핫 키워드</h2>
        <div class="kw">${tags
          .slice(0, 10)
          .map(
            (t) =>
              `<button type="button" class="${state.tagFilter === t.name ? "is-on" : ""}" data-tag="${escapeAttr(t.name)}">${escapeHtml(t.name)}</button>`
          )
          .join("")}</div>
      </section>
      <section class="glass">
        <h2 class="glass__title">브리핑 요약</h2>
        <div class="stat-grid">
          <div class="stat"><b>${count.toLocaleString("ko-KR")}</b><span>표시 기사</span></div>
          <div class="stat"><b>${state.issues.slice(0, 1)[0]?.score || 0}</b><span>최고 관심도</span></div>
        </div>
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
      const key = `${m.year}-${String(m.month).padStart(2, "0")}`;
      html += `<button type="button" class="date-opt${state.month === key ? " is-on" : ""}" data-month="${key}">
        ${m.label}<span>${m.count}건</span></button>`;
    }
    el.dateList.innerHTML = html;
  }

  function itemHtml(a) {
    const tag = a.tags?.[0] || "";
    return `<article class="item" data-detail="${escapeAttr(a.id)}" tabindex="0" role="button" aria-label="미리보기: ${escapeAttr(a.title)}">
      <div class="item__top">
        <time datetime="${escapeAttr(a.date)}">${formatShortDate(a.date)}</time>
        <span>${escapeHtml(a.press)}</span>
        ${tag ? `<span class="item__tag">${escapeHtml(tag)}</span>` : ""}
      </div>
      <h3 class="item__title">${escapeHtml(a.title)}</h3>
      ${a.summary ? `<p class="item__sum">${escapeHtml(a.summary)}</p>` : ""}
      <p class="item__hint">탭하여 미리보기</p>
    </article>`;
  }

  function renderLatest(append = false) {
    const list = state.filteredArticles;
    if (!append) {
      state.latestShown = 0;
      if (!list.length) {
        el.main.innerHTML = `<p class="empty">검색·기간 조건에 맞는 이슈가 없습니다.</p>`;
        return;
      }
      el.main.innerHTML = `<div class="feed" id="feed"></div><div id="sentinel" aria-hidden="true"></div>`;
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
      .slice(0, 40)
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
    const articles = state.filteredArticles.slice(0, 60);
    if (!articles.length) {
      el.main.innerHTML = `<p class="empty">보고서 항목이 없습니다.</p>`;
      return;
    }
    el.main.innerHTML = `<div class="report-grid">${articles
      .map((a, idx) => {
        const rel = relatedArticles(a, 5);
        const tags = (a.tags || [])
          .slice(0, 5)
          .map((t) => `<span>${escapeHtml(t)}</span>`)
          .join("");
        const relHtml = rel.length
          ? rel
              .map(
                (r) => `<button type="button" class="rel reader__rel" data-preview="${escapeAttr(r.id)}">
                  <strong>${escapeHtml(r.title)}</strong>
                  <span>${escapeHtml(r.press)} · ${formatShortDate(r.date)}</span>
                </button>`
              )
              .join("")
          : `<p class="rel"><span>연계 보도 없음</span></p>`;
        return `<article class="report-card${idx < 2 ? " is-open" : ""}">
          <button type="button" class="report-card__head" data-toggle="1">
            <div>
              <h3>${escapeHtml(a.title)}</h3>
              <div class="meta">${formatShortDate(a.date)} · ${escapeHtml(a.press)} · 연계 ${rel.length}</div>
            </div>
            <span class="report-card__chev">${idx < 2 ? "접기" : "펼치기"}</span>
          </button>
          <div class="report-card__body">
            <div class="report-card__detail">
              <div class="reader__prose" style="padding:0;max-width:none">${formatProse(a.summary || "세부 요약이 없습니다.")}</div>
              <div class="tags">${tags}</div>
              <div class="item__actions" style="margin-top:10px">
                <button type="button" class="btn-sm btn-sm--primary" data-detail="${escapeAttr(a.id)}">미리보기</button>
              </div>
            </div>
            <div class="report-card__links"><h4>연계 내용</h4>${relHtml}</div>
          </div>
        </article>`;
      })
      .join("")}</div>`;
  }

  function renderReader(a) {
    const rel = relatedArticles(a, 10);
    const tags = (a.tags || []).map((t) => `<span>${escapeHtml(t)}</span>`).join("");
    const prose = formatProse(a.summary);
    el.detailTitle.textContent = "미리보기";
    el.detailBody.innerHTML = `
      <div class="reader__hero">
        <div class="reader__meta">
          <span class="press">${escapeHtml(a.press)}</span>
          <time datetime="${escapeAttr(a.date)}">${formatShortDate(a.date)}</time>
          ${a.week ? `<span>${escapeHtml(a.week)}</span>` : ""}
        </div>
        <h3 class="reader__title">${escapeHtml(a.title)}</h3>
      </div>
      ${prose ? `<div class="reader__prose">${prose}</div>` : `<p class="reader__empty">요약 문장이 없습니다. 필요하면 원문 사이트에서 확인하세요.</p>`}
      <div class="reader__tags tags">${tags}</div>
      <div class="reader__actions">
        <button type="button" class="btn-sm" id="toggleEmbed">사이트 미리보기</button>
        <a class="btn-sm btn-sm--primary" href="${escapeAttr(a.url)}" target="_blank" rel="noopener noreferrer">원문 사이트</a>
      </div>
      <div class="reader__embed" id="readerEmbed" hidden>
        <iframe title="원문 미리보기" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" src="${escapeAttr(a.url)}"></iframe>
        <p class="reader__embed-note">일부 언론사는 보안 정책으로 미리보기가 가려질 수 있습니다. 그럴 땐 위의 요약과 연계 이슈로 확인하세요.</p>
      </div>
      <section class="reader__section">
        <h3>연계 이슈 · 탭하면 바로 미리보기</h3>
        ${
          rel.length
            ? rel
                .map(
                  (r) => `<button type="button" class="reader__rel" data-preview="${escapeAttr(r.id)}">
                    <strong>${escapeHtml(r.title)}</strong>
                    <span>${escapeHtml(r.press)} · ${formatShortDate(r.date)}</span>
                  </button>`
                )
                .join("")
            : `<p class="reader__empty" style="padding:0">연계 보도를 찾지 못했습니다.</p>`
        }
      </section>`;
    el.readerBack.hidden = state.previewStack.length < 2;
    const toggle = document.getElementById("toggleEmbed");
    const embed = document.getElementById("readerEmbed");
    toggle?.addEventListener("click", () => {
      const show = embed.hidden;
      embed.hidden = !show;
      toggle.textContent = show ? "미리보기 닫기" : "사이트 미리보기";
      if (show) embed.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  function showDetail(articleId, { push = true } = {}) {
    const a = findArticle(articleId);
    if (!a) return;
    if (push) {
      const last = state.previewStack[state.previewStack.length - 1];
      if (last !== articleId) state.previewStack.push(articleId);
    }
    renderReader(a);
    openSheet(el.detailSheet, true);
    el.detailBody.scrollTop = 0;
  }

  function showIssue(tag) {
    const iss = state.issues.find((x) => x.id === tag);
    if (!iss) return;
    showDetail(iss.lead.id, { push: true });
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
    try {
      const data = await loadLiveDoc();
      const changed = state.fingerprint !== data.meta.fingerprint;
      if (changed || !state.data) {
        mountData(data, { toast: silent && changed });
        if (!silent && changed) showToast("최신 Doc 반영");
      } else if (!silent) setSyncStatus(`최신 · ${formatTime(Date.now())}`, "ok");
    } catch (err) {
      console.warn(err);
      setSyncStatus("동기화 실패", "err");
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
    el.detailClose.addEventListener("click", () => openSheet(el.detailSheet, false));
    el.detailDim.addEventListener("click", () => openSheet(el.detailSheet, false));
    el.readerBack.addEventListener("click", () => {
      if (state.previewStack.length < 2) return;
      state.previewStack.pop();
      const prev = state.previewStack[state.previewStack.length - 1];
      showDetail(prev, { push: false });
    });

    el.detailBody.addEventListener("click", (e) => {
      const preview = e.target.closest("[data-preview]");
      if (preview) {
        e.preventDefault();
        showDetail(preview.dataset.preview);
      }
    });

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
        state.month = month.dataset.month;
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
    el.heroBand.addEventListener("click", (e) => {
      const d = e.target.closest("[data-detail]");
      if (d) showDetail(d.dataset.detail);
    });

    el.main.addEventListener("click", (e) => {
      const preview = e.target.closest("[data-preview]");
      if (preview) {
        e.preventDefault();
        showDetail(preview.dataset.preview);
        return;
      }
      const detail = e.target.closest("[data-detail]");
      if (detail) {
        e.preventDefault();
        showDetail(detail.dataset.detail);
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
      }
    });

    el.main.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const item = e.target.closest(".item[data-detail]");
      if (!item) return;
      e.preventDefault();
      showDetail(item.dataset.detail);
    });

    el.syncBtn.addEventListener("click", () => syncFromDoc({ silent: false }));
    el.toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
    window.addEventListener(
      "scroll",
      () => {
        el.toTop.hidden = window.scrollY < 500;
        if (state.view !== "latest") return;
        if (state.latestShown >= state.filteredArticles.length) return;
        const sentinel = document.getElementById("sentinel");
        if (!sentinel) return;
        if (sentinel.getBoundingClientRect().top < window.innerHeight + 400) renderLatest(true);
      },
      { passive: true }
    );

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      openSheet(el.dateSheet, false);
      openSheet(el.detailSheet, false);
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
    const cached = readCache();
    try {
      setProgress(6, "Google Doc 연결 중…");
      const data = await loadLiveDoc((ratio, received) => {
        const pct = 8 + Math.min(ratio || received / 2_000_000, 1) * 70;
        setProgress(pct, ratio ? `다운로드 ${Math.round(ratio * 100)}%` : "다운로드 중…");
      });
      setProgress(90, "대시보드 구성 중…");
      mountData(data);
      finishBoot();
      return;
    } catch (e) {
      console.warn(e);
    }

    if (cached?.data) {
      mountData(cached.data);
      setSyncStatus(`오프라인 캐시 · ${formatTime(cached.savedAt)}`, "warn");
      finishBoot();
      syncFromDoc({ silent: true });
      return;
    }

    try {
      const data = await loadFallbackJson((ratio) => setProgress(40 + ratio * 45, "백업 로딩…"));
      mountData(data);
      finishBoot();
      syncFromDoc({ silent: true });
    } catch (err) {
      console.error(err);
      setProgress(100, "실패");
      el.bootMsg.textContent = "Doc를 불러오지 못했습니다.";
    }
  }

  boot();
})();
