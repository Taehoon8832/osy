(() => {
  "use strict";

  const POLL_MS = 3 * 60 * 1000;
  const CACHE_KEY = "osy-news-cache-v4";
  const LATEST_PAGE = 40;

  const state = {
    data: null,
    fingerprint: null,
    syncing: false,
    bound: false,
    month: "all",
    view: "latest",
    issues: [],
    filteredArticles: [],
    latestShown: 0,
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
    toTop: document.getElementById("toTop"),
    sourceLink: document.getElementById("sourceLink"),
    syncBtn: document.getElementById("syncBtn"),
    syncStatus: document.getElementById("syncStatus"),
    toast: document.getElementById("toast"),
  };

  const HINTS = {
    latest: "날짜순 최신 이슈 · 상세·연계 기사 확인",
    popular: "연관 보도·이슈 밀도 기준 인기 순위 (조회수 대체 지표)",
    report: "제목 · 세부 내용 · 연계 보도를 한 화면에서 확인",
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
      const text = await res.text();
      onProgress?.(1);
      return text;
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

  function filterByMonth(articles) {
    if (state.month === "all") return articles.slice();
    return articles.filter((a) => a.date.startsWith(state.month));
  }

  /** Build issue clusters by primary tag; score ≈ popularity proxy */
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
      if (unique.length < 1) continue;

      const pressSet = new Set(unique.map((a) => a.press));
      const recent = unique.filter((a) => daysSince(a.date) <= 21).length;
      // 관심도 점수: 보도량 + 매체 다양성 + 최신성 (조회수 대체)
      const score = Math.round(
        unique.length * 12 + pressSet.size * 8 + recent * 6 + Math.max(0, 40 - daysSince(unique[0].date))
      );

      issues.push({
        id: tag,
        tag,
        title: tag.replace(/^#/, "") + " 이슈",
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
    if (!tags.size) {
      return state.filteredArticles.filter((a) => a.id !== article.id && a.week === article.week).slice(0, limit);
    }
    const scored = [];
    for (const a of state.filteredArticles) {
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

  function openSheet(sheet, open) {
    sheet.hidden = !open;
    document.body.style.overflow = open ? "hidden" : "";
    if (sheet === el.dateSheet) el.dateBtn.setAttribute("aria-expanded", String(open));
  }

  function renderPeriod() {
    const m = state.data.meta;
    if (state.month === "all") {
      el.periodLabel.textContent = `${(m.dateStart || "").replace(/-/g, ".")} – ${(m.dateEnd || "").replace(/-/g, ".")}`;
    } else {
      const [y, mo] = state.month.split("-");
      el.periodLabel.textContent = `${y}.${mo} · ${state.filteredArticles.length}건`;
    }
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
    return `<article class="item" data-id="${escapeAttr(a.id)}">
      <div class="item__top">
        <time datetime="${escapeAttr(a.date)}">${formatShortDate(a.date)}</time>
        <span>${escapeHtml(a.press)}</span>
        ${tag ? `<span class="item__tag">${escapeHtml(tag)}</span>` : ""}
      </div>
      <h3 class="item__title">${escapeHtml(a.title)}</h3>
      ${a.summary ? `<p class="item__sum">${escapeHtml(a.summary)}</p>` : ""}
      <div class="item__actions">
        <button type="button" class="btn-sm btn-sm--primary" data-detail="${escapeAttr(a.id)}">상세·연계</button>
        <a class="btn-sm" href="${escapeAttr(a.url)}" target="_blank" rel="noopener noreferrer">원문</a>
      </div>
    </article>`;
  }

  function renderLatest(append = false) {
    const list = state.filteredArticles;
    if (!append) {
      state.latestShown = 0;
      if (!list.length) {
        el.main.innerHTML = `<p class="empty">해당 기간 이슈가 없습니다.</p>`;
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
                (r) => `<a class="rel" href="${escapeAttr(r.url)}" target="_blank" rel="noopener noreferrer">
                  ${escapeHtml(r.title)}
                  <span>${escapeHtml(r.press)} · ${formatShortDate(r.date)}</span>
                </a>`
              )
              .join("")
          : `<p class="rel"><span>연계 보도 없음</span></p>`;
        return `<article class="report-card${idx < 2 ? " is-open" : ""}" data-id="${escapeAttr(a.id)}">
          <button type="button" class="report-card__head" data-toggle="${escapeAttr(a.id)}">
            <div>
              <h3>${escapeHtml(a.title)}</h3>
              <div class="meta">${formatShortDate(a.date)} · ${escapeHtml(a.press)} · 연계 ${rel.length}</div>
            </div>
            <span class="report-card__chev">${idx < 2 ? "접기" : "펼치기"}</span>
          </button>
          <div class="report-card__body">
            <div class="report-card__detail">
              <p>${escapeHtml(a.summary || "세부 요약이 없습니다. 원문에서 확인해 주세요.")}</p>
              <div class="tags">${tags}</div>
              <div class="item__actions" style="margin-top:10px">
                <button type="button" class="btn-sm btn-sm--primary" data-detail="${escapeAttr(a.id)}">전체 상세</button>
                <a class="btn-sm" href="${escapeAttr(a.url)}" target="_blank" rel="noopener noreferrer">원문</a>
              </div>
            </div>
            <div class="report-card__links">
              <h4>연계 내용</h4>
              ${relHtml}
            </div>
          </div>
        </article>`;
      })
      .join("")}</div>`;
  }

  function showDetail(articleId) {
    const a = state.filteredArticles.find((x) => x.id === articleId) || state.data.articles.find((x) => x.id === articleId);
    if (!a) return;
    const rel = relatedArticles(a, 10);
    const tags = (a.tags || []).map((t) => `<span>${escapeHtml(t)}</span>`).join("");
    el.detailTitle.textContent = "이슈 상세";
    el.detailBody.innerHTML = `
      <div class="detail-hero">
        <div class="press">${escapeHtml(a.press)} · ${formatShortDate(a.date)}</div>
        <h3>${escapeHtml(a.title)}</h3>
        <div class="sum">${escapeHtml(a.summary || "세부 요약이 없습니다.")}</div>
        <div class="tags">${tags}</div>
        <div class="item__actions">
          <a class="btn-sm btn-sm--primary" href="${escapeAttr(a.url)}" target="_blank" rel="noopener noreferrer">원문 보기</a>
        </div>
      </div>
      <div class="detail-section">
        <h4>연계 내용 (${rel.length})</h4>
        ${
          rel.length
            ? rel
                .map(
                  (r) => `<a class="rel" href="${escapeAttr(r.url)}" target="_blank" rel="noopener noreferrer">
                    ${escapeHtml(r.title)}
                    <span>${escapeHtml(r.press)} · ${formatShortDate(r.date)}${(r.tags || [])
                      .slice(0, 2)
                      .map((t) => " · " + t)
                      .join("")}</span>
                  </a>`
                )
                .join("")
            : "<p class='empty' style='padding:16px'>연계 보도를 찾지 못했습니다.</p>"
        }
      </div>`;
    openSheet(el.detailSheet, true);
  }

  function showIssue(tag) {
    const iss = state.issues.find((x) => x.id === tag);
    if (!iss) return;
    el.detailTitle.textContent = iss.tag;
    const lead = iss.lead;
    const rest = iss.articles.slice(0, 15);
    el.detailBody.innerHTML = `
      <div class="detail-hero">
        <div class="press">관심도 ${iss.score.toLocaleString("ko-KR")} · 연계 ${iss.count}건 · 매체 ${iss.pressCount}</div>
        <h3>${escapeHtml(lead.title)}</h3>
        <div class="sum">${escapeHtml(lead.summary || "")}</div>
        <div class="item__actions">
          <a class="btn-sm btn-sm--primary" href="${escapeAttr(lead.url)}" target="_blank" rel="noopener noreferrer">대표 원문</a>
        </div>
      </div>
      <div class="detail-section">
        <h4>관련 보도 모음</h4>
        ${rest
          .map(
            (r) => `<a class="rel" href="${escapeAttr(r.url)}" target="_blank" rel="noopener noreferrer">
              ${escapeHtml(r.title)}
              <span>${escapeHtml(r.press)} · ${formatShortDate(r.date)}</span>
            </a>`
          )
          .join("")}
      </div>`;
    openSheet(el.detailSheet, true);
  }

  function renderView() {
    renderPeriod();
    if (state.view === "latest") renderLatest(false);
    else if (state.view === "popular") renderPopular();
    else renderReport();
  }

  function refreshDataViews() {
    state.filteredArticles = filterByMonth(state.data.articles).sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : 0
    );
    state.issues = buildIssues(state.filteredArticles);
    renderDateList();
    renderView();
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

    el.dateBtn.addEventListener("click", () => openSheet(el.dateSheet, el.dateSheet.hidden));
    el.dateClose.addEventListener("click", () => openSheet(el.dateSheet, false));
    el.dateDim.addEventListener("click", () => openSheet(el.dateSheet, false));
    el.detailClose.addEventListener("click", () => openSheet(el.detailSheet, false));
    el.detailDim.addEventListener("click", () => openSheet(el.detailSheet, false));

    el.dateList.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-month]");
      if (!btn) return;
      state.month = btn.dataset.month;
      openSheet(el.dateSheet, false);
      refreshDataViews();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    el.main.addEventListener("click", (e) => {
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
        if (sentinel.getBoundingClientRect().top < window.innerHeight + 400) {
          renderLatest(true);
        }
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
      setProgress(90, "이슈 정리 중…");
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
