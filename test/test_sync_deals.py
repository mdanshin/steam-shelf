import importlib.util
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from urllib.request import Request


SCRIPT = Path(__file__).parents[1] / "scripts" / "sync_deals.py"
SPEC = importlib.util.spec_from_file_location("sync_deals", SCRIPT)
sync_deals = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(sync_deals)


class RedirectValidationTests(unittest.TestCase):
    def test_redirect_rejects_non_steam_target_before_request(self):
        handler = sync_deals.ValidatingRedirectHandler()
        request = Request("https://store.steampowered.com/search/")
        with self.assertRaisesRegex(ValueError, "outside the HTTPS allowlist"):
            handler.redirect_request(request, None, 302, "Found", {}, "http://127.0.0.1/private")

    def test_fetch_uses_validating_opener(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = "https://store.steampowered.com/search/"
        response.headers.get.return_value = None
        response.read.return_value = b"ok"
        with mock.patch.object(sync_deals.OPENER, "open", return_value=response) as opened, \
                mock.patch.object(sync_deals.urllib.request, "urlopen", side_effect=AssertionError("unsafe opener")):
            self.assertEqual(sync_deals.fetch("https://store.steampowered.com/search/", attempts=1), b"ok")
        opened.assert_called_once()


class PriceNormalizationTests(unittest.TestCase):
    def test_full_discount_survives_steam_omitting_the_zero_final_price(self):
        self.assertEqual(
            sync_deals.option_prices({"original_price_in_cents": 49900, "discount_pct": 100}),
            (0, 49900, 100),
        )
        self.assertEqual(
            sync_deals.option_prices({
                "original_price_in_cents": 49900, "final_price_in_cents": 0, "discount_pct": 100,
            }),
            (0, 49900, 100),
        )

    def test_partial_discounts_and_non_offers_keep_their_previous_meaning(self):
        self.assertEqual(
            sync_deals.option_prices({
                "original_price_in_cents": 100000, "final_price_in_cents": 25000, "discount_pct": 75,
            }),
            (25000, 100000, 75),
        )
        self.assertIsNone(sync_deals.option_prices({}))
        self.assertIsNone(sync_deals.option_prices({"original_price_in_cents": 49900}))
        self.assertIsNone(sync_deals.option_prices({"original_price_in_cents": 0, "discount_pct": 100}))
        self.assertIsNone(sync_deals.option_prices({
            "original_price_in_cents": 49900, "final_price_in_cents": 49900, "discount_pct": 0,
        }))
        self.assertIsNone(sync_deals.option_prices({
            "original_price_in_cents": 49900, "final_price_in_cents": "many", "discount_pct": 50,
        }))


class SearchRowTests(unittest.TestCase):
    def test_free_promotion_row_is_kept_without_a_parsable_price_block(self):
        row = (
            '<a href="https://store.steampowered.com/app/447700/Crystal_Crisis/?snr=1" '
            'class="search_result_row ds_collapse_flag" '
            'data-ds-appid="447700" data-ds-itemkey="App_447700" '
            'data-tooltip-html="Очень положительные&lt;br&gt;91% из 1 200 обзоров">'
            '<span class="title">Crystal Crisis</span>'
            '<div class="discount_pct">-100%</div>'
            '<div class="discount_final_price free">Бесплатно</div>'
            '</a>'
        )
        parsed = sync_deals.parse_rows(row)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["appid"], 447700)
        self.assertEqual(parsed[0]["discountPercent"], 100)
        self.assertIsNone(parsed[0]["roughOriginalMinor"])
        self.assertEqual(parsed[0]["reviewPercent"], 91)


class PaginationTests(unittest.TestCase):
    def test_short_final_page_is_the_end_not_a_break(self):
        # The real failure: Steam reported 9604 offers and served 9600.
        self.assertTrue(sync_deals.pagination_may_stop(9600, 9600, 9604))
        # An empty page a long way from the end is a broken scrape.
        self.assertFalse(sync_deals.pagination_may_stop(3000, 3000, 9604))
        # So is one that is short by far more than a page, unless most of the
        # catalogue was already collected.
        self.assertFalse(sync_deals.pagination_may_stop(5000, 5000, 9604))
        self.assertTrue(sync_deals.pagination_may_stop(8700, 8700, 9604))

    def test_scrape_completes_when_the_last_page_comes_back_empty(self):
        rows = [{"appid": index, "itemKey": f"App_{index}", "name": f"Game {index}",
                 "discountPercent": 50, "roughOriginalMinor": None, "roughPriceMinor": None,
                 "reviewPercent": 90, "reviewCount": 20000, "url": "u"} for index in range(1, 101)]
        def browse(appids):
            return [{"appid": appid, "name": f"Game {appid}", "type": 0, "visible": True, "tags": [],
                     "best_purchase_option": {"original_price_in_cents": 20000,
                                              "final_price_in_cents": 10000, "discount_pct": 50}}
                    for appid in appids]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "deals-data.js"
            watchlist = Path(directory) / "watchlist.json"
            watchlist.write_text('{"appids": []}', encoding="utf-8")
            with mock.patch.object(sync_deals, "OUTPUT", output), \
                    mock.patch.object(sync_deals, "WATCHLIST", watchlist), \
                    mock.patch.object(sync_deals, "MIN_DEALS_ITEMS", 1), \
                    mock.patch.object(sync_deals, "fetch_json", return_value={"total_count": 104, "results_html": "x"}), \
                    mock.patch.object(sync_deals, "parse_rows", side_effect=[rows, []]), \
                    mock.patch.object(sync_deals, "official_genre_tags", return_value={}), \
                    mock.patch.object(sync_deals, "browse_items", side_effect=browse), \
                    mock.patch.dict(sync_deals.os.environ, {"STEAM_DEALS_SKIP_COVERS": "1"}), \
                    mock.patch.object(sync_deals.time, "sleep"):
                sync_deals.main()
            self.assertIn('"appid": 1', output.read_text(encoding="utf-8"))

    def test_empty_page_far_from_the_end_still_fails_closed(self):
        rows = [{"appid": index, "itemKey": f"App_{index}", "name": f"Game {index}",
                 "discountPercent": 50, "roughOriginalMinor": None, "roughPriceMinor": None,
                 "reviewPercent": 90, "reviewCount": 20000, "url": "u"} for index in range(1, 101)]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "deals-data.js"
            output.write_text("last-known-good", encoding="utf-8")
            with mock.patch.object(sync_deals, "OUTPUT", output), \
                    mock.patch.object(sync_deals, "fetch_json", return_value={"total_count": 5000, "results_html": "x"}), \
                    mock.patch.object(sync_deals, "parse_rows", side_effect=[rows, []]), \
                    mock.patch.object(sync_deals, "browse_items") as browse, \
                    mock.patch.object(sync_deals.time, "sleep"):
                with self.assertRaisesRegex(RuntimeError, "pagination ended early"):
                    sync_deals.main()
            browse.assert_not_called()
            self.assertEqual(output.read_text(encoding="utf-8"), "last-known-good")


class FullSweepTests(unittest.TestCase):
    def test_catalog_enumeration_paginates_and_dedupes(self):
        pages = [
            {"response": {"ids": [{"appid": 1}, {"appid": 2}], "metadata": {"total_matching_records": 3}}},
            {"response": {"ids": [{"appid": 2}, {"appid": 3}], "metadata": {"total_matching_records": 3}}},
            {"response": {"ids": [], "metadata": {"total_matching_records": 3}}},
        ]
        with mock.patch.object(sync_deals, "CATALOG_PAGE_SIZE", 2), \
                mock.patch.object(sync_deals, "fetch_json", side_effect=pages), \
                mock.patch.object(sync_deals.time, "sleep"):
            self.assertEqual(sync_deals.enumerate_catalog_appids(), [1, 2, 3])

    def test_enumeration_stops_on_an_empty_or_unreported_page(self):
        with mock.patch.object(sync_deals, "fetch_json", return_value={"response": {}}), \
                mock.patch.object(sync_deals.time, "sleep"):
            self.assertEqual(sync_deals.enumerate_catalog_appids(), [])

    def test_full_sweep_can_be_switched_off(self):
        with mock.patch.dict(sync_deals.os.environ, {"STEAM_DEALS_SKIP_FULL_SWEEP": "1"}):
            self.assertFalse(sync_deals.full_sweep_enabled())
        with mock.patch.dict(sync_deals.os.environ, {}, clear=True):
            self.assertTrue(sync_deals.full_sweep_enabled())

    def test_giveaway_absent_from_specials_is_found_without_a_watchlist(self):
        """The whole point: a 100% offer nobody told the pipeline about."""
        specials_rows = [{"appid": 10, "itemKey": "App_10", "name": "Other", "discountPercent": 50,
                          "roughOriginalMinor": None, "roughPriceMinor": None,
                          "reviewPercent": 90, "reviewCount": 20000, "url": "u"}]
        priced = {
            10: {"appid": 10, "name": "Other", "type": 0, "visible": True, "tags": [],
                 "best_purchase_option": {"original_price_in_cents": 20000,
                                          "final_price_in_cents": 10000, "discount_pct": 50}},
            999: {"appid": 999, "name": "Surprise Giveaway", "type": 0, "visible": True, "tags": [],
                  "best_purchase_option": {"original_price_in_cents": 99900, "final_price_in_cents": "0",
                                           "discount_pct": 100, "is_free_to_keep": True,
                                           "free_to_keep_ends": 1790000000}},
            777: {"appid": 777, "name": "Full Price", "type": 0, "visible": True, "tags": [],
                  "best_purchase_option": {"original_price_in_cents": 50000,
                                           "final_price_in_cents": 50000, "discount_pct": 0}},
        }

        def fetch_json(url):
            if "IStoreQueryService" in url:
                return {"response": {"ids": [{"appid": 10}, {"appid": 999}, {"appid": 777}],
                                     "metadata": {"total_matching_records": 3}}}
            return {"total_count": 1, "results_html": "x"}

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "deals-data.js"
            watchlist = Path(directory) / "watchlist.json"
            watchlist.write_text('{"appids": []}', encoding="utf-8")
            with mock.patch.object(sync_deals, "OUTPUT", output), \
                    mock.patch.object(sync_deals, "WATCHLIST", watchlist), \
                    mock.patch.object(sync_deals, "MIN_DEALS_ITEMS", 1), \
                    mock.patch.object(sync_deals, "fetch_json", side_effect=fetch_json), \
                    mock.patch.object(sync_deals, "parse_rows", return_value=specials_rows), \
                    mock.patch.object(sync_deals, "official_genre_tags", return_value={}), \
                    mock.patch.object(sync_deals, "browse_items",
                                      side_effect=lambda ids: [priced[i] for i in ids if i in priced]), \
                    mock.patch.dict(sync_deals.os.environ, {"STEAM_DEALS_SKIP_COVERS": "1"}), \
                    mock.patch.object(sync_deals.time, "sleep"):
                sync_deals.main()
            published = output.read_text(encoding="utf-8")

        # Found purely by sweeping the catalogue, with no watchlist entry.
        self.assertIn('"appid": 999', published)
        self.assertIn('"discountPercent": 100', published)
        self.assertIn('"catalogApps": 3', published)
        # The ordinary discount is still there, the undiscounted app is not.
        self.assertIn('"appid": 10', published)
        self.assertNotIn('"appid": 777', published)


class ParallelPricingTests(unittest.TestCase):
    def test_every_appid_is_priced_exactly_once_across_workers(self):
        rows = [{"appid": index, "itemKey": f"App_{index}", "name": f"Game {index}",
                 "discountPercent": 50, "roughOriginalMinor": None, "roughPriceMinor": None,
                 "reviewPercent": 90, "reviewCount": 20000, "url": "u"} for index in range(1, 101)]
        requested = []
        lock = threading.Lock()

        def browse(appids):
            with lock:
                requested.extend(appids)
            return [{"appid": appid, "name": f"Game {appid}", "type": 0, "visible": True, "tags": [],
                     "best_purchase_option": {"original_price_in_cents": 20000,
                                              "final_price_in_cents": 10000, "discount_pct": 50}}
                    for appid in appids]

        def fetch_json(url):
            if "IStoreQueryService" in url:
                return {"response": {"ids": [{"appid": index} for index in range(1, 501)],
                                     "metadata": {"total_matching_records": 500}}}
            return {"total_count": 104, "results_html": "x"}

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "deals-data.js"
            watchlist = Path(directory) / "watchlist.json"
            watchlist.write_text('{"appids": []}', encoding="utf-8")
            with mock.patch.object(sync_deals, "OUTPUT", output), \
                    mock.patch.object(sync_deals, "WATCHLIST", watchlist), \
                    mock.patch.object(sync_deals, "MIN_DEALS_ITEMS", 1), \
                    mock.patch.object(sync_deals, "PRICE_BATCH", 50), \
                    mock.patch.object(sync_deals, "PRICE_WINDOW", 3), \
                    mock.patch.object(sync_deals, "fetch_json", side_effect=fetch_json), \
                    mock.patch.object(sync_deals, "parse_rows", side_effect=[rows, []]), \
                    mock.patch.object(sync_deals, "official_genre_tags", return_value={}), \
                    mock.patch.object(sync_deals, "browse_items", side_effect=browse), \
                    mock.patch.dict(sync_deals.os.environ, {"STEAM_DEALS_SKIP_COVERS": "1"}), \
                    mock.patch.object(sync_deals.time, "sleep"):
                sync_deals.main()
            published = output.read_text(encoding="utf-8")

        # Windowing and threading must not drop, duplicate or reorder work.
        self.assertEqual(len(requested), len(set(requested)))
        self.assertEqual(sorted(requested), list(range(1, 501)))
        self.assertEqual(published.count('"appid":'), 500)


class WatchlistTests(unittest.TestCase):
    ITEM = {
        "appid": 447700, "name": "Crystal Crisis", "type": 0, "visible": True, "tags": [],
        "best_purchase_option": {
            "packageid": 1821396, "final_price_in_cents": "0",
            "original_price_in_cents": "63500", "discount_pct": 100,
            "is_free_to_keep": True, "free_to_keep_ends": 1790060340,
        },
    }

    def test_free_to_keep_promotion_normalizes_without_a_search_row(self):
        game = sync_deals.normalize_store_item(self.ITEM, None, {})
        self.assertEqual(game["appid"], 447700)
        self.assertEqual(game["priceMinor"], 0)
        self.assertEqual(game["originalPriceMinor"], 63500)
        self.assertEqual(game["savingsMinor"], 63500)
        self.assertEqual(game["discountPercent"], 100)
        # Free-to-keep offers carry no active_discounts, only free_to_keep_ends.
        self.assertEqual(game["discountEndAt"], 1790060340)
        self.assertIsNone(game["reviewPercent"])
        self.assertFalse(game["qualityMatch"])
        # The 635 rouble list price is below the 1500 rouble high-value floor, so the
        # flag stays off. Flags only badge an entry; they never gate publication.
        self.assertFalse(game["highValueMatch"])

    def test_watchlist_file_is_read_and_tolerates_absence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "watchlist.json"
            with mock.patch.object(sync_deals, "WATCHLIST", path):
                self.assertEqual(sync_deals.watchlist_appids(), set())
                path.write_text('{"appids": [447700, "123", "nope"]}', encoding="utf-8")
                self.assertEqual(sync_deals.watchlist_appids(), {447700, 123})

    def test_shipped_watchlist_is_valid_and_carries_the_reported_game(self):
        self.assertIn(447700, sync_deals.watchlist_appids())

    def test_watchlist_entry_absent_from_specials_still_reaches_the_catalog(self):
        specials_rows = [{"appid": 10, "itemKey": "App_10", "name": "Other", "discountPercent": 50,
                          "roughOriginalMinor": None, "roughPriceMinor": None,
                          "reviewPercent": 90, "reviewCount": 20000, "url": "u"}]
        specials_item = {"appid": 10, "name": "Other", "type": 0, "visible": True, "tags": [],
                         "best_purchase_option": {"original_price_in_cents": 20000,
                                                  "final_price_in_cents": 10000, "discount_pct": 50}}

        def browse(appids):
            return [self.ITEM] if list(appids) == [447700] else [specials_item]

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "deals-data.js"
            watchlist = Path(directory) / "watchlist.json"
            watchlist.write_text('{"appids": [447700]}', encoding="utf-8")
            with mock.patch.object(sync_deals, "OUTPUT", output), \
                    mock.patch.object(sync_deals, "WATCHLIST", watchlist), \
                    mock.patch.object(sync_deals, "MIN_DEALS_ITEMS", 1), \
                    mock.patch.object(sync_deals, "fetch_json", return_value={"total_count": 1, "results_html": "x"}), \
                    mock.patch.object(sync_deals, "parse_rows", return_value=specials_rows), \
                    mock.patch.object(sync_deals, "official_genre_tags", return_value={}), \
                    mock.patch.object(sync_deals, "browse_items", side_effect=browse), \
                    mock.patch.dict(sync_deals.os.environ, {"STEAM_DEALS_SKIP_COVERS": "1"}), \
                    mock.patch.object(sync_deals.time, "sleep"):
                sync_deals.main()
            published = output.read_text(encoding="utf-8")
        self.assertIn('"appid": 447700', published)
        self.assertIn('"discountPercent": 100', published)
        self.assertIn('"watchlistDeals": 1', published)
        # Sorted by savings, the giveaway outranks the ordinary 50% offer.
        self.assertLess(published.index('"appid": 447700'), published.index('"appid": 10'))


class CompletenessTests(unittest.TestCase):
    def test_each_stage_fails_closed_on_its_own_collapse(self):
        with self.assertRaisesRegex(RuntimeError, "offers catalog is too small"):
            sync_deals.validate_offer_volume(101)
        sync_deals.validate_offer_volume(1765)

        with self.assertRaisesRegex(RuntimeError, "store detail catalog is too small"):
            sync_deals.validate_detail_coverage(0, 6000)
        with self.assertRaisesRegex(RuntimeError, "store detail catalog is too small"):
            sync_deals.validate_detail_coverage(2000, 6000)
        sync_deals.validate_detail_coverage(5900, 6000)

        with self.assertRaisesRegex(RuntimeError, "normalized deals catalog is too small"):
            sync_deals.validate_published_volume(600)
        sync_deals.validate_published_volume(3484)

    def test_the_two_real_deploy_blocking_runs_now_publish(self):
        # Both observed production failures: a Steam catalog that genuinely shrank
        # (3463 deals against a 3963 snapshot) and a promotion mix where fewer than
        # half the scraped Specials rows normalize into discounted games.
        sync_deals.validate_offer_volume(5600)
        sync_deals.validate_published_volume(3463)
        sync_deals.validate_offer_volume(8983)
        sync_deals.validate_published_volume(3484)

    def test_full_discount_reaches_the_published_catalog(self):
        rows = [{"appid": 447700, "itemKey": "App_447700", "name": "Crystal Crisis",
                 "discountPercent": 100, "roughOriginalMinor": None, "roughPriceMinor": None,
                 "reviewPercent": 91, "reviewCount": 1200,
                 "url": "https://store.steampowered.com/app/447700/Crystal_Crisis/"}]
        items = [{"appid": 447700, "name": "Crystal Crisis", "type": 0, "visible": True, "tags": [],
                  "best_purchase_option": {"original_price_in_cents": 49900, "discount_pct": 100,
                                           "active_discounts": [{"discount_end_date": 1790000000}]}}]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "deals-data.js"
            with mock.patch.object(sync_deals, "OUTPUT", output), \
                    mock.patch.object(sync_deals, "MIN_DEALS_ITEMS", 1), \
                    mock.patch.object(sync_deals, "fetch_json", return_value={"total_count": 1, "results_html": "page-1"}), \
                    mock.patch.object(sync_deals, "parse_rows", return_value=rows), \
                    mock.patch.object(sync_deals, "official_genre_tags", return_value={}), \
                    mock.patch.object(sync_deals, "browse_items", return_value=items), \
                    mock.patch.dict(sync_deals.os.environ, {"STEAM_DEALS_SKIP_COVERS": "1"}), \
                    mock.patch.object(sync_deals.time, "sleep"):
                sync_deals.main()
            published = output.read_text(encoding="utf-8")
        self.assertIn('"appid": 447700', published)
        self.assertIn('"discountPercent": 100', published)
        self.assertIn('"priceMinor": 0', published)
        self.assertIn('"savingsMinor": 49900', published)

    def test_truncated_catalog_stops_before_details_covers_or_publication(self):
        rows = [
            {"appid": index, "itemKey": f"App_{index}"}
            for index in range(101)
        ]
        pages = [rows[:100], rows[100:]]
        sentinel = "last-known-good"
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "deals-data.js"
            output.write_text(sentinel, encoding="utf-8")
            with mock.patch.object(sync_deals, "OUTPUT", output), \
                    mock.patch.object(sync_deals, "fetch_json", side_effect=[
                        {"total_count": 101, "results_html": "page-1"},
                        {"total_count": 101, "results_html": "page-2"},
                    ]), \
                    mock.patch.object(sync_deals, "parse_rows", side_effect=pages), \
                    mock.patch.object(sync_deals, "official_genre_tags") as tags, \
                    mock.patch.object(sync_deals, "browse_items") as browse, \
                    mock.patch.object(sync_deals, "save_cover") as cover, \
                    mock.patch.object(sync_deals.time, "sleep"):
                with self.assertRaisesRegex(RuntimeError, "catalog is too small"):
                    sync_deals.main()
            tags.assert_not_called()
            browse.assert_not_called()
            cover.assert_not_called()
            self.assertEqual(output.read_text(encoding="utf-8"), sentinel)


class CoverSyncTests(unittest.TestCase):
    def test_metadata_only_sync_does_not_download_covers(self):
        deals = [{"appid": 1159420, "_coverUrl": "https://shared.fastly.steamstatic.com/cover.jpg"}]

        with mock.patch.object(sync_deals, "save_cover") as save_cover:
            sync_deals.attach_covers(deals, download=False)

        save_cover.assert_not_called()
        self.assertEqual(deals, [{"appid": 1159420, "cover": False}])


if __name__ == "__main__":
    unittest.main()
