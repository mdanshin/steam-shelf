import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class PagesWorkflowTests(unittest.TestCase):
    def test_pages_refreshes_deals_on_a_recurring_schedule_before_building(self):
        workflow = (ROOT / ".github/workflows/pages.yml").read_text(encoding="utf-8")

        self.assertIn("schedule:", workflow)
        self.assertRegex(workflow, r"cron:\s*['\"]?0 \*/6 \* \* \*['\"]?")
        self.assertLess(workflow.index("npm run sync:deals"), workflow.index("npm run build:client"))


if __name__ == "__main__":
    unittest.main()
