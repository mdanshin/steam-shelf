#!/usr/bin/env python
"""Exhaustively synchronize high-value Steam Specials for the RU storefront."""

from __future__ import annotations

import html
import json
import re
import time
import urllib.parse
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "deals-data.js"
ASSETS = ROOT / "data" / "deal-covers"
SEARCH_URL = "https://store.steampowered.com/search/results/"
DETAIL_URL = "https://store.steampowered.com/api/appdetails"
BROWSE_URL = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/"
TAG_URL = "https://api.steampowered.com/IStoreService/GetTagList/v1/?language=russian"
PAGE_SIZE = 100
MIN_DISCOUNT = 70
MIN_SAVINGS = 100_000
MIN_ORIGINAL = 150_000
GENRE_NAMES = {
    "Стратегия", "Экшен", "Приключение", "Ролевая игра", "ММО", "Инди",
    "Казуальная игра", "Симулятор", "Гонки", "Спорт", "Платформер",
    "Метроидвания", "Головоломка", "Хоррор", "Файтинг", "Шутер",
}
HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept-Language": "ru-RU,ru;q=0.9",
    "Cookie": "birthtime=0; mature_content=1",
}
ALLOWED_HOSTS = {
    "store.steampowered.com",
    "api.steampowered.com",
    "shared.fastly.steamstatic.com",
}
MAX_RESPONSE_BYTES = 10 * 1024 * 1024
MIN_DEALS_ITEMS = 700
MIN_PUBLISHED_PERCENT = 90


def validate_url(url: str) -> None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS or parsed.username or parsed.password or parsed.port:
        raise ValueError(f"Steam URL is outside the HTTPS allowlist: {url}")


class ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Validate each redirect target before urllib sends the next request."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urljoin(req.full_url, newurl)
        validate_url(target)
        return super().redirect_request(req, fp, code, msg, headers, target)


OPENER = urllib.request.build_opener(ValidatingRedirectHandler())


def fetch(url: str, *, attempts: int = 6) -> bytes:
    validate_url(url)
    error: Exception | None = None
    for attempt in range(attempts):
        try:
            with OPENER.open(urllib.request.Request(url, headers=HEADERS), timeout=60) as response:
                validate_url(response.geturl())
                length = response.headers.get("Content-Length")
                if length and int(length) > MAX_RESPONSE_BYTES:
                    raise ValueError(f"Steam response is too large: {length} bytes")
                content = response.read(MAX_RESPONSE_BYTES + 1)
                if len(content) > MAX_RESPONSE_BYTES:
                    raise ValueError("Steam response exceeded the size limit")
                return content
        except urllib.error.HTTPError as exc:
            error = exc
            if attempt + 1 < attempts:
                retry_after = exc.headers.get("Retry-After")
                delay = int(retry_after) if retry_after and retry_after.isdigit() else min(60, 10 * (attempt + 1))
                time.sleep(delay if exc.code == 429 else 2**attempt)
        except Exception as exc:
            error = exc
            if attempt + 1 < attempts:
                time.sleep(2**attempt)
    raise RuntimeError(f"Steam request failed: {error}")


def fetch_json(url: str) -> dict:
    return json.loads(fetch(url).decode("utf-8-sig"))


def text(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def rubles_minor(value: str) -> int | None:
    cleaned = html.unescape(value).replace("\xa0", " ").lower()
    match = re.search(r"([0-9][0-9 ]*)(?:[,.]([0-9]{1,2}))?\s*(?:₽|руб)", cleaned)
    if not match:
        return None
    whole = int(match.group(1).replace(" ", ""))
    fraction = (match.group(2) or "0").ljust(2, "0")[:2]
    return whole * 100 + int(fraction)


def review_values(row: str) -> tuple[int | None, int | None]:
    match = re.search(r'data-tooltip-html="([^"]*)"', row)
    if not match:
        return None, None
    tooltip = html.unescape(match.group(1))
    percent = re.search(r"(\d{1,3})%", tooltip)
    count = re.search(r"([\d\s,.]+)\s+(?:обзор|reviews?)", tooltip, re.I)
    digits = re.sub(r"\D", "", count.group(1)) if count else ""
    return (int(percent.group(1)) if percent else None, int(digits) if digits else None)


def parse_rows(fragment: str) -> list[dict]:
    rows = re.findall(r'<a\b[^>]*class="[^"]*\bsearch_result_row\b[^"]*"[^>]*>[\s\S]*?</a>', fragment)
    parsed = []
    for row in rows:
        appid = re.search(r'data-ds-appid="(\d+)"', row)
        item_key = re.search(r'data-ds-itemkey="([^"]+)"', row)
        title = re.search(r'<span class="title">([\s\S]*?)</span>', row)
        discount = re.search(r'discount_pct[^>]*>\s*-?(\d+)%', row)
        original = re.search(r'discount_original_price[^>]*>([\s\S]*?)</', row)
        final = re.search(r'discount_final_price[^>]*>([\s\S]*?)</', row)
        href = re.search(r'href="([^"]+)"', row)
        review_percent, review_count = review_values(row)
        if not all((appid, item_key, title, discount, original, final, href)):
            continue
        parsed.append({
            "appid": int(appid.group(1)),
            "itemKey": html.unescape(item_key.group(1)),
            "name": text(title.group(1)),
            "discountPercent": int(discount.group(1)),
            "roughOriginalMinor": rubles_minor(text(original.group(1))),
            "roughPriceMinor": rubles_minor(text(final.group(1))),
            "reviewPercent": review_percent,
            "reviewCount": review_count,
            "url": html.unescape(href.group(1)).split("?", 1)[0],
        })
    return parsed



def quality_pass(percent: int | None, count: int | None) -> bool:
    return bool(percent is not None and count is not None and (
        (percent >= 90 and count >= 10_000) or (percent >= 85 and count >= 20_000)
    ))


def browse_items(appids: list[int]) -> list[dict]:
    payload = {
        "ids": [{"appid": appid} for appid in appids],
        "context": {"language": "russian", "country_code": "RU"},
        "data_request": {"include_assets": True, "include_all_purchase_options": True, "include_tag_count": 20},
    }
    params = urllib.parse.urlencode({"input_json": json.dumps(payload, separators=(",", ":"))})
    return fetch_json(f"{BROWSE_URL}?{params}").get("response", {}).get("store_items", [])


def item_cover_url(item: dict) -> str | None:
    assets = item.get("assets") or {}
    template = assets.get("asset_url_format")
    filename = assets.get("header") or assets.get("main_capsule")
    if not template or not filename:
        return None
    return "https://shared.fastly.steamstatic.com/store_item_assets/" + template.replace("${FILENAME}", filename)


def official_genre_tags() -> dict[int, str]:
    tags = fetch_json(TAG_URL).get("response", {}).get("tags", [])
    return {int(tag["tagid"]): tag["name"] for tag in tags if tag.get("name") in GENRE_NAMES}


def save_cover(url: str | None, appid: int) -> bool:
    ASSETS.mkdir(parents=True, exist_ok=True)
    target = ASSETS / f"{appid}.jpg"
    if target.exists() and target.stat().st_size >= 1_000:
        with target.open("rb") as image:
            if image.read(2) == b"\xff\xd8":
                return True
    if not url:
        return False
    try:
        data = fetch(url, attempts=3)
        if len(data) < 1_000 or not data.startswith(b"\xff\xd8"):
            return False
        temp = target.with_suffix(".tmp")
        temp.write_bytes(data)
        temp.replace(target)
        return True
    except Exception:
        return target.exists()


def published_deals_count() -> int:
    if not OUTPUT.exists():
        return 0
    return len(re.findall(r'^\s*"appid"\s*:', OUTPUT.read_text(encoding="utf-8"), re.M))


def validate_deals_completeness(current_count: int, previous_count: int, stage: str) -> None:
    minimum = max(MIN_DEALS_ITEMS, (previous_count * MIN_PUBLISHED_PERCENT + 99) // 100)
    if current_count < minimum:
        raise RuntimeError(
            f"Steam {stage} catalog is too small: received {current_count}, required at least {minimum}"
        )


def main() -> None:
    all_offers: dict[str, dict] = {}
    total_count: int | None = None
    pages = 0
    start = 0
    while total_count is None or start < total_count:
        params = urllib.parse.urlencode({
            "query": "", "start": start, "count": PAGE_SIZE, "dynamic_data": "",
            "sort_by": "_ASC", "specials": 1, "supportedlang": "russian",
            "cc": "ru", "ndl": 1, "infinite": 1,
        })
        payload = fetch_json(f"{SEARCH_URL}?{params}")
        reported = int(payload.get("total_count", 0))
        if reported <= 0:
            raise RuntimeError("Steam returned no total_count")
        total_count = max(total_count or 0, reported)
        rows = parse_rows(payload.get("results_html", ""))
        if not rows:
            raise RuntimeError(f"Steam pagination ended early at {start}/{total_count}")
        for row in rows:
            all_offers[row["itemKey"]] = row
        pages += 1
        start += PAGE_SIZE
        time.sleep(0.75)

    if start < total_count:
        raise RuntimeError(f"Steam pagination incomplete: {start}/{total_count}")

    offers_by_appid = {}
    for offer in all_offers.values():
        offers_by_appid.setdefault(offer["appid"], offer)

    previous_count = published_deals_count()
    validate_deals_completeness(len(offers_by_appid), previous_count, "offers")

    store_items = []
    appids = sorted(offers_by_appid)
    genre_tags = official_genre_tags()
    for offset in range(0, len(appids), 50):
        store_items.extend(browse_items(appids[offset:offset + 50]))
        time.sleep(0.4)

    deals = []
    high_value_candidates = 0
    quality_candidates = 0
    for item in store_items:
        appid = int(item.get("appid") or 0)
        offer = offers_by_appid.get(appid)
        option = item.get("best_purchase_option") or {}
        try:
            current = int(option["final_price_in_cents"])
            original = int(option["original_price_in_cents"])
            discount_percent = int(option["discount_pct"])
        except (KeyError, TypeError, ValueError):
            continue
        if not offer or item.get("type") != 0 or not item.get("visible") or discount_percent <= 0 or current >= original:
            continue
        savings = original - current
        high_value = discount_percent >= MIN_DISCOUNT and savings >= MIN_SAVINGS and original >= MIN_ORIGINAL
        quality_match = high_value and quality_pass(offer["reviewPercent"], offer["reviewCount"])
        genres = [
            genre_tags[int(tag["tagid"])]
            for tag in item.get("tags", [])
            if str(tag.get("tagid", "")).isdigit() and int(tag["tagid"]) in genre_tags
        ]
        high_value_candidates += int(high_value)
        quality_candidates += int(quality_match)
        end_dates = [
            int(active["discount_end_date"])
            for active in option.get("active_discounts", [])
            if str(active.get("discount_end_date", "")).isdigit()
        ]
        deals.append({
            "appid": appid,
            "name": item.get("name") or offer["name"],
            "url": f"https://store.steampowered.com/app/{appid}/",
            "priceMinor": current,
            "originalPriceMinor": original,
            "savingsMinor": savings,
            "discountPercent": discount_percent,
            "currency": "RUB",
            "reviewPercent": offer["reviewPercent"],
            "reviewCount": offer["reviewCount"],
            "genres": genres,
            "highValueMatch": high_value,
            "qualityMatch": quality_match,
            "discountEndAt": min(end_dates) if end_dates else None,
            "_coverUrl": item_cover_url(item),
        })

    validate_deals_completeness(len(deals), previous_count, "normalized deals")

    def download_deal_cover(game: dict) -> tuple[int, bool]:
        return game["appid"], save_cover(game.pop("_coverUrl"), game["appid"])

    with ThreadPoolExecutor(max_workers=12) as pool:
        cover_results = dict(pool.map(download_deal_cover, deals))
    for game in deals:
        game["cover"] = cover_results.get(game["appid"], False)

    deals.sort(key=lambda game: (-game["savingsMinor"], -game["discountPercent"], game["name"].casefold()))
    synced_at = datetime.now(timezone.utc).isoformat()
    audit = {
        "totalCount": total_count,
        "pages": pages,
        "uniqueOffers": len(all_offers),
        "uniqueApps": len(appids),
        "exactPriceCandidates": len(deals),
        "highValueCandidates": high_value_candidates,
        "qualityCandidates": quality_candidates,
        "displayedDeals": len(deals),
        "knownEndDates": sum(game["discountEndAt"] is not None for game in deals),
        "localCovers": sum(game["cover"] for game in deals),
        "thresholds": {"discountPercent": MIN_DISCOUNT, "savingsMinor": MIN_SAVINGS, "originalPriceMinor": MIN_ORIGINAL},
    }
    source = (
        "// Generated by scripts/sync_deals.py. Do not edit manually.\n"
        f"export const dealsSyncedAt = {json.dumps(synced_at)};\n"
        f"export const dealsAudit = {json.dumps(audit, ensure_ascii=False)};\n"
        f"export const dealsCatalog = {json.dumps(deals, ensure_ascii=False, indent=2)};\n"
    )
    temp = OUTPUT.with_suffix(".tmp")
    temp.write_text(source, encoding="utf-8")
    temp.replace(OUTPUT)
    active_covers = {f"{game['appid']}.jpg" for game in deals if game["cover"]}
    for cover in ASSETS.glob("*.jpg"):
        if cover.name not in active_covers:
            cover.unlink()
    print(
        f"Steam Specials: {total_count} заявлено; {pages} стр.; {len(all_offers)} уникальных; "
        f"{len(deals)} игр со скидкой; {high_value_candidates} особо выгодных; {quality_candidates} выбор алгоритма; {synced_at}"
    )


if __name__ == "__main__":
    main()
