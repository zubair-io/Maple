from pathlib import Path
import json
import numpy as np
import colour
from scipy.sparse import csr_matrix, diags
from scipy.sparse.linalg import cg, LinearOperator

root = Path(__file__).resolve().parent

def rows_matrix(rows, key, count):
    values, indices, offsets = [], [], [0]
    for row in rows:
        for index, weight in row[key]:
            values.append(weight)
            indices.append(index)
        offsets.append(len(values))
    return csr_matrix((values, indices, offsets), shape=(len(rows), count))

def subdivision(size, fine):
    values, indices, offsets = [], [], [0]
    for z in range(fine):
        for y in range(fine):
            for x in range(fine):
                p = np.array([x, y, z]) * (size - 1) / (fine - 1)
                lo = np.minimum(np.floor(p).astype(int), size - 2)
                f = p - lo
                axes = np.argsort(-f, kind='stable')
                stride = np.array([1, size, size*size])
                start = int(lo @ stride)
                indices.extend([start, start+int(stride[axes[0]]), start+int(stride[axes[0]]+stride[axes[1]]), start+int(stride.sum())])
                values.extend([1-f[axes[0]], f[axes[0]]-f[axes[1]], f[axes[1]]-f[axes[2]], f[axes[2]]])
                offsets.append(len(values))
    return csr_matrix((values, indices, offsets), shape=(fine**3, size**3))

reports = []
lab = lambda rgb: colour.XYZ_to_Lab(colour.sRGB_to_XYZ(rgb))
for name in ['test_0005']:
    data = json.loads((root.parent/'auto-jpeg-gain-ceilings'/('diagnostic_'+name.removeprefix('test_'))/'diagnostic/auto_fit_observations.json').read_text())
    rows = data['native']
    fine_size = data['prior_size']
    prior = np.array(data['prior']).reshape(-1, 3)
    fine = rows_matrix(rows, 'artifact_weights', fine_size**3)
    display_rows = data['display'] or rows
    display_fine = rows_matrix(display_rows, 'artifact_weights', fine_size**3)
    train = np.array([not row['validation'] for row in rows])
    target = np.array([row['target'] for row in rows])
    display_target = np.array([row['target'] for row in display_rows])
    baseline = fine @ prior
    display_base = display_fine @ prior
    for size in [9]:
        p = subdivision(size, fine_size)
        x = (display_fine @ p).tocsr()
        training = np.array([not row["validation"] for row in display_rows])
        xt = x[training].T.tocsr()
        a = x[training].tocsr()
        count = int(training.sum())
        ei, ej = [], []
        for i in range(size**3):
            coords = [i%size, i//size%size, i//(size*size)]
            for axis, stride in enumerate([1, size, size*size]):
                if coords[axis]+1 < size:
                    ei.append(i)
                    ej.append(i+stride)
        edge_index = np.arange(len(ei))
        edges = csr_matrix((np.r_[np.ones(len(ei)), -np.ones(len(ei))], (np.r_[edge_index, edge_index], np.r_[ei, ej])), shape=(len(ei), size**3))
        regularizer = (edges.T @ edges) * 1e-5 + diags(np.full(size**3, 1e-8))
        diagonal = np.asarray(a.power(2).sum(axis=0)).ravel()/count + regularizer.diagonal()
        operator = LinearOperator((size**3, size**3), matvec=lambda v: xt@(a@v)/count+regularizer@v)
        preconditioner = LinearOperator(operator.shape, matvec=lambda v:v/diagonal)
        rhs = xt @ (display_target[training]-display_base[training])/count
        solved = [cg(operator, rhs[:,c], M=preconditioner, rtol=1e-7, maxiter=512) for c in range(3)]
        delta = np.column_stack([v[0] for v in solved])
        artifact = np.clip(prior + p@delta, 0, 1)
        report = {'fixture':name, 'grid':size, 'qualification':'display-trained cached operator diagnostic after node bounds, before monotonic projection; NOT a physical pass', 'cg_status':[v[1] for v in solved]}
        for scale, y, base, predicted, selected_rows, mask in [('native',target,baseline,fine@artifact,rows,~train), ('display',display_target,display_base,display_fine@artifact,display_rows,np.ones(len(display_rows),dtype=bool))]:
            reference_lab = lab(y)
            before = colour.delta_E(lab(base),reference_lab,method='CIE 2000')
            after = colour.delta_E(lab(predicted),reference_lab,method='CIE 2000')
            stats = {'mean_de':[float(before[mask].mean()),float(after[mask].mean())], 'p95_de':[float(np.percentile(before[mask],95)),float(np.percentile(after[mask],95))], 'mae_rgb':[np.abs(base[mask]-y[mask]).mean(axis=0).tolist(),np.abs(predicted[mask]-y[mask]).mean(axis=0).tolist()]}
            if scale == 'display':
                regions=np.array([r['region'] for r in selected_rows])
                stats['regional_de_increases']=[float((after-before)[regions==i].mean()) for i in range(64)]
            report[scale]=stats
        reports.append(report)
        print(json.dumps(report),flush=True)
(root/'display-training-probe.json').write_text(json.dumps(reports,indent=2)+'\n')
