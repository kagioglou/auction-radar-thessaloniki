import unittest
from bs4 import BeautifulSoup
import scraper

class ParserHelpersTest(unittest.TestCase):
    def test_number_european(self):
        self.assertEqual(scraper.parse_number('125.000'), 125000)
        self.assertEqual(scraper.parse_number('75,66'), 75.66)
    def test_price_sqm(self):
        text='€140.000 €927/τ.μ. Μονοκατοικία, 151 τ.μ., Ελευθέριο-Κορδελιό'
        self.assertEqual(scraper.euro_from_text(text), 140000)
        self.assertEqual(scraper.sqm_from_text(text), 151)
    def test_prosperty_like_card(self):
        html='<div class="card"><a href="/listings/123/">€100.000 Διαμέρισμα, 80 τ.μ., Καλαμαριά</a></div>'
        soup=BeautifulSoup(html,'lxml')
        a=soup.find('a')
        card=scraper.card_container(a)
        self.assertIn('100.000', card.get_text())
    def test_stable_key_source_scoped(self):
        a=scraper.stable_key('Prosperty','https://x/listings/1/','A',80,100000)
        b=scraper.stable_key('Delfi','https://x/listings/1/','A',80,100000)
        self.assertNotEqual(a,b)

if __name__=='__main__': unittest.main()
