from pathlib import Path
import json
import numpy as np
import colour
from scipy.sparse import csr_matrix, eye
from scipy.sparse.linalg import spsolve

root = Path(__file__).resolve().parent

def matrix(rows, cells):
    values, indices, offsets = [], [], [0]
    for row in rows:
        for index, weight in row['weights']:
            indices.append(index)
            values.append(weight)
        offsets.append(len(values))
    return csr_matrix((values, indices, offsets), shape=(len(rows), cells))

reports = []
for name, folder in [(name, root / name) for name in ['test_0015', 'test_0017']]:
    data = json.loads((folder / 'diagnostic/auto_fit_observations.json').read_text())
    grid = data['grid']
    cells = grid**3
    native = data['native']
    x = matrix(native, cells)
    train = np.array([not row['validation'] for row in native])
    baseline = np.array([row['baseline'] for row in native])
    target = np.array([row['target'] for row in native])
    a = (x[train].T @ x[train]) / train.sum() + eye(cells) * 1e-8
    edges = []
    for index in range(cells):
        coords = [index % grid, index // grid % grid, index // grid**2]
        for axis, step in enumerate([1, grid, grid**2]):
            if coords[axis] + 1 < grid:
                edges.append((index, index + step))
    lap = np.zeros((cells, cells))
    for i, j in edges:
        lap[i, i] += 1e-5
        lap[j, j] += 1e-5
        lap[i, j] -= 1e-5
        lap[j, i] -= 1e-5
    a = a + csr_matrix(lap)
    rhs = x[train].T @ (target[train] - baseline[train]) / train.sum()
    delta = spsolve(a.tocsc(), rhs)
    result = {'fixture': name, 'qualification': 'UNPROJECTED DIAGNOSTIC; not a physical render or pass'}
    lab = lambda rgb: colour.XYZ_to_Lab(colour.sRGB_to_XYZ(rgb))
    for scale, rows in [('native', native), ('display', data['display'] or native)]:
        base = np.array([row['baseline'] for row in rows])
        tgt = np.array([row['target'] for row in rows])
        prediction = base + matrix(rows, cells) @ delta
        mask = np.array([row['validation'] for row in rows]) if scale == 'native' else np.ones(len(rows), dtype=bool)
        ref_lab = lab(tgt)
        de_base = colour.delta_E(lab(base), ref_lab, method='CIE 2000')
        de_new = colour.delta_E(lab(prediction), ref_lab, method='CIE 2000')
        stats = {'mean_de': [float(de_base[mask].mean()), float(de_new[mask].mean())], 'p95_de': [float(np.percentile(de_base[mask], 95)), float(np.percentile(de_new[mask], 95))], 'mae_rgb': [np.abs(base[mask]-tgt[mask]).mean(axis=0).tolist(), np.abs(prediction[mask]-tgt[mask]).mean(axis=0).tolist()], 'mse_rgb': [((base[mask]-tgt[mask])**2).mean(axis=0).tolist(), ((prediction[mask]-tgt[mask])**2).mean(axis=0).tolist()], 'outside_unit_fraction': float(((prediction < 0) | (prediction > 1)).mean())}
        if scale == 'display':
            regions = np.array([row['region'] for row in rows])
            stats['regional_de_increases'] = [float((de_new-de_base)[regions == index].mean()) for index in range(64)]
        result[scale] = stats
    reports.append(result)
    print(json.dumps(result), flush=True)
(root / 'difficult-cases-residual-probe.json').write_text(json.dumps(reports, indent=2)+'\n')
