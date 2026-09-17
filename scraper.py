#!/usr/bin/env python3
"""C&H Auction Radar multi-source updater.

Sources:
- eAuction24 (Thessaloniki auctions)
- Prosperty (Thessaloniki city + suburbs residential sale pages)
- Delfi Properties (sale/auction listings; Thessaloniki-focused filtering)

The script keeps a central history in data/history.json, emits data/current.json,
and archives the prior ISO week on the first successful run of a new week.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin, urlparse
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup, Tag

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
WEEKLY = DATA / "weekly"
HISTORY_FILE = DATA / "history.json"
CURRENT_FILE = DATA / "current.json"
WEEKLY_INDEX_FILE = DATA / "weekly_index.json"
ATHENS_TZ = ZoneInfo("Europe/Athens")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36",
    "Accept-Language": "el-GR,el;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

EAUCTION24_ROOT = (
    "https://www.eauction24.gr/auctions/"
    "%CE%9A%CE%B5%CE%BD%CF%84%CF%81%CE%B9%CE%BA%CE%AE%CF%82%20"
    "%CE%9C%CE%B1%CE%BA%CE%B5%CE%B4%CE%BF%CE%BD%CE%AF%CE%B1%CF%82/"
    "%CE%98%CE%B5%CF%83%CF%83%CE%B1%CE%BB%CE%BF%CE%BD%CE%AF%CE%BA%CE%B7%CF%82"
)
PROSPERTY_PAGES = [
    "https://theprosperty.com/pwliseis-katoikiwn/thessaloniki/",
    "https://theprosperty.com/pwliseis-katoikiwn/thessaloniki-proastia/",
]
DELFI_PAGES = [
    "https://delfiproperties.gr/en/properties/auction/residential/",
    "https://delfiproperties.gr/en/properties/auction/land/",
    "https://delfiproperties.gr/en/properties/sale/residential/",
    "https://delfiproperties.gr/en/properties/sale/land/",
]

# Thessaloniki + areas the C&H radar already treats as relevant.
THESS_TERMS = [
    "thessaloniki", "θεσσαλονικ", "kalamaria", "καλαμαρι", "thermi", "θερμη",
    "pylaia", "πυλαι", "evosmos", "ευοσμ", "kordelio", "κορδελι", "polichni", "πολιχν",
    "neapoli", "νεαπολ", "ampelokipi", "αμπελοκηπ", "oreokastro", "oraiokastro", "ωραιοκαστρ",
    "sindos", "σινδο", "kalochori", "καλοχωρ", "diavata", "διαβατ", "nea magnissia", "νεα μαγνησια",
    "thermaikos", "θερμαικ", "epanomi", "επανομ", "michaniona", "μηχανιων", "panorama", "πανοραμ",
]

PROPERTY_WORDS = [
    "διαμέρισμα", "οροφοδιαμέρισμα", "μονοκατοικία", "μεζονέτα", "στούντιο", "λοφτ",
    "κατάστημα", "γραφείο", "αποθήκη", "οικόπεδο", "αγροτεμάχιο", "κτίριο", "κτήριο",
    "apartment", "house", "maisonette", "office", "warehouse", "retail", "land", "building", "mixed use",
]


def now_local() -> datetime:
    return datetime.now(ATHENS_TZ)


def iso_week_key(dt: datetime | None = None) -> str:
    dt = dt or now_local()
    y, w, _ = dt.isocalendar()
    return f"{y}-W{w:02d}"


def iso_now() -> str:
    return now_local().isoformat(timespec="seconds")


def clean_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").replace("\xa0", " ")).strip()


def parse_number(value: str | int | float | None) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = clean_text(str(value)).replace("€", "").replace(" ", "")
    if not s:
        return None
    # European thousands/decimal handling.
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+(?:,\d+)?", s):
        s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d+(?:,\d+)", s):
        s = s.replace(",", ".")
    else:
        s = re.sub(r"[^0-9.-]", "", s)
    try:
        return float(s)
    except ValueError:
        return None


def euro_from_text(text: str) -> float | None:
    # Prefer prices prefixed with €, then labelled auction price.
    m = re.search(r"€\s*([\d.]+(?:,\d+)?)", text)
    if m:
        return parse_number(m.group(1))
    m = re.search(r"(?:Τιμή|Price)\s*:?\s*([\d.]+(?:,\d+)?)\s*€", text, re.I)
    return parse_number(m.group(1)) if m else None


def sqm_from_text(text: str) -> float | None:
    patterns = [
        r"([\d.]+(?:,\d+)?)\s*(?:τ\.?\s*μ\.?|sq\.?\s*m|sqm)",
        r"([\d.]+(?:,\d+)?)\s*m²",
    ]
    for p in patterns:
        m = re.search(p, text, re.I)
        if m:
            return parse_number(m.group(1))
    return None


def normalize_url(base: str, href: str) -> str:
    u = urljoin(base, href)
    p = urlparse(u)
    return f"{p.scheme}://{p.netloc}{p.path}".rstrip("/") + ("/" if p.path.endswith("/") else "")


def stable_key(source: str, url: str, title: str, sqm: float | None, price: float | None) -> str:
    path = urlparse(url).path.rstrip("/")
    if path:
        return f"{source.lower()}:{path.lower()}"
    raw = f"{source}|{title}|{sqm}|{price}"
    return f"{source.lower()}:sig:{hashlib.sha1(raw.encode('utf-8')).hexdigest()[:16]}"


def auto_score(item: dict) -> float:
    """Conservative discovery score, not a valuation/ROI forecast.

    Real performance ranking in the browser can supersede this once C&H
    enters market value, rent, renovation and target bid.
    """
    price, sqm = item.get("price"), item.get("sqm")
    score = 0.0
    if price and sqm:
        psm = price / sqm
        if psm <= 800: score += 35
        elif psm <= 1100: score += 30
        elif psm <= 1400: score += 24
        elif psm <= 1700: score += 18
        elif psm <= 2100: score += 12
        elif psm <= 2500: score += 6
    if item.get("transaction") == "Auction":
        score += 5
    flags = " ".join(item.get("flags") or []).lower()
    if "reduced" in flags or "μειω" in flags or "νέα προσθήκη" in flags:
        score += 3
    if sqm and 35 <= sqm <= 140:
        score += 2
    return round(min(score, 45), 1)


def get(session: requests.Session, url: str, attempts: int = 3) -> str:
    last = None
    for attempt in range(attempts):
        try:
            r = session.get(url, timeout=35, allow_redirects=True)
            r.raise_for_status()
            if len(r.text) < 400:
                raise RuntimeError(f"unexpected short response ({len(r.text)} chars)")
            return r.text
        except Exception as exc:
            last = exc
            time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(str(last))


def _listing_ids_in(node: Tag) -> set[str]:
    ids: set[str] = set()
    if node.name == "a":
        href = node.get("href") or ""
        m = re.search(r"/listings/(\d+)", href)
        if m:
            ids.add(m.group(1))
    for a in node.find_all("a", href=True):
        href = a.get("href") or ""
        m = re.search(r"/listings/(\d+)", href)
        if m:
            ids.add(m.group(1))
    return ids


def prosperty_card_container(anchor: Tag) -> Tag:
    """Return the smallest DOM ancestor representing ONE Prosperty listing card.

    The previous generic card_container() stopped at the first ancestor containing
    a euro sign. On Prosperty's grid that can be a row/section containing several
    listings, which makes every anchor inherit the first listing's title and price.
    Here we isolate the smallest ancestor that contains exactly one unique
    ``/listings/<id>`` URL and a visible property/price block.
    """
    node: Tag = anchor
    fallback: Tag = anchor
    for _ in range(10):
        if not isinstance(node, Tag):
            break
        text = clean_text(node.get_text(" ", strip=True))
        ids = _listing_ids_in(node)
        fallback = node
        if len(ids) == 1 and "€" in text and 20 <= len(text) <= 1400:
            return node
        parent = node.parent
        if not isinstance(parent, Tag):
            break
        node = parent
    return fallback


def card_container(anchor: Tag, must_have: Iterable[str] = ("€",)) -> Tag:
    # Kept for the other sources. Prosperty uses the stricter card finder above.
    node: Tag = anchor
    best = anchor
    for _ in range(7):
        parent = node.parent
        if not isinstance(parent, Tag):
            break
        text = clean_text(parent.get_text(" ", strip=True))
        best = parent
        if all(token.lower() in text.lower() for token in must_have) and len(text) < 2200:
            return parent
        node = parent
    return best


def title_from_text(text: str, fallback: str = "Ακίνητο") -> str:
    # Match a property phrase ending around the first sqm occurrence.
    m = re.search(
        r"((?:Διαμέρισμα|Οροφοδιαμέρισμα|Μονοκατοικία|Μεζονέτα|Στούντιο|Λοφτ|Κατάστημα|Γραφείο|Αποθήκη|Οικόπεδο|Αγροτεμάχιο|Κτίριο|Κτήριο|Μεικτής Χρήσης|Apartment|House|Maisonette|Office|Warehouse|Retail Store|Residential Land|Agricultural Land|Commercial Building|Mixed Use)[^€]{0,140}?(?:τ\.?μ\.?|sqm))",
        text, re.I,
    )
    return clean_text(m.group(1)) if m else clean_text(fallback) or "Ακίνητο"


def location_from_title(title: str) -> str:
    # Common Prosperty form: "Apartment, 95 sqm, Kalamaria"
    parts = [clean_text(x) for x in title.split(",")]
    return parts[-1] if len(parts) >= 3 else ""


def prosperty_price_from_card(text: str, sqm: float | None) -> float | None:
    """Read Prosperty's CURRENT asking price, not a €/sqm value or a wrong sibling price.

    Prosperty cards are rendered as: ``€140.000 €927/sqm Apartment, 151 sqm...``.
    When more than one euro amount exists, choose the euro amount immediately before
    the displayed €/sqm figure when possible; this also handles old/new price pairs.
    """
    text = clean_text(text)
    price_matches = list(re.finditer(r"€\s*([\d.]+(?:,\d+)?)", text))
    if not price_matches:
        return None

    # A displayed €/sqm value gives us a strong local anchor for the property price.
    psm = re.search(r"€\s*([\d.]+(?:,\d+)?)\s*/\s*(?:τ\.?\s*μ\.?|sqm|m²)", text, re.I)
    if psm:
        psm_value = parse_number(psm.group(1))
        before = [m for m in price_matches if m.start() < psm.start()]
        if before:
            candidate = before[-1]
            price = parse_number(candidate.group(1))
            if price is not None and sqm and psm_value:
                # Prefer a candidate that is numerically consistent with Prosperty's own €/sqm.
                expected = psm_value * sqm
                if expected > 0 and abs(price - expected) / expected <= 0.08:
                    return price
            # Even if rounding/formatting makes the check fail, the nearest preceding euro
            # amount is more likely to be the current price than an amount from another card.
            return price

    # Normal cards have the current asking price as the first euro amount.
    return parse_number(price_matches[0].group(1))


def prosperty_card_title(anchor_text: str, card_text: str) -> str:
    """Extract Prosperty's human-facing title including its location.

    The category page normally exposes titles like:
    ``Διαμέρισμα, 110 τ.μ., Ελευθέριο-Κορδελιό``.
    The previous parser stopped at the first sqm token, which made distinct
    listings look identical in the Radar.
    """
    property_type = (
        r"Διαμέρισμα|Οροφοδιαμέρισμα|Μονοκατοικία|Μεζονέτα|Στούντιο|Λοφτ|"
        r"Κατάστημα|Γραφείο|Αποθήκη|Οικόπεδο|Αγροτεμάχιο|Κτίριο|Κτήριο|"
        r"Μεικτής Χρήσης|Εμπορικό|Apartment|House|Maisonette|Office|"
        r"Warehouse|Retail(?:\s+Store)?|Land|Building|Mixed\s+Use"
    )
    texts = [clean_text(anchor_text), clean_text(card_text)]

    for text in texts:
        if not text:
            continue
        # Full category-card title: type + size + location.
        m = re.search(
            rf"((?:{property_type})\s*,\s*[\d.,]+\s*(?:τ\.?\s*μ\.?|sqm|m²)\s*,\s*[^€|]{{2,70}})",
            text,
            re.I,
        )
        if m:
            return clean_text(m.group(1)).rstrip("-|")
        # Title without an explicit location.
        m = re.search(
            rf"((?:{property_type})\s*,\s*[\d.,]+\s*(?:τ\.?\s*μ\.?|sqm|m²))",
            text,
            re.I,
        )
        if m:
            return clean_text(m.group(1))

    return title_from_text(card_text, clean_text(anchor_text) or "Ακίνητο")


def prosperty_listing_fields(card_text: str) -> dict:
    """Extract visible differentiators so duplicate filtering is conservative."""
    floor = None
    bedrooms = None
    parking = None

    floor_patterns = [
        r"\b(Υπόγειο(?:\s+L\d+)?|Ισόγειο|Ημιώροφος|Μεσοπάτωμα|"
        r"\d{1,2}ος\s+όροφος|\d{1,2}st\s+floor|\d{1,2}nd\s+floor|"
        r"\d{1,2}rd\s+floor|\d{1,2}th\s+floor)\b"
    ]
    for pat in floor_patterns:
        m = re.search(pat, card_text, re.I)
        if m:
            floor = clean_text(m.group(1))
            break

    m = re.search(r"(\d+)\s+(?:υ/δ|υπνοδωμάτια|bedrooms?)\b", card_text, re.I)
    if m:
        bedrooms = int(m.group(1))

    m = re.search(
        r"(\d+)\s+(?:θέσεις\s+πάρκινγκ|θέση\s+πάρκινγκ|parking\s+spaces?)\b",
        card_text,
        re.I,
    )
    if m:
        parking = int(m.group(1))
    elif re.search(r"\bparking\b|πάρκινγκ|θέση\s+πάρκινγκ", card_text, re.I):
        parking = 1

    return {"floor": floor, "bedrooms": bedrooms, "parking": parking}


def scrape_prosperty(session: requests.Session) -> list[dict]:
    out: dict[str, dict] = {}
    for base in PROSPERTY_PAGES:
        no_new_pages = 0
        for page in range(1, 9):
            url = base if page == 1 else f"{base}?page={page}"
            html = get(session, url)
            soup = BeautifulSoup(html, "lxml")
            before = len(out)

            for a in soup.find_all("a", href=re.compile(r"/listings/\d+/?")):
                href = a.get("href") or ""
                full = normalize_url(base, href)
                card = prosperty_card_container(a)
                text = clean_text(card.get_text(" ", strip=True))
                if not any(w.lower() in text.lower() for w in PROPERTY_WORDS):
                    continue

                sqm = sqm_from_text(text)
                price = prosperty_price_from_card(text, sqm)
                title = prosperty_card_title(a.get_text(" ", strip=True), text)
                loc = location_from_title(title)
                extra = prosperty_listing_fields(text)
                flags = [
                    flag for flag in [
                        "ΝΕΑ ΠΡΟΣΘΗΚΗ", "ΑΠΟΚΛΕΙΣΤΙΚΟ", "Ακίνητα EUROBANK",
                        "ΧΡΥΣΗ ΒΙΖΑ", "ΥΠΟ ΚΑΤΑΣΚΕΥΗ"
                    ]
                    if flag.lower() in text.lower()
                ]

                # Canonical identity remains the actual Prosperty listing URL/ID.
                # We only collapse entries later when their full visible property
                # fingerprint is identical, so different same-sized listings survive.
                key = stable_key("Prosperty", full, title, sqm, price)
                if key in out:
                    out[key]["source_page"] = url
                    continue

                item = {
                    "key": key, "source": "Prosperty", "url": full, "title": title,
                    "address": loc, "sqm": sqm, "price": price, "transaction": "Sale",
                    "type": title.split(",")[0], "flags": flags, "source_page": url,
                    "floor": extra["floor"], "bedrooms": extra["bedrooms"],
                    "parking": extra["parking"],
                }
                item["score_auto"] = auto_score(item)
                out[key] = item

            if len(out) == before:
                no_new_pages += 1
            else:
                no_new_pages = 0
            if no_new_pages >= 2:
                break

    return list(out.values())


def scrape_eauction24(session: requests.Session) -> list[dict]:
    out: dict[str, dict] = {}
    no_new_pages = 0
    for page in range(1, 21):
        url = EAUCTION24_ROOT if page == 1 else f"{EAUCTION24_ROOT}?page={page}"
        html = get(session, url)
        soup = BeautifulSoup(html, "lxml")
        before = len(out)
        anchors = soup.find_all("a", href=re.compile(r"/auction/\d+"))
        for a in anchors:
            href = a.get("href") or ""
            full = normalize_url("https://www.eauction24.gr", href)
            card = card_container(a)
            text = clean_text(card.get_text(" ", strip=True))
            if not any(w.lower() in text.lower() for w in PROPERTY_WORDS):
                continue
            # Heading is usually cleaner than link text.
            h = card.find(re.compile(r"^h[2-6]$"))
            title = clean_text(h.get_text(" ", strip=True) if h else a.get_text(" ", strip=True))
            title = title or title_from_text(text)
            sqm = sqm_from_text(title + " " + text)
            price = euro_from_text(text)
            dm = re.search(r"Ημερομηνία\s+πλειστηριασμού\s*:?\s*(\d{1,2}/\d{1,2}/\d{4}(?:\s+\d{1,2}:\d{2})?)", text, re.I)
            auction_date = dm.group(1) if dm else None
            address = text
            for chunk in [title, f"Τιμή: {price} €" if price else ""]:
                if chunk:
                    address = address.replace(chunk, " ")
            address = re.sub(r"Ημερομηνία\s+πλειστηριασμού.*$", "", address, flags=re.I)
            address = clean_text(address)[:300]
            key = stable_key("eAuction24", full, title, sqm, price)
            item = {
                "key": key, "source": "eAuction24", "url": full, "title": title,
                "address": address, "sqm": sqm, "price": price, "transaction": "Auction",
                "type": title.split(",")[0], "auction_date": auction_date, "flags": [], "source_page": url,
            }
            item["score_auto"] = auto_score(item)
            out[key] = item
        if len(out) == before:
            no_new_pages += 1
        else:
            no_new_pages = 0
        if no_new_pages >= 2:
            break
    return list(out.values())


def relevant_delfi(text: str) -> bool:
    low = text.lower()
    return any(term in low for term in THESS_TERMS)


def scrape_delfi(session: requests.Session) -> list[dict]:
    out: dict[str, dict] = {}
    for base in DELFI_PAGES:
        no_new_pages = 0
        for page in range(1, 31):
            url = base if page == 1 else f"{base}?page={page}"
            try:
                html = get(session, url)
            except Exception as exc:
                # A blocked category/page should not prevent other Delfi
                # public categories from being checked.
                print(f"Delfi page ERROR {url}: {exc}", file=sys.stderr)
                no_new_pages += 1
                if page == 1:
                    break
                if no_new_pages >= 2:
                    break
                continue

            soup = BeautifulSoup(html, "lxml")
            before = len(out)

            for a in soup.find_all("a", href=re.compile(r"/en/property/", re.I)):
                href = a.get("href") or ""
                full = normalize_url("https://delfiproperties.gr", href)
                card = card_container(a, must_have=("€",))
                card_text = clean_text(card.get_text(" ", strip=True))

                if not relevant_delfi(card_text):
                    continue

                price = euro_from_text(card_text)
                sqm = sqm_from_text(card_text)
                title = clean_text(a.get_text(" ", strip=True))
                if len(title) < 4 or title.lower() in {"view property", "details"}:
                    h = card.find(re.compile(r"^h[2-6]$"))
                    title = clean_text(h.get_text(" ", strip=True) if h else "")
                title = title or title_from_text(card_text)

                address = ""
                for term in THESS_TERMS:
                    m = re.search(
                        rf"([^|€]{{0,100}}{re.escape(term)}[^|€]{{0,100}})",
                        card_text,
                        re.I,
                    )
                    if m:
                        address = clean_text(m.group(1))
                        break

                transaction = "Auction" if re.search(r"\bAuction\b", card_text, re.I) else "Sale"
                flags = []
                if "reduced" in card_text.lower() or "~~" in card_text:
                    flags.append("Reduced price")
                if "reserved price" in card_text.lower():
                    flags.append("Reserved price")

                key = stable_key("Delfi", full, title, sqm, price)
                item = {
                    "key": key, "source": "Delfi", "url": full, "title": title,
                    "address": address, "sqm": sqm, "price": price,
                    "transaction": transaction, "type": title.split(" in ")[0],
                    "flags": flags, "source_page": url,
                }
                item["score_auto"] = auto_score(item)
                out[key] = item

            if len(out) == before:
                no_new_pages += 1
            else:
                no_new_pages = 0
            if no_new_pages >= 2:
                break

    return list(out.values())


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def dump_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=False), encoding="utf-8")


def archive_previous_week(history: dict, current_week: str, now: str) -> dict | None:
    prev = history.get("last_week_key")
    if not prev or prev == current_week:
        history["last_week_key"] = current_week
        return None
    file = WEEKLY / f"{prev}.json"
    if file.exists():
        history["last_week_key"] = current_week
        return None
    records = list((history.get("records") or {}).values())
    rows = []
    new_count = 0
    for r in records:
        first = str(r.get("first_seen") or "")
        first_week = r.get("first_seen_week")
        if first_week == prev:
            new_count += 1
        row = dict(r)
        row["score_auto"] = auto_score(row)
        rows.append(row)
    rows.sort(key=lambda x: (x.get("score_auto") or 0, -(x.get("price") or 10**12)), reverse=True)
    snapshot = {
        "week": prev, "saved_at": now, "total_records": len(rows), "new_records": new_count,
        "ranking": rows,
    }
    dump_json(file, snapshot)
    history["last_week_key"] = current_week
    return {"week": prev, "saved_at": now, "total_records": len(rows), "new_records": new_count, "file": f"./data/weekly/{prev}.json"}


def cleanup_history_duplicates(history: dict) -> int:
    """Remove only exact duplicate Prosperty URLs from legacy history.

    Do NOT collapse by title/size/price/location. Prosperty can legitimately have
    different listings with identical visible values, and the listing URL/ID is the
    authoritative identity.
    """
    records = history.setdefault("records", {})
    seen: dict[str, tuple[str, dict]] = {}
    removed = 0
    for key, rec in list(records.items()):
        if rec.get("source") != "Prosperty":
            continue
        url = str(rec.get("url") or "").rstrip("/").lower()
        if not url:
            continue
        prev = seen.get(url)
        if prev is None:
            seen[url] = (key, rec)
            continue
        prev_key, prev_rec = prev
        # Keep the more recently seen/active copy.
        keep_key, keep_rec = (key, rec) if (bool(rec.get("active")), str(rec.get("last_seen") or "")) > (bool(prev_rec.get("active")), str(prev_rec.get("last_seen") or "")) else (prev_key, prev_rec)
        drop_key = prev_key if keep_key == key else key
        if keep_key == key:
            records[key] = dict(keep_rec)
            records[key]["key"] = key
            seen[url] = (key, records[key])
        records.pop(drop_key, None)
        removed += 1
    return removed


def merge(history: dict, source_results: dict[str, list[dict]], source_ok: dict[str, bool], now: str, week: str) -> list[dict]:
    records = history.setdefault("records", {})
    current_keys_by_source: dict[str, set[str]] = {s:set() for s in source_results}
    out = []
    tracked = ["title", "address", "sqm", "price", "auction_date", "transaction", "url", "floor", "bedrooms", "parking"]

    for source, items in source_results.items():
        for item in items:
            key = item["key"]
            current_keys_by_source[source].add(key)
            old = records.get(key)
            if not old:
                rec = {**item, "first_seen": now, "first_seen_week": week, "last_seen": now, "active": True, "status": "NEW", "changes": []}
            else:
                changes = []
                for field in tracked:
                    if old.get(field) != item.get(field):
                        changes.append({"field":field,"from":old.get(field),"to":item.get(field)})
                rec = {**old, **item, "last_seen": now, "active": True, "status": "CHANGE" if changes else "ACTIVE", "changes": changes}
                rec.setdefault("first_seen", old.get("first_seen", now))
                rec.setdefault("first_seen_week", old.get("first_seen_week", week))
            rec["score_auto"] = auto_score(rec)
            records[key] = rec
            out.append(rec)

    # Mark missing records inactive only when that particular source scrape succeeded.
    for key, rec in list(records.items()):
        source = rec.get("source")
        if source_ok.get(source) and key not in current_keys_by_source.get(source, set()):
            if rec.get("active"):
                rec["active"] = False
                rec["status"] = "REMOVED"
                rec["removed_at"] = now

    out.sort(key=lambda x: (x.get("status") == "NEW", x.get("status") == "CHANGE", x.get("score_auto") or 0), reverse=True)
    return out


def main() -> int:
    DATA.mkdir(exist_ok=True)
    WEEKLY.mkdir(parents=True, exist_ok=True)
    now = iso_now()
    week = iso_week_key()
    history = load_json(HISTORY_FILE, {"version":1,"last_week_key":None,"records":{}})
    removed_duplicates = cleanup_history_duplicates(history)
    if removed_duplicates:
        print(f"Removed legacy Prosperty duplicates: {removed_duplicates}")

    # Archive prior week BEFORE merging the new week's state.
    weekly_entry = archive_previous_week(history, week, now)
    weekly_index = load_json(WEEKLY_INDEX_FILE, {"snapshots":[]})
    if weekly_entry:
        snapshots = [x for x in weekly_index.get("snapshots", []) if x.get("week") != weekly_entry["week"]]
        snapshots.insert(0, weekly_entry)
        weekly_index["snapshots"] = snapshots[:104]
        dump_json(WEEKLY_INDEX_FILE, weekly_index)

    session = requests.Session()
    session.headers.update(HEADERS)
    jobs = {
        "eAuction24": scrape_eauction24,
        "Prosperty": scrape_prosperty,
        "Delfi": scrape_delfi,
    }
    results: dict[str, list[dict]] = {}
    source_meta = {}
    source_ok = {}
    for name, fn in jobs.items():
        try:
            items = fn(session)
            if not items:
                raise RuntimeError("0 listings parsed; source layout may have changed")
            results[name] = items
            source_ok[name] = True
            source_meta[name] = {"ok":True,"count":len(items),"checked_at":now,"error":None}
            print(f"{name}: {len(items)}")
        except Exception as exc:
            results[name] = []
            source_ok[name] = False
            source_meta[name] = {"ok":False,"count":0,"checked_at":now,"error":str(exc)[:300]}
            print(f"{name}: ERROR {exc}", file=sys.stderr)

    current = merge(history, results, source_ok, now, week)
    history["updated_at"] = now
    history["last_week_key"] = week
    dump_json(HISTORY_FILE, history)
    dump_json(CURRENT_FILE, {"updated_at":now,"week":week,"sources":source_meta,"items":current})
    if not WEEKLY_INDEX_FILE.exists():
        dump_json(WEEKLY_INDEX_FILE, weekly_index)

    # We succeed when at least one source worked, so one temporary source outage does not block the radar.
    return 0 if any(source_ok.values()) else 2


if __name__ == "__main__":
    raise SystemExit(main())
