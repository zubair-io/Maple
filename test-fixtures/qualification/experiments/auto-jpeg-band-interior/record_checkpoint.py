from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent
summary = json.loads((root / 'full-suite/summary.json').read_text())
assert summary['complete'] and len(summary['cases']) == 20
identity = json.loads((root / 'identity.json').read_text())
assert hashlib.sha256((root / 'maple-cli').read_bytes()).hexdigest() == identity['binary_sha256']
original = {r['fixture']: r for r in json.loads((root.parent / 'auto-embedded-jpeg-source37/summary.json').read_text())['cases']}
assert {c['fixture'] for c in summary['cases']} == set(original)
for case in summary['cases']:
    assert case['raw_sha256'] == original[case['fixture']]['raw_sha256']
    if 'quality' in case:
        assert case['reference_sha256'] == original[case['fixture']]['reference_sha256']
    else:
        assert case['status'] == 'no-preview' and case['fallback']['status'] == 'passed'
key = lambda b: tuple(b.get(k) for k in ['metric', 'band', 'region', 'channel', 'row', 'column'])
comparisons = {}
for baseline in ['auto-jpeg-residual-field', 'auto-jpeg-display-training', 'auto-jpeg-rgb-selection', 'auto-jpeg-rgb-pass-selection', 'auto-jpeg-native-bands']:
    before = {r['fixture']: r for r in json.loads((root.parent / baseline / 'full-suite/summary.json').read_text())['cases']}
    rows = []
    for case in summary['cases']:
        if 'quality' not in case:
            continue
        old = before[case['fixture']]
        old_keys = {key(b) for b in old['quality']['breaches']}
        rows.append({'fixture': case['fixture'], 'status': case['status'],
                     'new_breaches': [b for b in case['quality']['breaches'] if key(b) not in old_keys],
                     'new_native_absolute_breaches': [b for b in case['native_absolute']['breaches'] if key(b) not in {key(x) for x in old['native_absolute']['breaches']}],
                     'new_legacy_bias_breaches': [b for b in case['breaches'] if key(b) not in {key(x) for x in old['breaches']}],
                     'before_metrics': old['quality']['metrics'], 'after_metrics': case['quality']['metrics']})
    comparisons[baseline] = rows
(root / 'matched-subchecks.json').write_text(json.dumps(comparisons, indent=2) + '\n')
report = {'source': identity['source_commit'], 'counts': summary['counts'], 'all_20_raw_hashes_unchanged': True,
          'all_16_reference_hashes_unchanged': True, 'frozen_binary_unchanged': True,
          'exact_fallback_passes': sum(c['status'] == 'no-preview' for c in summary['cases']),
          'new_quality_breaches_vs_clean_ed': {r['fixture']: len(r['new_breaches']) for r in comparisons['auto-jpeg-residual-field'] if r['new_breaches']}}
report['new_native_absolute_breaches_vs_ed'] = {r['fixture']: len(r['new_native_absolute_breaches']) for r in comparisons['auto-jpeg-residual-field'] if r['new_native_absolute_breaches']}
report['new_legacy_bias_breaches_vs_ed'] = {r['fixture']: len(r['new_legacy_bias_breaches']) for r in comparisons['auto-jpeg-residual-field'] if r['new_legacy_bias_breaches']}
(root / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report), flush=True)
lines = ['| Fixture | Result | Mean DE | p95 DE | Failing tile/channel checks |', '|---|---|---:|---:|---:|']
for case in sorted(summary['cases'], key=lambda c: c['fixture']):
    if 'quality' not in case:
        lines.append(f"| {case['fixture']} | Exact Auto=Neutral fallback | — | — | — |")
        continue
    q = case['quality']; m = q['metrics']
    tiles = sum(b['metric'] == 'tile_mean_absolute_channel_error' for b in q['breaches'])
    lines.append(f"| {case['fixture']} | {case['status']} | {m['mean_delta_e_2000']:.3f} | {m['p95_delta_e_2000']:.3f} | {tiles} |")
(root / 'all-fixtures.md').write_text('\n'.join(lines) + '\n')
