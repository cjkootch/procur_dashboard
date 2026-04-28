"""
DR fuel award extractor v2 — only attribute fuel awards to suppliers
who actually won fuel-line-items in the award.
"""
import gzip
import json
import re
from pathlib import Path
from collections import Counter

OUT = Path("/home/claude/caribbean_fuel")
DATA_FILES = ["dr_2021.jsonl.gz", "dr_2022.jsonl.gz", "dr_2023.jsonl.gz", "dr_2024.jsonl.gz", "dr_2025.jsonl.gz"]

# UNSPSC fuel-supply codes (high precision)
FUEL_UNSPSC_CODES = {
    "15101502", "15101503", "15101504", "15101505", "15101506",
    "15101508", "15101509", "15101510", "15101512", "15101514",
    "15101516", "15101517",
    "15101701", "15101702",
}

def get_buyer(record):
    """Extract buyer name from OCDS record."""
    # Direct buyer field
    buyer = record.get("buyer") or {}
    name = buyer.get("name")
    if name:
        return name, buyer.get("id")
    # Walk parties[] looking for role 'buyer'
    for party in record.get("parties") or []:
        roles = party.get("roles") or []
        if "buyer" in roles or "procuringEntity" in roles:
            return party.get("name"), party.get("id")
    return None, None


def fuel_unspsc_in_items(items):
    """Return list of fuel UNSPSC codes found in items."""
    out = []
    for it in items or []:
        cl = it.get("classification") or {}
        cid = str(cl.get("id", ""))
        if cl.get("scheme") == "UNSPSC" and cid in FUEL_UNSPSC_CODES:
            out.append(cid)
    return out


def main():
    fuel_award_records = []  # one row per (award, supplier) pair

    for fname in DATA_FILES:
        path = OUT / fname
        if not path.exists():
            continue
        print(f"\n=== {fname} ===")
        n_total = n_with_fuel = n_award_rows = 0
        with gzip.open(path, "rt", encoding="utf-8") as f:
            for line in f:
                n_total += 1
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # First check: does this contracting process touch fuel at the tender level?
                tender = rec.get("tender") or {}
                tender_fuel_codes = fuel_unspsc_in_items(tender.get("items"))
                awards = rec.get("awards") or []

                # Per-award fuel check
                fuel_awards_in_record = []
                for a in awards:
                    award_fuel_codes = fuel_unspsc_in_items(a.get("items"))
                    # An award counts as fuel if either:
                    #  (a) its items contain a fuel UNSPSC code, OR
                    #  (b) the award has no items but the tender is purely fuel
                    if award_fuel_codes:
                        fuel_awards_in_record.append((a, award_fuel_codes))
                    elif not a.get("items") and tender_fuel_codes:
                        # Award with no item detail — only count if tender is *predominantly* fuel
                        all_codes = [str((i.get("classification") or {}).get("id", "")) for i in tender.get("items") or []]
                        fuel_count = sum(1 for c in all_codes if c in FUEL_UNSPSC_CODES)
                        if fuel_count and fuel_count >= len(all_codes) / 2:
                            fuel_awards_in_record.append((a, tender_fuel_codes))

                if not fuel_awards_in_record:
                    continue
                n_with_fuel += 1

                buyer_name, buyer_id = get_buyer(rec)

                # Pull tender + contract data once
                tender_value = (tender.get("value") or {}).get("amount")
                tender_currency = (tender.get("value") or {}).get("currency", "DOP")
                tender_title = tender.get("title")
                tender_id = tender.get("id")

                contracts = rec.get("contracts") or []
                # Build map award_id → contract for value lookup
                contract_by_award = {}
                for c in contracts:
                    awid = c.get("awardID")
                    if awid:
                        contract_by_award[awid] = c

                for award, fuel_codes in fuel_awards_in_record:
                    award_value = (award.get("value") or {}).get("amount")
                    award_currency = (award.get("value") or {}).get("currency", "DOP")

                    # Fall back to contract value if award has none
                    if award_value is None:
                        c = contract_by_award.get(award.get("id"))
                        if c:
                            cv = (c.get("value") or {}).get("amount")
                            cc = (c.get("value") or {}).get("currency")
                            if cv is not None:
                                award_value = cv
                                award_currency = cc or award_currency

                    # Sum item values as another fallback
                    if award_value is None and award.get("items"):
                        try:
                            award_value = sum(
                                float((it.get("unit") or {}).get("value", {}).get("amount", 0) or 0)
                                * float(it.get("quantity") or 0)
                                for it in award["items"]
                            ) or None
                            if award_value:
                                award_currency = ((award["items"][0].get("unit") or {}).get("value") or {}).get("currency", "DOP")
                        except Exception:
                            pass

                    for sup in award.get("suppliers") or []:
                        n_award_rows += 1
                        fuel_award_records.append({
                            "ocid": rec.get("ocid"),
                            "tender_id": tender_id,
                            "tender_title": tender_title,
                            "buyer": buyer_name or "UNKNOWN",
                            "buyer_id": buyer_id,
                            "award_id": award.get("id"),
                            "award_date": award.get("date"),
                            "award_status": award.get("status"),
                            "supplier_name": (sup.get("name") or "").strip().rstrip("\t"),
                            "supplier_id": sup.get("id"),
                            "value_native": award_value,
                            "value_currency": award_currency,
                            "fuel_unspsc_codes": fuel_codes,
                        })

        print(f"  scanned={n_total}, processes_with_fuel={n_with_fuel}, fuel_award_rows={n_award_rows}")

    print(f"\nTotal fuel award rows: {len(fuel_award_records):,}")
    print(f"Unique suppliers: {len({r['supplier_name'] for r in fuel_award_records}):,}")
    print(f"Awards with value: {sum(1 for r in fuel_award_records if r['value_native']):,}")

    out_file = OUT / "dr_fuel_awards_v2.json"
    out_file.write_text(json.dumps(fuel_award_records, indent=2, ensure_ascii=False, default=str))
    print(f"Wrote {out_file}")

    # Top suppliers
    sup_counter = Counter(r["supplier_name"] for r in fuel_award_records if r["supplier_name"])
    print("\n=== Top 30 fuel suppliers ===")
    for name, count in sup_counter.most_common(30):
        print(f"  {count:4d}× {name}")


if __name__ == "__main__":
    main()
