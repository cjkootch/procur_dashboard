"""
GOJEP fuel/petroleum contract award scraper.

Workflow:
1. Hit /epps/viewCaNotices.do with cftTitle=<keyword> and paginate.
2. For each row, capture (resourceId, buyer, title, value, date, notice_pdf_url).
3. Download each notice PDF and extract the awardee company.
4. Filter to actual fuel supply (not generators, fittings, services).
5. Write to JSON for the master DB.
"""
import re
import json
import time
import subprocess
from pathlib import Path
import requests

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36"
BASE = "https://www.gojep.gov.jm"
OUT = Path("/home/claude/caribbean_fuel")
PDF_CACHE = OUT / "gojep_pdfs"
PDF_CACHE.mkdir(exist_ok=True)

# Keywords most likely to surface fuel SUPPLY (not equipment/services)
FUEL_KEYWORDS = [
    "fuel",
    "diesel",
    "petroleum",
    "gasoline",
    "gasoil",
    "kerosene",
    "bunker",
    "LPG",
    "liquid petroleum",
    "ULSD",
]

# CPV codes that indicate actual fuel supply (vs equipment/services)
FUEL_CPV_CODES = {
    "09000000",  # Petroleum products, fuel, electricity
    "09100000",  # Fuels
    "09110000",  # Solid fuels
    "09120000",  # Gaseous fuels
    "09122000",  # Propane and butane
    "09122100",  # Propane gas
    "09122110",  # Liquified propane gas
    "09130000",  # Petroleum and distillates
    "09131000",  # Aviation kerosene
    "09131100",  # Jet kerosene type fuels
    "09132000",  # Petrol
    "09132100",  # Unleaded petrol
    "09132200",  # Leaded petrol
    "09133000",  # Liquified petroleum gas (LPG)
    "09134000",  # Gas oils
    "09134100",  # Diesel oil
    "09134200",  # Diesel fuel
    "09134210",  # Diesel fuel (0.2)
    "09134220",  # Diesel fuel (EN 590)
    "09134230",  # Bio-diesel
    "09134231",  # Bio-diesel B20
    "09134232",  # Bio-diesel B100
    "09135000",  # Fuel oils
    "09135100",  # Heating oil
    "09135110",  # Low-sulphur fuel oils
    "09140000",  # Wood and other fuels
    "09200000",  # Petroleum, coal, oil products
    "09210000",  # Lubricating preparations
    "09230000",  # Petroleum (crude)
    "09240000",  # Oil and coal-related products
    "09241000",  # Bituminous or oil shale
    "09242000",  # Coal-derived products
    "09243000",  # Other coal-derived products
}


def fetch_search_page(keyword, page=1):
    """Fetch GOJEP CA notices search results for a keyword + page."""
    # GOJEP uses URL params like d-16531-p=<page>
    url = f"{BASE}/epps/viewCaNotices.do"
    params = {"cftTitle": keyword, "d-16531-p": page}
    r = requests.get(url, params=params, headers={"User-Agent": UA}, timeout=60)
    r.raise_for_status()
    return r.text


def parse_search_rows(html):
    """Extract award rows from search HTML."""
    rows = []
    for tr in re.findall(r"<tr[^>]*>.*?</tr>", html, re.DOTALL):
        if "prepareViewCfTWS" not in tr:
            continue
        m_resource = re.search(r"prepareViewCfTWS\.do\?resourceId=(\d+)\">([^<]+)</a>", tr)
        m_pdf = re.search(
            r'href="(/epps/notices/downloadNoticeForES\.do\?resourceId=\d+[^"]+)"', tr
        )
        if not m_resource:
            continue
        cells = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.DOTALL)
        cells = [re.sub(r"<[^>]+>", "", c).strip() for c in cells]
        if len(cells) < 6:
            continue
        rows.append(
            {
                "resource_id": m_resource.group(1),
                "title": m_resource.group(2).strip(),
                "method": cells[1].strip(),
                "buyer": cells[2].strip(),
                "value_raw": cells[4].strip(),
                "date_raw": cells[5].strip(),
                "pdf_url": (BASE + m_pdf.group(1).replace("&amp;", "&")) if m_pdf else None,
            }
        )
    return rows


def get_total(html):
    """Try to extract '<N> results in total' if present."""
    m = re.search(r"([\d,]+)\s+results in total", html)
    return int(m.group(1).replace(",", "")) if m else None


def parse_award_pdf(pdf_path):
    """Run pdftotext and pull awardee, CPV codes, and other fields."""
    txt_path = pdf_path.with_suffix(".txt")
    subprocess.run(
        ["pdftotext", "-layout", str(pdf_path), str(txt_path)],
        capture_output=True,
        timeout=30,
    )
    if not txt_path.exists():
        return {}
    text = txt_path.read_text(errors="ignore")

    out = {"raw_text": text}

    # Awardee — appears after "Name of contractor (1)" then on next non-empty line
    m = re.search(r"Name of contractor[^\n]*\n\s*([^\n]+)", text)
    if m:
        out["awardee"] = m.group(1).strip()

    # CPV codes
    cpv_codes = re.findall(r"(\d{8})-([A-Za-z][^\n]+)", text)
    out["cpv_codes"] = [c[0] for c in cpv_codes]
    out["cpv_descriptions"] = [c[1].strip() for c in cpv_codes]

    # Contract price + currency
    m = re.search(r"Contract price[^\n]*\n\s*([\d.,]+)\s+Currency:\s*(\w+)", text)
    if m:
        out["contract_price"] = m.group(1).strip()
        out["currency"] = m.group(2).strip()

    # Award date
    m = re.search(r"Contract award date\s*\n\s*Date:\s*(\d{1,2}/\d{1,2}/\d{4})", text)
    if m:
        out["award_date"] = m.group(1)

    # Procurement method
    for method in ["Emergency Procedure", "Open - NCB", "Open - ICB", "Restricted Bidding", "Single Source"]:
        if method in text:
            out["procurement_method"] = method
            break

    return out


def is_fuel_supply(award):
    """Filter: is this an actual fuel SUPPLY award (not equipment/services)?"""
    title_l = award.get("title", "").lower()
    cpv = set(award.get("cpv_codes", []))

    # Strong positive signal: CPV starts with 09 (energy/fuel)
    has_fuel_cpv = any(c in FUEL_CPV_CODES for c in cpv)

    # Title-based exclusions (equipment/services masquerading as fuel keywords)
    exclude_phrases = [
        "generator",  # equipment
        "filter housing",
        "hose",
        "fitting",
        "pipeline",
        "rehabilitation",
        "inspection",
        "bunker gear",  # firefighter equipment
        "bunker boots",
        "bunkers hill",  # place name
        "testing",
        "color dye",
        "coloring dye",
        "id dyes",
        "audit",
        "sampling bucket",
        "calibration",
        "training",
        "lubricant",
        "lube",
        "construction",
        "tank construction",
        "labour for terminal",
    ]
    if any(p in title_l for p in exclude_phrases):
        # But if CPV is clearly a fuel-supply code, override
        if not has_fuel_cpv:
            return False

    # Strong positive: title mentions supply/delivery/provision of a fuel keyword
    fuel_supply_phrases = [
        "supply of",
        "supply and delivery",
        "delivery of",
        "procurement of fuel",
        "procurement of diesel",
        "procurement of gasoline",
        "procurement of petroleum",
        "procurement of liquid petroleum",
        "procurement of diesel oil",
        "supply, delivery",
        "purchase of",
        "framework: purchase",
    ]
    if any(p in title_l for p in fuel_supply_phrases):
        return True

    # Fallback: trust the CPV
    return has_fuel_cpv


def main():
    all_rows = {}
    for kw in FUEL_KEYWORDS:
        print(f"\n=== Keyword: {kw} ===")
        page = 1
        while True:
            html = fetch_search_page(kw, page)
            rows = parse_search_rows(html)
            total = get_total(html)
            if not rows:
                break
            print(f"  page {page}: {len(rows)} rows (total={total})")
            for r in rows:
                rid = r["resource_id"]
                if rid in all_rows:
                    continue
                r["found_via"] = kw
                all_rows[rid] = r
            # Stop if fewer than 10 rows (last page)
            if len(rows) < 10:
                break
            page += 1
            time.sleep(1)
            if page > 20:  # safety
                break

    print(f"\nTotal unique candidate awards: {len(all_rows)}")

    # Download PDFs and parse awardee
    enriched = []
    for i, (rid, r) in enumerate(all_rows.items(), 1):
        if not r["pdf_url"]:
            continue
        pdf_path = PDF_CACHE / f"{rid}.pdf"
        if not pdf_path.exists():
            try:
                resp = requests.get(r["pdf_url"], headers={"User-Agent": UA}, timeout=60)
                if resp.status_code == 200 and resp.content[:4] == b"%PDF":
                    pdf_path.write_bytes(resp.content)
                else:
                    continue
                time.sleep(0.7)
            except Exception as e:
                print(f"  PDF download failed for {rid}: {e}")
                continue
        details = parse_award_pdf(pdf_path)
        merged = {**r, **details}
        # Drop raw_text from output to keep file small
        merged.pop("raw_text", None)
        enriched.append(merged)
        if i % 10 == 0:
            print(f"  parsed {i}/{len(all_rows)}")

    # Filter
    fuel_supply_only = [a for a in enriched if is_fuel_supply(a)]
    other = [a for a in enriched if not is_fuel_supply(a)]
    print(f"\nFuel supply awards (filtered): {len(fuel_supply_only)}")
    print(f"Excluded (equipment/services):  {len(other)}")

    out_file = OUT / "gojep_fuel_awards.json"
    out_file.write_text(json.dumps(fuel_supply_only, indent=2, default=str))
    print(f"Wrote {out_file}")

    excluded_file = OUT / "gojep_excluded.json"
    excluded_file.write_text(json.dumps(other, indent=2, default=str))
    print(f"Wrote {excluded_file}")


if __name__ == "__main__":
    main()
