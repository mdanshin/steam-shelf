#!/usr/bin/env python
"""Exhaustively synchronize high-value Steam Specials for the RU storefront."""

from __future__ import annotations

import html
import json
import os
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
MIN_DETAIL_COVERAGE_PERCENT = 50
PAGINATION_TOLERANCE_PERCENT = 90
QUERY_URL = "https://api.steampowered.com/IStoreQueryService/Query/v1/"
CATALOG_PAGE_SIZE = 1000
PRICE_BATCH = 200
# Measured against live Steam: one worker sustains 6.7 requests per second and
# four sustain 47.6, with no rejections at any level. Eight was no better than
# four, so four is the knee of the curve.
PRICE_WORKERS = 4
# Batches in flight at once, so only a bounded slice of raw store items is held.
PRICE_WINDOW = 40
REVIEW_URL = "https://store.steampowered.com/appreviews"
# Steam's own wording: 6 is "mostly positive", 5 "mixed", 4 and below negative.
MIN_REVIEW_PERCENT = 70
MIN_REVIEW_COUNT = 50
WATCHLIST = ROOT / "data" / "free-to-keep-watchlist.json"


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
        # Price strings are informational only: a 100% discount renders "Бесплатно"
        # instead of a price block, and dropping such rows would hide the best deals.
        if not all((appid, item_key, title, discount, href)):
            continue
        parsed.append({
            "appid": int(appid.group(1)),
            "itemKey": html.unescape(item_key.group(1)),
            "name": text(title.group(1)),
            "discountPercent": int(discount.group(1)),
            "roughOriginalMinor": rubles_minor(text(original.group(1))) if original else None,
            "roughPriceMinor": rubles_minor(text(final.group(1))) if final else None,
            "reviewPercent": review_percent,
            "reviewCount": review_count,
            "url": html.unescape(href.group(1)).split("?", 1)[0],
        })
    return parsed



def review_summary(appid: int) -> tuple[int, dict]:
    """Positive share and review count for one app.

    The Specials rows carry this for the few thousand apps the search lists, but
    the catalogue sweep finds thousands more that never appear there, so ratings
    are read from Steam's review endpoint for everything that gets published.
    """
    url = f"{REVIEW_URL}/{appid}?json=1&language=all&purchase_type=all&num_per_page=0"
    try:
        summary = fetch_json(url).get("query_summary", {})
    except Exception:
        return appid, {}
    total = int(summary.get("total_reviews") or 0)
    positive = int(summary.get("total_positive") or 0)
    if total <= 0:
        return appid, {}
    return appid, {
        "reviewPercent": round(positive * 100 / total),
        "reviewCount": total,
        "reviewScore": int(summary.get("review_score") or 0),
        "reviewScoreDesc": str(summary.get("review_score_desc") or ""),
    }


def weak_game(percent: int | None, count: int | None) -> bool:
    """Whether an entry is the filler the rating filter is meant to hide.

    Unrated entries are not called weak: absence of reviews is not evidence of
    a bad game, and hiding them by default would bury brand new releases.
    """
    if percent is None or count is None:
        return False
    return percent < MIN_REVIEW_PERCENT or count < MIN_REVIEW_COUNT


def quality_pass(percent: int | None, count: int | None) -> bool:
    return bool(percent is not None and count is not None and (
        (percent >= 90 and count >= 10_000) or (percent >= 85 and count >= 20_000)
    ))


def browse_items(appids: list[int], *, detailed: bool = True) -> list[dict]:
    """Store items for these appids.

    Assets and tags multiply the response size, and are only needed for entries
    that will actually be published, so the catalogue sweep asks for prices alone.
    """
    data_request = {"include_all_purchase_options": True}
    if detailed:
        data_request.update({"include_assets": True, "include_tag_count": 20})
    payload = {
        "ids": [{"appid": appid} for appid in appids],
        "context": {"language": "russian", "country_code": "RU"},
        "data_request": data_request,
    }
    params = urllib.parse.urlencode({"input_json": json.dumps(payload, separators=(",", ":"))})
    return fetch_json(f"{BROWSE_URL}?{params}").get("response", {}).get("store_items", [])


def price_only(appids: list[int]) -> list[dict]:
    return browse_items(appids, detailed=False)


def is_publishable(item: dict) -> bool:
    return bool(
        int(item.get("appid") or 0) > 0
        and item.get("type") == 0
        and item.get("visible")
        and option_prices(item.get("best_purchase_option") or {})
    )


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


def attach_covers(deals: list[dict], *, download: bool = True) -> None:
    if not download:
        for game in deals:
            game.pop("_coverUrl", None)
            game["cover"] = False
        return

    def download_deal_cover(game: dict) -> tuple[int, bool]:
        return game["appid"], save_cover(game.pop("_coverUrl"), game["appid"])

    with ThreadPoolExecutor(max_workers=12) as pool:
        cover_results = dict(pool.map(download_deal_cover, deals))
    for game in deals:
        game["cover"] = cover_results.get(game["appid"], False)


def option_prices(option: dict) -> tuple[int, int, int] | None:
    """Read a discounted price, tolerating Steam's omission of zero-valued fields.

    Steam serializes store items from protobuf, which drops integer fields that equal
    zero. A 100% discount therefore arrives with no final_price_in_cents at all, and
    reading that key directly would silently discard every free-to-keep promotion.
    """
    try:
        original = int(option["original_price_in_cents"])
        current = int(option.get("final_price_in_cents") or 0)
        discount_percent = int(option.get("discount_pct") or 0)
    except (KeyError, TypeError, ValueError):
        return None
    if original <= 0 or current < 0 or discount_percent <= 0 or current >= original:
        return None
    return current, original, discount_percent


def validate_offer_volume(scraped: int) -> None:
    """Fail closed when the Specials scrape itself came back implausibly short."""
    if scraped < MIN_DEALS_ITEMS:
        raise RuntimeError(
            f"Steam offers catalog is too small: received {scraped}, required at least {MIN_DEALS_ITEMS}"
        )


def validate_detail_coverage(detailed: int, requested: int) -> None:
    """Fail closed when the store detail lookup answered for too few of the scraped apps.

    This compares like with like: every appid passed to the browse service came from
    Steam's own Specials listing, so the response should cover nearly all of them and
    a collapse here means the detail API broke rather than that the sale ended.
    """
    minimum = requested * MIN_DETAIL_COVERAGE_PERCENT // 100
    if detailed < minimum:
        raise RuntimeError(
            f"Steam store detail catalog is too small: received {detailed} "
            f"of {requested} requested apps, required at least {minimum}"
        )


def validate_published_volume(normalized: int) -> None:
    """Fail closed on a catastrophic collapse of the final catalog.

    Only an absolute floor is applied. A share-of-scrape floor cannot be used here:
    the Specials listing carries free-to-play entries, bundles and editions that
    never normalize into a discounted game, so the ratio tracks Steam's promotion mix
    rather than this pipeline's health. A snapshot-relative floor is worse still,
    because the workflow never commits generated data back and would freeze the site
    at whatever was last published.
    """
    if normalized < MIN_DEALS_ITEMS:
        raise RuntimeError(
            f"Steam normalized deals catalog is too small: received {normalized}, "
            f"required at least {MIN_DEALS_ITEMS}"
        )


def enumerate_catalog_appids() -> list[int]:
    """Every appid Steam's store knows about.

    The Specials listing hides free-to-keep giveaways entirely, and no search
    filter reaches them, so the only way to find one without being told its appid
    is to price the whole catalogue.
    """
    appids: set[int] = set()
    total: int | None = None
    start = 0
    while total is None or start < total:
        payload = {
            "query": {"filters": {}, "start": start, "count": CATALOG_PAGE_SIZE},
            "context": {"language": "russian", "country_code": "RU"},
            "data_request": {},
        }
        params = urllib.parse.urlencode({"input_json": json.dumps(payload, separators=(",", ":"))})
        response = fetch_json(f"{QUERY_URL}?{params}").get("response", {})
        ids = [int(entry.get("appid") or 0) for entry in response.get("ids", [])]
        reported = int((response.get("metadata") or {}).get("total_matching_records") or 0)
        if not ids or reported <= 0:
            break
        total = max(total or 0, reported)
        appids.update(appid for appid in ids if appid > 0)
        start += CATALOG_PAGE_SIZE
        time.sleep(0.2)
    return sorted(appids)


def pagination_may_stop(start: int, collected: int, total_count: int) -> bool:
    """Whether an empty results page means the listing ended rather than broke.

    Steam reports total_count as a live estimate. A full scrape takes minutes, and
    offers expire during it, so the final page routinely comes back empty a few
    entries short of the reported total.
    """
    return start + PAGE_SIZE >= total_count or collected * 100 >= total_count * PAGINATION_TOLERANCE_PERCENT


def full_sweep_enabled() -> bool:
    return os.environ.get("STEAM_DEALS_SKIP_FULL_SWEEP") != "1"


def watchlist_appids() -> set[int]:
    """Appids to read directly from the store, regardless of the Specials scrape."""
    if not WATCHLIST.exists():
        return set()
    entries = json.loads(WATCHLIST.read_text(encoding="utf-8")).get("appids", [])
    return {int(entry) for entry in entries if str(entry).isdigit()}


def normalize_store_item(item: dict, offer: dict | None, genre_tags: dict[int, str]) -> dict | None:
    """Turn one store item into a published deal, or None when it is not one.

    `offer` carries review counts scraped from the search row and is absent for
    watchlist entries, which never appear in search results.
    """
    appid = int(item.get("appid") or 0)
    option = item.get("best_purchase_option") or {}
    prices = option_prices(option)
    if prices is None or appid <= 0 or item.get("type") != 0 or not item.get("visible"):
        return None
    current, original, discount_percent = prices
    savings = original - current
    high_value = discount_percent >= MIN_DISCOUNT and savings >= MIN_SAVINGS and original >= MIN_ORIGINAL
    review_percent = offer["reviewPercent"] if offer else None
    review_count = offer["reviewCount"] if offer else None
    end_dates = [
        int(active["discount_end_date"])
        for active in option.get("active_discounts", [])
        if str(active.get("discount_end_date", "")).isdigit()
    ]
    # A free-to-keep promotion carries its deadline here instead.
    if str(option.get("free_to_keep_ends", "")).isdigit():
        end_dates.append(int(option["free_to_keep_ends"]))
    return {
        "appid": appid,
        "name": item.get("name") or (offer["name"] if offer else f"Steam App {appid}"),
        "url": f"https://store.steampowered.com/app/{appid}/",
        "priceMinor": current,
        "originalPriceMinor": original,
        "savingsMinor": savings,
        "discountPercent": discount_percent,
        "currency": "RUB",
        "reviewPercent": review_percent,
        "reviewCount": review_count,
        "genres": [
            genre_tags[int(tag["tagid"])]
            for tag in item.get("tags", [])
            if str(tag.get("tagid", "")).isdigit() and int(tag["tagid"]) in genre_tags
        ],
        "highValueMatch": high_value,
        "qualityMatch": high_value and quality_pass(review_percent, review_count),
        "discountEndAt": min(end_dates) if end_dates else None,
        "_coverUrl": item_cover_url(item),
    }


def main() -> None:
    all_offers: dict[str, dict] = {}
    total_count: int | None = None
    pages = 0
    start = 0
    exhausted = False
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
            # total_count is a live estimate and the catalogue shifts while a full
            # scrape runs for several minutes, so the last page can come back empty
            # a few entries short. Only an empty page well before the end means the
            # scrape actually broke.
            if pagination_may_stop(start, len(all_offers), total_count):
                exhausted = True
                break
            raise RuntimeError(f"Steam pagination ended early at {start}/{total_count}")
        for row in rows:
            all_offers[row["itemKey"]] = row
        pages += 1
        start += PAGE_SIZE
        time.sleep(0.75)

    if not exhausted and start < total_count:
        raise RuntimeError(f"Steam pagination incomplete: {start}/{total_count}")

    offers_by_appid = {}
    for offer in all_offers.values():
        offers_by_appid.setdefault(offer["appid"], offer)

    validate_offer_volume(len(offers_by_appid))

    genre_tags = official_genre_tags()
    catalog_appids = enumerate_catalog_appids() if full_sweep_enabled() else []
    appids = sorted(set(offers_by_appid) | set(catalog_appids))

    # Two passes. The first prices the whole catalogue and keeps only appids, so
    # neither transfer nor JSON parsing carries assets and tags for two hundred
    # thousand apps. The second asks for full detail on the few thousand that
    # will actually be published. Both run in parallel, in bounded windows, so
    # only a slice of raw store items is held at a time.
    discounted: list[int] = []
    detailed = 0
    with ThreadPoolExecutor(max_workers=PRICE_WORKERS) as pool:
        batches = [appids[index:index + PRICE_BATCH] for index in range(0, len(appids), PRICE_BATCH)]
        for window in range(0, len(batches), PRICE_WINDOW):
            for items in pool.map(price_only, batches[window:window + PRICE_WINDOW]):
                for item in items:
                    detailed += 1
                    if is_publishable(item):
                        discounted.append(int(item["appid"]))

        validate_detail_coverage(detailed, len(appids))

        deals = []
        seen_appids: set[int] = set()
        detail_batches = [discounted[index:index + PRICE_BATCH]
                          for index in range(0, len(discounted), PRICE_BATCH)]
        for window in range(0, len(detail_batches), PRICE_WINDOW):
            for items in pool.map(browse_items, detail_batches[window:window + PRICE_WINDOW]):
                for item in items:
                    appid = int(item.get("appid") or 0)
                    if appid in seen_appids:
                        continue
                    game = normalize_store_item(item, offers_by_appid.get(appid), genre_tags)
                    if game:
                        deals.append(game)
                        seen_appids.add(game["appid"])

    validate_published_volume(len(deals))

    # Ratings for everything that ships, so the site can filter on them.
    with ThreadPoolExecutor(max_workers=PRICE_WORKERS) as pool:
        ratings = dict(pool.map(review_summary, [game["appid"] for game in deals]))
    for game in deals:
        rating = ratings.get(game["appid"]) or {}
        if rating:
            game.update(rating)
        game.setdefault("reviewScore", 0)
        game.setdefault("reviewScoreDesc", "")
        game["weak"] = weak_game(game.get("reviewPercent"), game.get("reviewCount"))
        game["qualityMatch"] = game["highValueMatch"] and quality_pass(
            game.get("reviewPercent"), game.get("reviewCount"))

    # Steam's Specials listing never carries free-to-keep giveaways: they top out
    # at 95% off there. The store item itself reports them correctly, so watched
    # appids are read directly and merged in when they are currently discounted.
    watchlist_deals = []
    for appid in watchlist_appids() - seen_appids:
        for item in browse_items([appid]):
            game = normalize_store_item(item, None, genre_tags)
            if game:
                watchlist_deals.append(game)
        time.sleep(0.4)
    deals.extend(watchlist_deals)

    high_value_candidates = sum(game["highValueMatch"] for game in deals)
    quality_candidates = sum(game["qualityMatch"] for game in deals)

    download_covers = os.environ.get("STEAM_DEALS_SKIP_COVERS") != "1"
    attach_covers(deals, download=download_covers)

    deals.sort(key=lambda game: (-game["savingsMinor"], -game["discountPercent"], game["name"].casefold()))
    synced_at = datetime.now(timezone.utc).isoformat()
    audit = {
        "totalCount": total_count,
        "pages": pages,
        "uniqueOffers": len(all_offers),
        "uniqueApps": len(appids),
        "catalogApps": len(catalog_appids),
        "detailedApps": detailed,
        "discountedApps": len(discounted),
        "watchlistDeals": len(watchlist_deals),
        "ratedDeals": sum(game.get("reviewCount") is not None for game in deals),
        "weakDeals": sum(game.get("weak", False) for game in deals),
        "ratingThresholds": {"percent": MIN_REVIEW_PERCENT, "count": MIN_REVIEW_COUNT},
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
    if download_covers:
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
