#!/usr/bin/env python3
"""Parse Google Doc export (txt) into data/news.json for the dashboard."""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

PRESS = {
    "www.yna.co.kr": ("연합뉴스", "yna"),
    "www.nocutnews.co.kr": ("노컷뉴스", "nocut"),
    "www.chosun.com": ("조선일보", "chosun"),
    "www.jinhak.com": ("진학사", "jinhak"),
    "www.hankyung.com": ("한국경제", "hankyung"),
    "www.news1.kr": ("뉴스1", "news1"),
    "www.donga.com": ("동아일보", "donga"),
    "www.newsis.com": ("뉴시스", "newsis"),
    "v.daum.net": ("다음", "daum"),
    "www.joongang.co.kr": ("중앙일보", "joongang"),
    "www.kmib.co.kr": ("국민일보", "kmib"),
    "www.hankookilbo.com": ("한국일보", "hankook"),
    "www.hani.co.kr": ("한겨레", "hani"),
    "www.mk.co.kr": ("매일경제", "mk"),
    "youtu.be": ("유튜브", "youtube"),
    "www.sedaily.com": ("서울경제", "sedaily"),
    "www.seoul.co.kr": ("서울신문", "seoul"),
    "www.khan.co.kr": ("경향신문", "khan"),
    "www.mt.co.kr": ("머니투데이", "mt"),
    "www.edaily.co.kr": ("이데일리", "edaily"),
    "www.korea.kr": ("정책브리핑", "korea"),
    "www.fnnews.com": ("파이낸셜뉴스", "fn"),
    "www.etnews.com": ("전자신문", "et"),
    "youtube.com": ("유튜브", "youtube"),
    "www.youtube.com": ("유튜브", "youtube"),
    "www.moe.go.kr": ("교육부", "moe"),
    "www.veritas-a.com": ("베리타스알파", "veritas"),
    "www.edujin.co.kr": ("에듀진", "edujin"),
    "www.ytn.co.kr": ("YTN", "ytn"),
    "www.sbs.co.kr": ("SBS", "sbs"),
    "www.mbc.co.kr": ("MBC", "mbc"),
    "www.kbs.co.kr": ("KBS", "kbs"),
    "n.news.naver.com": ("네이버뉴스", "naver"),
    "news.naver.com": ("네이버뉴스", "naver"),
}

WEEK_PAT = re.compile(r"^진학 뉴스\s*\(([^)]+)\)\s*$", re.M)
DATE_LINE = re.compile(r"^(?P<ymd>\d{6})\s+(?P<title>.+?)\s*$")
URL_LINE = re.compile(r"^(https?://\S+)\s*$")
TAGS_LINE = re.compile(r"^(?:#[\w가-힣A-Za-z0-9_]+(?:\s+|$))+")
AUTHOR_LINE = re.compile(r"^대입뉴스\s+\S+")


def parse_ymd(ymd: str) -> tuple[str, int, int, int]:
    y = 2000 + int(ymd[:2])
    m = int(ymd[2:4])
    d = int(ymd[4:6])
    return f"{y:04d}-{m:02d}-{d:02d}", y, m, d


def parse_doc(raw: str) -> dict:
    weeks = list(WEEK_PAT.finditer(raw))
    articles: list[dict] = []

    for wi, w in enumerate(weeks):
        start = w.end()
        end = weeks[wi + 1].start() if wi + 1 < len(weeks) else len(raw)
        block = raw[start:end]
        week_range = w.group(1).strip()
        lines = block.splitlines()

        current_tags: list[str] = []
        pending_titles: list[tuple[str, str]] = []
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            if not line or line.startswith("____") or AUTHOR_LINE.match(line):
                i += 1
                continue
            if TAGS_LINE.match(line) and not DATE_LINE.match(line):
                current_tags = re.findall(r"#[\w가-힣A-Za-z0-9_]+", line)
                i += 1
                continue
            m = DATE_LINE.match(line)
            if m:
                pending_titles.append((m.group("ymd"), m.group("title").strip()))
                i += 1
                continue
            um = URL_LINE.match(line)
            if um and pending_titles:
                url = um.group(1).rstrip("/")
                host = urlparse(url).netloc.lower()
                press_name, press_id = PRESS.get(
                    host, (host.replace("www.", "").split(".")[0], "etc")
                )
                ymd, title = pending_titles[-1]
                iso, y, mo, d = parse_ymd(ymd)

                j = i + 1
                summary_parts: list[str] = []
                while j < len(lines):
                    s = lines[j].strip()
                    if not s:
                        j += 1
                        continue
                    if (
                        DATE_LINE.match(s)
                        or URL_LINE.match(s)
                        or (TAGS_LINE.match(s) and s.startswith("#"))
                        or s.startswith("____")
                        or AUTHOR_LINE.match(s)
                        or s.startswith("진학 뉴스")
                    ):
                        break
                    summary_parts.append(s)
                    if sum(len(x) for x in summary_parts) > 280:
                        break
                    j += 1

                summary = re.sub(r"\s+", " ", " ".join(summary_parts)).strip()
                if len(summary) > 220:
                    summary = summary[:217] + "…"

                articles.append(
                    {
                        "id": f"{ymd}-{len(articles)}",
                        "date": iso,
                        "title": title,
                        "url": url,
                        "press": press_name,
                        "pressId": press_id,
                        "tags": current_tags[:],
                        "week": week_range,
                        "summary": summary,
                    }
                )
                pending_titles = []
                i = j
                continue
            if um:
                pending_titles = []
            i += 1

    press_stats = Counter(a["press"] for a in articles)
    tag_stats = Counter(t for a in articles for t in a["tags"])
    week_stats = [
        {"week": week, "count": sum(1 for a in articles if a["week"] == week)}
        for week in sorted({a["week"] for a in articles}, reverse=True)
    ]
    month_keys = sorted(
        {(int(a["date"][:4]), int(a["date"][5:7])) for a in articles}, reverse=True
    )
    month_stats = [
        {
            "year": y,
            "month": m,
            "label": f"{y}.{m:02d}",
            "count": sum(
                1
                for a in articles
                if int(a["date"][:4]) == y and int(a["date"][5:7]) == m
            ),
        }
        for y, m in month_keys
    ]

    return {
        "meta": {
            "title": "2026년 대입 뉴스",
            "subtitle": "대입뉴스 오승열",
            "source": "https://docs.google.com/document/d/1A6jOSX1are2HW9llO255QCuO0s4sV0rLLoW1YIOB6Jc",
            "updated": __import__("datetime").date.today().isoformat(),
            "total": len(articles),
            "weekCount": len({a["week"] for a in articles}),
            "pressCount": len(press_stats),
            "dateStart": articles[-1]["date"] if articles else None,
            "dateEnd": articles[0]["date"] if articles else None,
        },
        "press": [{"name": k, "count": v} for k, v in press_stats.most_common()],
        "tags": [{"name": k, "count": v} for k, v in tag_stats.most_common(80)],
        "weeks": week_stats,
        "months": month_stats,
        "articles": articles,
    }


DOC_ID = "1A6jOSX1are2HW9llO255QCuO0s4sV0rLLoW1YIOB6Jc"
DOC_EXPORT_URL = f"https://docs.google.com/document/d/{DOC_ID}/export?format=txt"


def download_doc(url: str = DOC_EXPORT_URL) -> str:
    import urllib.request

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "osy-news-sync/1.0"},
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read().decode("utf-8-sig")


def main() -> None:
    ap = argparse.ArgumentParser(description="Sync Google Doc → data/news.json")
    ap.add_argument(
        "input",
        nargs="?",
        type=Path,
        help="Optional local .txt export. Omit to download from Google Doc.",
    )
    ap.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("data/news.json"),
        help="Output JSON path",
    )
    ap.add_argument(
        "--url",
        default=DOC_EXPORT_URL,
        help="Google Doc export URL",
    )
    args = ap.parse_args()
    if args.input:
        raw = args.input.read_text(encoding="utf-8-sig")
    else:
        print(f"Downloading {args.url}")
        raw = download_doc(args.url)
    data = parse_doc(raw)
    data["meta"]["fingerprint"] = "|".join(
        [
            str(data["meta"]["total"]),
            data["articles"][0]["id"] if data["articles"] else "",
            data["articles"][0]["title"] if data["articles"] else "",
            data["articles"][-1]["id"] if data["articles"] else "",
            str(len(raw)),
        ]
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"Wrote {data['meta']['total']} articles → {args.output}")


if __name__ == "__main__":
    main()
