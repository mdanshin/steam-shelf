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


class CompletenessTests(unittest.TestCase):
    def test_absolute_and_published_snapshot_thresholds_fail_closed(self):
        with self.assertRaisesRegex(RuntimeError, "catalog is too small"):
            sync_deals.validate_deals_completeness(101, 1765, "offers")
        with self.assertRaisesRegex(RuntimeError, "catalog is too small"):
            sync_deals.validate_deals_completeness(1500, 1765, "normalized deals")
        sync_deals.validate_deals_completeness(1600, 1765, "normalized deals")

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
                    mock.patch.object(sync_deals, "published_deals_count", return_value=1765), \
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


if __name__ == "__main__":
    unittest.main()
