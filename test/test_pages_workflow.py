import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class PagesWorkflowTests(unittest.TestCase):
    def test_pages_runs_root_owned_runtime_integrity_case_as_root(self):
        workflow = (ROOT / ".github/workflows/pages.yml").read_text(encoding="utf-8")

        # Discovery resolves the suite by path. A dotted `test.test_deploy_config...`
        # target would be ambiguous, because `test/` has no __init__.py and CPython
        # ships a stdlib package of the same name that wins over a namespace portion.
        self.assertIn(
            "sudo python -m unittest discover -s test -p 'test_deploy_config.py' "
            "-k test_runtime_integrity_allows_internal_symlinks_and_rejects_extra_entries",
            workflow,
        )
        # Only the one case that genuinely needs root may run elevated.
        self.assertNotIn(
            "sudo python -m unittest discover -s test -p 'test_deploy_config.py'\n",
            workflow,
        )

    def test_pages_refreshes_deals_on_a_recurring_schedule_before_building(self):
        workflow = (ROOT / ".github/workflows/pages.yml").read_text(encoding="utf-8")

        self.assertIn("schedule:", workflow)
        self.assertRegex(workflow, r"cron:\s*['\"]?0 \*/6 \* \* \*['\"]?")
        self.assertIn("STEAM_DEALS_SKIP_COVERS=1 npm run sync:deals", workflow)
        self.assertLess(workflow.index("npm run sync:deals"), workflow.index("npm run build:client"))


if __name__ == "__main__":
    unittest.main()
