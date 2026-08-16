(() => {
  "use strict";

  const PAGE = 40;
  const state = {
    data: null,
    filtered: [],
    shown: 0,
    view: "list",
    sort: "newest",
    q: "",
    month: "all",
    week: null,
    press: null,
    tag: null,
  };

  const el = {
    boot: document.getElementById("boot"),
    bootBar: document.getElementById("bootBar"),
    bootPct: document.getElementById("bootPct"),
    bootMsg: document.getElementById("bootMsg"),
    kpi: document.getElementById("kpi"),
    months: document.getElementById("months"),
    weekChips: document.getElementById("weekChips"),
    pressChips: document.getElementById("pressChips"),
    tagChips: document.getElementById("tagChips"),
    list: document.getElementById("list"),
    hero: document.getElementById("hero"),
    feedCount: document.getElementById("feedCount"),
    empty: document.getElementById("empty"),
    sentinel: document.getElementById("sentinel"),
    q: document.getElementById("q"),
    searchForm: document.getElementById("searchForm"),
    sort: document.getElementById("sort"),
    filterToggle: document.getElementById("filterToggle"),
    rail: document.getElementById("rail"),
    activeFilters: document.getElementById("activeFilters"),
    toTop: document.getElementById("toTop"),
    sourceLink: document.getElementById("sourceLink"),
  };

  const pressInitial = (name) => {
    if (!name) return "?";
    const map = {
      연합뉴스: "연",
      노컷뉴스: "노",
      조선일보: "조",
      중앙일보: "중",
      동아일보: "동",
      한겨레: "한",
      경향신문: "경",
      한국경제: "한경",
      매일경제: "매",
      머니투데이: "머니",
      진학사: "진",
      뉴스1: "N1",
      뉴시스: "NS",
      유튜브: "YT",
      교육부: "교",
      베리타스알파: "베",
      서울신문: "서",
      국민일보: "국",
      한국일보: "한일",
    };
    return map[name] || name.slice(0, 2);
  };

  const setProgress = (n, msg) => {
    const p = Math.max(0, Math.min(100, Math.round(n)));
    el.bootBar.style.width = `${p}%`;
    el.bootPct.textContent = `${p}%`;
    if (msg) el.bootMsg.textContent = msg;
  };

  async function fetchWithProgress(url) {
    setProgress(4, "서버에 연결 중…");
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || 0;
    if (!res.body || !total) {
      setProgress(55, "데이터 수신 중…");
      const json = await res.json();
      setProgress(92, "화면 구성 중…");
      return json;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    setProgress(8, "기사 데이터 다운로드…");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      const pct = 8 + (received / total) * 72;
      setProgress(pct, `다운로드 ${Math.round((received / total) * 100)}%`);
    }
    setProgress(84, "JSON 파싱 중…");
    const blob = new Blob(chunks);
    const text = await blob.text();
    setProgress(92, "화면 구성 중…");
    return JSON.parse(text);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function monthKey(date) {
    return date.slice(0, 7);
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split("-");
    return `${y}.${m}.${d}`;
  }

  function weekLabel(week) {
    // 2026.08.02.~2026.08.08. → 08.02–08.08
    const m = week.match(/(\d{4})\.(\d{2})\.(\d{2})\.~(\d{4})\.(\d{2})\.(\d{2})/);
    if (!m) return week;
    return `${m[2]}.${m[3]}–${m[5]}.${m[6]}`;
  }

  function applyFilters() {
    const q = state.q.trim().toLowerCase();
    let rows = state.data.articles;

    if (state.month !== "all") {
      rows = rows.filter((a) => monthKey(a.date) === state.month);
    }
    if (state.week) rows = rows.filter((a) => a.week === state.week);
    if (state.press) rows = rows.filter((a) => a.press === state.press);
    if (state.tag) rows = rows.filter((a) => a.tags.includes(state.tag));
    if (q) {
      rows = rows.filter((a) => {
        const hay = `${a.title} ${a.press} ${a.summary} ${a.tags.join(" ")}`.toLowerCase();
        return hay.includes(q);
      });
    }

    rows = rows.slice();
    if (state.sort === "newest") {
      rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    } else if (state.sort === "oldest") {
      rows.sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
    } else if (state.sort === "press") {
      rows.sort((a, b) => a.press.localeCompare(b.press, "ko") || (a.date < b.date ? 1 : -1));
    }

    state.filtered = rows;
    state.shown = 0;
    el.list.innerHTML = "";
    renderHero();
    renderActiveFilters();
    el.feedCount.textContent = `${rows.length.toLocaleString("ko-KR")}건`;
    el.empty.hidden = rows.length > 0;
    loadMore();
  }

  function renderKpi() {
    const m = state.data.meta;
    el.kpi.hidden = false;
    el.kpi.querySelector('[data-k="total"]').textContent = m.total.toLocaleString("ko-KR");
    el.kpi.querySelector('[data-k="press"]').textContent = m.pressCount.toLocaleString("ko-KR");
    el.kpi.querySelector('[data-k="weeks"]').textContent = m.weekCount.toLocaleString("ko-KR");
    const start = m.dateStart?.replace(/-/g, ".") ?? "—";
    const end = m.dateEnd?.replace(/-/g, ".") ?? "—";
    el.kpi.querySelector('[data-k="range"]').textContent = `${start} – ${end}`;
    if (m.source) {
      el.sourceLink.href = m.source;
      el.sourceLink.hidden = false;
    }
  }

  function renderMonths() {
    const frag = document.createDocumentFragment();
    const all = document.createElement("button");
    all.type = "button";
    all.className = "month-chip is-on";
    all.dataset.month = "all";
    all.innerHTML = `전체<span>${state.data.meta.total}</span>`;
    frag.appendChild(all);

    for (const mo of state.data.months) {
      const key = `${mo.year}-${String(mo.month).padStart(2, "0")}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "month-chip";
      btn.dataset.month = key;
      btn.innerHTML = `${mo.year}.${String(mo.month).padStart(2, "0")}<span>${mo.count}</span>`;
      frag.appendChild(btn);
    }
    el.months.replaceChildren(frag);
  }

  function renderChips() {
    const weekFrag = document.createDocumentFragment();
    for (const w of state.data.weeks) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.week = w.week;
      b.innerHTML = `${weekLabel(w.week)}<span class="chip__n">${w.count}</span>`;
      weekFrag.appendChild(b);
    }
    el.weekChips.replaceChildren(weekFrag);

    const pressFrag = document.createDocumentFragment();
    for (const p of state.data.press.slice(0, 24)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.press = p.name;
      b.innerHTML = `${p.name}<span class="chip__n">${p.count}</span>`;
      pressFrag.appendChild(b);
    }
    el.pressChips.replaceChildren(pressFrag);

    const tagFrag = document.createDocumentFragment();
    for (const t of state.data.tags.slice(0, 36)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.tag = t.name;
      b.innerHTML = `${t.name}<span class="chip__n">${t.count}</span>`;
      tagFrag.appendChild(b);
    }
    el.tagChips.replaceChildren(tagFrag);
  }

  function syncChipActive() {
    el.weekChips.querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("is-on", c.dataset.week === state.week);
    });
    el.pressChips.querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("is-on", c.dataset.press === state.press);
    });
    el.tagChips.querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("is-on", c.dataset.tag === state.tag);
    });
    el.months.querySelectorAll(".month-chip").forEach((c) => {
      c.classList.toggle("is-on", c.dataset.month === state.month);
    });
  }

  function renderActiveFilters() {
    const items = [];
    if (state.month !== "all") items.push({ k: "month", label: state.month });
    if (state.week) items.push({ k: "week", label: weekLabel(state.week) });
    if (state.press) items.push({ k: "press", label: state.press });
    if (state.tag) items.push({ k: "tag", label: state.tag });
    if (state.q) items.push({ k: "q", label: `“${state.q}”` });

    if (!items.length) {
      el.activeFilters.hidden = true;
      el.activeFilters.replaceChildren();
      return;
    }
    el.activeFilters.hidden = false;
    const frag = document.createDocumentFragment();
    for (const it of items) {
      const span = document.createElement("span");
      span.className = "af";
      span.innerHTML = `${it.label}<button type="button" data-clear="${it.k}" aria-label="제거">×</button>`;
      frag.appendChild(span);
    }
    el.activeFilters.replaceChildren(frag);
  }

  function renderHero() {
    const a = state.filtered[0];
    if (!a) {
      el.hero.hidden = true;
      el.hero.replaceChildren();
      return;
    }
    el.hero.hidden = false;
    const tags = (a.tags || [])
      .slice(0, 5)
      .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
      .join("");
    el.hero.innerHTML = `
      <div class="hero__visual">
        <div>
          <div class="hero__eyebrow">TODAY PICK</div>
          <h2 class="hero__title">${escapeHtml(a.title)}</h2>
        </div>
        <div class="hero__meta">
          <span>${escapeHtml(a.press)}</span>
          <span>${formatDate(a.date)}</span>
          <span>${escapeHtml(weekLabel(a.week))}</span>
        </div>
      </div>
      <div class="hero__body">
        <p class="hero__summary">${escapeHtml(a.summary || "요약이 없는 기사입니다. 원문을 확인해 주세요.")}</p>
        <div class="hero__tags">${tags}</div>
        <a class="hero__cta" href="${escapeAttr(a.url)}" target="_blank" rel="noopener noreferrer">원문 보기 →</a>
      </div>`;
  }

  function cardHtml(a, i) {
    const tags = (a.tags || [])
      .slice(0, 3)
      .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
      .join("");
    const delay = Math.min(i, 8) * 28;
    return `
      <a class="card" href="${escapeAttr(a.url)}" target="_blank" rel="noopener noreferrer" style="animation-delay:${delay}ms">
        <div class="card__press" data-pid="${escapeAttr(a.pressId || "etc")}">${escapeHtml(pressInitial(a.press))}</div>
        <div class="card__main">
          <div class="card__top">
            <span class="card__press-name">${escapeHtml(a.press)}</span>
            <span class="card__dot"></span>
            <span>${escapeHtml(weekLabel(a.week))}</span>
          </div>
          <h3 class="card__title">${escapeHtml(a.title)}</h3>
          ${a.summary ? `<p class="card__summary">${escapeHtml(a.summary)}</p>` : ""}
        </div>
        <div class="card__side">
          <time class="card__date" datetime="${escapeAttr(a.date)}">${formatDate(a.date)}</time>
          <div class="card__tags">${tags}</div>
        </div>
      </a>`;
  }

  function loadMore() {
    // Index 0 is the hero; feed starts at 1
    if (state.shown === 0 && state.filtered.length) state.shown = 1;
    if (state.shown >= state.filtered.length) return;
    const next = state.filtered.slice(state.shown, state.shown + PAGE);
    if (!next.length) return;
    const start = state.shown;
    el.list.insertAdjacentHTML(
      "beforeend",
      next.map((a, i) => cardHtml(a, i)).join("")
    );
    state.shown = start + next.length;
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

  function clearFilter(key) {
    if (key === "month") state.month = "all";
    if (key === "week") state.week = null;
    if (key === "press") state.press = null;
    if (key === "tag") state.tag = null;
    if (key === "q") {
      state.q = "";
      el.q.value = "";
    }
    syncChipActive();
    applyFilters();
  }

  function bind() {
    el.searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      state.q = el.q.value;
      applyFilters();
    });
    el.q.addEventListener(
      "input",
      debounce(() => {
        state.q = el.q.value;
        applyFilters();
      }, 220)
    );

    el.sort.addEventListener("change", () => {
      state.sort = el.sort.value;
      applyFilters();
    });

    document.querySelectorAll(".seg__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".seg__btn").forEach((b) => b.classList.remove("is-on"));
        btn.classList.add("is-on");
        state.view = btn.dataset.view;
        el.list.dataset.view = state.view;
      });
    });

    el.months.addEventListener("click", (e) => {
      const btn = e.target.closest(".month-chip");
      if (!btn) return;
      state.month = btn.dataset.month;
      syncChipActive();
      applyFilters();
    });

    el.weekChips.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      state.week = state.week === btn.dataset.week ? null : btn.dataset.week;
      syncChipActive();
      applyFilters();
    });

    el.pressChips.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      state.press = state.press === btn.dataset.press ? null : btn.dataset.press;
      syncChipActive();
      applyFilters();
    });

    el.tagChips.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      state.tag = state.tag === btn.dataset.tag ? null : btn.dataset.tag;
      syncChipActive();
      applyFilters();
    });

    el.rail.addEventListener("click", (e) => {
      const clear = e.target.closest("[data-clear]");
      if (!clear) return;
      clearFilter(clear.dataset.clear);
    });

    el.activeFilters.addEventListener("click", (e) => {
      const clear = e.target.closest("[data-clear]");
      if (!clear) return;
      clearFilter(clear.dataset.clear);
    });

    const setRail = (open) => {
      el.rail.classList.toggle("is-open", open);
      document.body.classList.toggle("rail-open", open);
      el.filterToggle.setAttribute("aria-expanded", String(open));
    };

    el.filterToggle.addEventListener("click", () => {
      setRail(!el.rail.classList.contains("is-open"));
    });

    document.addEventListener("click", (e) => {
      if (!el.rail.classList.contains("is-open")) return;
      if (el.rail.contains(e.target) || el.filterToggle.contains(e.target)) return;
      setRail(false);
    });

    el.toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

    window.addEventListener(
      "scroll",
      () => {
        el.toTop.hidden = window.scrollY < 600;
      },
      { passive: true }
    );

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          if (state.shown < state.filtered.length) loadMore();
        }
      },
      { rootMargin: "600px 0px" }
    );
    io.observe(el.sentinel);
  }

  async function boot() {
    try {
      const data = await fetchWithProgress("data/news.json");
      state.data = data;
      setProgress(96, "필터 · 피드 준비…");
      renderKpi();
      renderMonths();
      renderChips();
      bind();
      applyFilters();
      setProgress(100, "완료");
      requestAnimationFrame(() => {
        el.boot.classList.add("is-done");
        el.boot.setAttribute("aria-busy", "false");
      });
    } catch (err) {
      console.error(err);
      setProgress(100, "불러오기 실패");
      el.bootMsg.textContent = "데이터를 불러오지 못했습니다. 로컬 서버로 index.html을 열어 주세요.";
    }
  }

  boot();
})();
