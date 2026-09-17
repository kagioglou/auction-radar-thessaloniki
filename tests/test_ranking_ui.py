import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]

class RankingUiTest(unittest.TestCase):
    def test_ranking_shows_both_ch_scenarios(self):
        html = (ROOT / 'index.html').read_text(encoding='utf-8')
        for label in [
            'Στρατηγική',
            'Κέρδος άμεσης',
            'ROI άμεσης',
            'Έσοδα 3ετίας',
            'Κέρδος 3ετίας',
            'ROI 3ετίας',
        ]:
            self.assertIn(label, html)

    def test_app_renders_strategy_and_scenario_metrics(self):
        js = (ROOT / 'src' / 'app.js').read_text(encoding='utf-8')
        for field in [
            'strategy',
            'immediateSaleProfit',
            'immediateSaleROI',
            'threeYearRentalIncome',
            'threeYearTotalProfit',
            'threeYearROI',
        ]:
            self.assertIn(field, js)

    def test_csv_exports_both_scenarios(self):
        js = (ROOT / 'src' / 'auction-radar-phase1.js').read_text(encoding='utf-8')
        for field in [
            'immediateSaleProfit', 'immediateSaleROI',
            'threeYearRentalIncome', 'threeYearTotalProfit', 'threeYearROI',
            'threeYearAnnualizedROI', 'strategy'
        ]:
            # field must appear at least in the export section, not just computeMetrics
            export_section = js[js.index('function exportCSV'):]
            self.assertIn(field, export_section)

if __name__ == '__main__':
    unittest.main()
