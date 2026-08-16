/**
 * Google Doc (txt export) → dashboard data.
 * Mirrors scripts/parse_gdoc.py
 */
(function (global) {
  "use strict";

  const DOC_ID = "1A6jOSX1are2HW9llO255QCuO0s4sV0rLLoW1YIOB6Jc";
  const DOC_EDIT_URL = `https://docs.google.com/document/d/${DOC_ID}/edit`;
  const DOC_EXPORT_URL = `https://docs.google.com/document/d/${DOC_ID}/export?format=txt`;

  const PRESS = {
    "www.yna.co.kr": ["연합뉴스", "yna"],
    "www.nocutnews.co.kr": ["노컷뉴스", "nocut"],
    "www.chosun.com": ["조선일보", "chosun"],
    "www.jinhak.com": ["진학사", "jinhak"],
    "www.hankyung.com": ["한국경제", "hankyung"],
    "www.news1.kr": ["뉴스1", "news1"],
    "www.donga.com": ["동아일보", "donga"],
    "www.newsis.com": ["뉴시스", "newsis"],
    "v.daum.net": ["다음", "daum"],
    "www.joongang.co.kr": ["중앙일보", "joongang"],
    "www.kmib.co.kr": ["국민일보", "kmib"],
    "www.hankookilbo.com": ["한국일보", "hankook"],
    "www.hani.co.kr": ["한겨레", "hani"],
    "www.mk.co.kr": ["매일경제", "mk"],
    "youtu.be": ["유튜브", "youtube"],
    "www.sedaily.com": ["서울경제", "sedaily"],
    "www.seoul.co.kr": ["서울신문", "seoul"],
    "www.khan.co.kr": ["경향신문", "khan"],
    "www.mt.co.kr": ["머니투데이", "mt"],
    "www.edaily.co.kr": ["이데일리", "edaily"],
    "www.korea.kr": ["정책브리핑", "korea"],
    "www.fnnews.com": ["파이낸셜뉴스", "fn"],
    "www.etnews.com": ["전자신문", "et"],
    "youtube.com": ["유튜브", "youtube"],
    "www.youtube.com": ["유튜브", "youtube"],
    "www.moe.go.kr": ["교육부", "moe"],
    "www.veritas-a.com": ["베리타스알파", "veritas"],
    "www.edujin.co.kr": ["에듀진", "edujin"],
    "www.ytn.co.kr": ["YTN", "ytn"],
    "www.sbs.co.kr": ["SBS", "sbs"],
    "www.mbc.co.kr": ["MBC", "mbc"],
    "www.kbs.co.kr": ["KBS", "kbs"],
    "n.news.naver.com": ["네이버뉴스", "naver"],
    "news.naver.com": ["네이버뉴스", "naver"],
  };

  const WEEK_RE = /^진학 뉴스\s*\(([^)]+)\)\s*$/;
  const DATE_RE = /^(\d{6})\s+(.+?)\s*$/;
  const URL_RE = /^(https?:\/\/\S+)\s*$/;
  const TAGS_RE = /^(?:#[\w가-힣A-Za-z0-9_]+(?:\s+|$))+/;
  const AUTHOR_RE = /^대입뉴스\s+\S+/;
  const TAG_TOKEN_RE = /#[\w가-힣A-Za-z0-9_]+/g;

  function hostOf(url) {
    const m = String(url).match(/^https?:\/\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : "";
  }

  function parseYmd(ymd) {
    const y = 2000 + Number(ymd.slice(0, 2));
    const m = Number(ymd.slice(2, 4));
    const d = Number(ymd.slice(4, 6));
    return {
      iso: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      y,
      m,
      d,
    };
  }

  function countBy(arr, keyFn) {
    const map = new Map();
    for (const item of arr) {
      const k = keyFn(item);
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  }

  function parseDoc(raw) {
    const linesAll = raw.split(/\r?\n/);
    const weekIdx = [];
    for (let i = 0; i < linesAll.length; i++) {
      if (WEEK_RE.test(linesAll[i].trim())) weekIdx.push(i);
    }

    const articles = [];

    for (let wi = 0; wi < weekIdx.length; wi++) {
      const startLine = weekIdx[wi];
      const endLine = wi + 1 < weekIdx.length ? weekIdx[wi + 1] : linesAll.length;
      const weekRange = linesAll[startLine].trim().match(WEEK_RE)[1].trim();
      const lines = linesAll.slice(startLine + 1, endLine);

      let currentTags = [];
      let pendingTitles = [];
      let i = 0;

      while (i < lines.length) {
        const line = lines[i].trim();
        if (!line || line.startsWith("____") || AUTHOR_RE.test(line)) {
          i += 1;
          continue;
        }
        if (TAGS_RE.test(line) && !DATE_RE.test(line)) {
          currentTags = line.match(TAG_TOKEN_RE) || [];
          i += 1;
          continue;
        }
        const dm = line.match(DATE_RE);
        if (dm) {
          pendingTitles.push([dm[1], dm[2].trim()]);
          i += 1;
          continue;
        }
        const um = line.match(URL_RE);
        if (um && pendingTitles.length) {
          const url = um[1].replace(/\/$/, "");
          const host = hostOf(url);
          const press = PRESS[host] || [host.replace(/^www\./, "").split(".")[0] || host, "etc"];
          const [ymd, title] = pendingTitles[pendingTitles.length - 1];
          const { iso } = parseYmd(ymd);

          let j = i + 1;
          const summaryParts = [];
          while (j < lines.length) {
            const s = lines[j].trim();
            if (!s) {
              j += 1;
              continue;
            }
            if (
              DATE_RE.test(s) ||
              URL_RE.test(s) ||
              (TAGS_RE.test(s) && s.startsWith("#")) ||
              s.startsWith("____") ||
              AUTHOR_RE.test(s) ||
              s.startsWith("진학 뉴스")
            ) {
              break;
            }
            summaryParts.push(s);
            if (summaryParts.reduce((n, x) => n + x.length, 0) > 280) break;
            j += 1;
          }

          let summary = summaryParts.join(" ").replace(/\s+/g, " ").trim();
          if (summary.length > 220) summary = summary.slice(0, 217) + "…";

          articles.push({
            id: `${ymd}-${articles.length}`,
            date: iso,
            title,
            url,
            press: press[0],
            pressId: press[1],
            tags: currentTags.slice(),
            week: weekRange,
            summary,
          });
          pendingTitles = [];
          i = j;
          continue;
        }
        if (um) pendingTitles = [];
        i += 1;
      }
    }

    const pressMap = countBy(articles, (a) => a.press);
    const tagMap = new Map();
    for (const a of articles) {
      for (const t of a.tags) tagMap.set(t, (tagMap.get(t) || 0) + 1);
    }
    const weekSet = [...new Set(articles.map((a) => a.week))];
    const weekStats = weekSet
      .map((week) => ({ week, count: articles.filter((a) => a.week === week).length }))
      .sort((a, b) => (a.week < b.week ? 1 : -1));

    const monthMap = new Map();
    for (const a of articles) {
      const y = Number(a.date.slice(0, 4));
      const m = Number(a.date.slice(5, 7));
      if (!y || m < 1 || m > 12) continue;
      const key = `${y}-${String(m).padStart(2, "0")}`;
      monthMap.set(key, (monthMap.get(key) || 0) + 1);
    }
    const monthStats = [...monthMap.entries()]
      .map(([key, count]) => {
        const [y, m] = key.split("-").map(Number);
        return { year: y, month: m, label: `${y}.${String(m).padStart(2, "0")}`, count };
      })
      .sort((a, b) => b.year - a.year || b.month - a.month);

    const press = [...pressMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    const tags = [...tagMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 80);

    const fingerprint = [
      articles.length,
      articles[0]?.id || "",
      articles[0]?.title || "",
      articles[articles.length - 1]?.id || "",
      raw.length,
    ].join("|");

    return {
      meta: {
        title: "2026년 대입 뉴스",
        subtitle: "대입뉴스 오승열",
        source: DOC_EDIT_URL,
        updated: new Date().toISOString(),
        total: articles.length,
        weekCount: weekSet.length,
        pressCount: press.length,
        dateStart: articles.length ? articles[articles.length - 1].date : null,
        dateEnd: articles.length ? articles[0].date : null,
        fingerprint,
        live: true,
      },
      press,
      tags,
      weeks: weekStats,
      months: monthStats,
      articles,
    };
  }

  global.NewsDoc = {
    DOC_ID,
    DOC_EDIT_URL,
    DOC_EXPORT_URL,
    parseDoc,
  };
})(window);
