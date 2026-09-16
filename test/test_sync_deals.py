import importlib.util
import tempfile
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
